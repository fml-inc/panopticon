/**
 * Atomic DB reparse: builds a fresh database from scratch, copies
 * non-scanner metadata from the old DB, then swaps files atomically.
 *
 * This avoids the cost of row-by-row deletes on large databases and ensures
 * that parser changes (tracked via SCANNER_DATA_VERSION) are applied cleanly
 * to all existing session data. Scanner-produced rows now compute deterministic
 * sync_id values during ingestion, so the rebuild only needs to preserve
 * non-scanner metadata from the old database.
 */
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import { rebuildActiveClaims } from "../claims/canonicalize.js";
import { config } from "../config.js";
import { Database } from "../db/driver.js";
import {
  closeDb,
  getDb,
  markAllDataRebuildsComplete,
  runMigrations,
  SCHEMA_SQL,
} from "../db/schema.js";
import { rebuildIntentClaimsFromHooks } from "../intent/asserters/from_hooks.js";
import { reconcileLandedClaimsFromDisk } from "../intent/asserters/landed_from_disk.js";
import { rebuildIntentProjection } from "../intent/project.js";
import { scanOnce } from "./loop.js";
import {
  clearScannerStatus,
  type ScannerRuntimePhase,
  writeScannerStatus,
} from "./status.js";

/**
 * Tables whose data is independent of the scanner and must be
 * preserved across reparse. Copied row-by-row from old → new DB.
 */
const PRESERVED_TABLES = [
  "hook_events",
  "otel_logs",
  "otel_metrics",
  "otel_spans",
  "watermarks",
  "target_session_sync",
  "model_pricing",
  "user_config_snapshots",
  "repo_config_snapshots",
];

/**
 * Session columns that come from non-scanner sources (hooks, OTLP)
 * and should be merged back after the scanner rebuilds sessions.
 */
const SESSION_MERGE_COLUMNS = [
  "has_hooks",
  "has_otel",
  "otel_input_tokens",
  "otel_output_tokens",
  "otel_cache_read_tokens",
  "otel_cache_creation_tokens",
  "summary",
  "summary_version",
  "permission_mode",
  "is_automated",
  "created_at",
];

export interface ReparseResult {
  success: boolean;
  filesScanned: number;
  newTurns: number;
  error?: string;
}

export interface ReparseDerivedStateResult {
  hookPrompts: number;
  hookEdits: number;
  activeHeadsAfterClaims: number;
  landedChecked: number;
  activeHeadsAfterLanded: number;
  projectedIntents: number;
  projectedEdits: number;
  projectedSessionSummaries: number;
  projectedMemberships: number;
  projectedProvenance: number;
  totalMs: number;
}

export interface RewoundTargetSessionSyncState {
  rewoundRows: number;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function formatPercent(value: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function writeReparseStatus(
  phase: ScannerRuntimePhase,
  message: string,
  startedAtMs: number,
  progress: Partial<{
    elapsedMs: number;
    processedFiles: number;
    discoveredFiles: number;
    filesScanned: number;
    newTurns: number;
    touchedSessions: number;
    currentSource: string;
    processedSessions: number;
    totalSessions: number;
    currentSessionId: string;
  }> = {},
): void {
  writeScannerStatus({
    pid: process.pid,
    phase,
    message,
    startedAtMs,
    elapsedMs: progress.elapsedMs ?? Date.now() - startedAtMs,
    processedFiles: progress.processedFiles,
    discoveredFiles: progress.discoveredFiles,
    filesScanned: progress.filesScanned,
    newTurns: progress.newTurns,
    touchedSessions: progress.touchedSessions,
    currentSource: progress.currentSource,
    processedSessions: progress.processedSessions,
    totalSessions: progress.totalSessions,
    currentSessionId: progress.currentSessionId,
  });
}

function removeTempFiles(tempPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(tempPath + suffix);
    } catch {}
  }
}

function removeWAL(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {}
  }
}

function initTempDb(tempPath: string): Database {
  const db = new Database(tempPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.function("decompress", (blob: unknown) =>
    blob ? gunzipSync(blob as Uint8Array).toString() : null,
  );
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

/**
 * Atomic reparse rebuilds scanner-owned rows in a fresh database, so the
 * copied per-session watermarks from the previous DB can point past the new
 * local row IDs. Rewind only the scanner-owned sync state while preserving
 * hook/OTel progress for mixed sessions.
 *
 * The rewind sets target_session_sync to a "session must be re-confirmed, then
 * dependent scanner data must be drained again" state:
 * - session sync will rerun because sessions.sync_seq will now be greater than
 *   target_session_sync.sync_seq
 * - dependent scanner tables will rerun after confirmation because synced_seq
 *   still lags behind the refreshed sync_seq
 */
export function rewindTargetSessionSyncForScannerReparse(
  db: Database,
): RewoundTargetSessionSyncState {
  const result = db
    .prepare(
      `UPDATE target_session_sync
       SET sync_seq = (
             SELECT COALESCE(s.sync_seq, 0) - 1
             FROM sessions s
             WHERE s.session_id = target_session_sync.session_id
           ),
           synced_seq = (
             SELECT COALESCE(s.sync_seq, 0) - 1
             FROM sessions s
             WHERE s.session_id = target_session_sync.session_id
           ),
           wm_messages = 0,
           wm_tool_calls = 0,
           wm_scanner_turns = 0,
           wm_scanner_events = 0
       WHERE EXISTS (
         SELECT 1
         FROM sessions s
         WHERE s.session_id = target_session_sync.session_id
           AND COALESCE(s.has_scanner, 0) = 1
       )`,
    )
    .run();

  return { rewoundRows: result.changes };
}

export function rebuildDerivedStateFromRaw(
  log: (msg: string) => void = () => {},
): ReparseDerivedStateResult {
  const startedAt = performance.now();
  log("Derived-state rebuild: rebuilding hook intent claims...");
  let phaseStartedAt = performance.now();
  const hooks = rebuildIntentClaimsFromHooks();
  log(
    `Derived-state phase hook-claims: ${formatMs(performance.now() - phaseStartedAt)} (prompts=${hooks.prompts} edits=${hooks.edits})`,
  );

  log(
    "Derived-state rebuild: canonicalizing active claims after raw claim rebuild...",
  );
  phaseStartedAt = performance.now();
  const activeHeadsAfterClaims = rebuildActiveClaims();
  log(
    `Derived-state phase canonicalize-claims: ${formatMs(performance.now() - phaseStartedAt)} (active_heads=${activeHeadsAfterClaims})`,
  );

  log("Derived-state rebuild: reconciling landed edits from disk...");
  phaseStartedAt = performance.now();
  const landed = reconcileLandedClaimsFromDisk();
  log(
    `Derived-state phase landed-reconciliation: ${formatMs(performance.now() - phaseStartedAt)} (checked=${landed.checked})`,
  );

  log(
    "Derived-state rebuild: canonicalizing active claims after landed reconciliation...",
  );
  phaseStartedAt = performance.now();
  const activeHeadsAfterLanded = rebuildActiveClaims();
  log(
    `Derived-state phase canonicalize-landed: ${formatMs(performance.now() - phaseStartedAt)} (active_heads=${activeHeadsAfterLanded})`,
  );

  log("Derived-state rebuild: rebuilding intent projection...");
  phaseStartedAt = performance.now();
  const projection = rebuildIntentProjection();
  log(
    `Derived-state phase intent-projection: ${formatMs(performance.now() - phaseStartedAt)} (intents=${projection.intents} edits=${projection.edits} summaries=${projection.sessionSummaries})`,
  );
  const totalMs = performance.now() - startedAt;

  log(
    `Derived-state rebuild finished in ${formatMs(totalMs)} (hook_prompts=${hooks.prompts} hook_edits=${hooks.edits} active_heads_claims=${activeHeadsAfterClaims} landed_checked=${landed.checked} active_heads_landed=${activeHeadsAfterLanded} projected_intents=${projection.intents} projected_edits=${projection.edits} projected_summaries=${projection.sessionSummaries})`,
  );

  return {
    hookPrompts: hooks.prompts,
    hookEdits: hooks.edits,
    activeHeadsAfterClaims,
    landedChecked: landed.checked,
    activeHeadsAfterLanded,
    projectedIntents: projection.intents,
    projectedEdits: projection.edits,
    projectedSessionSummaries: projection.sessionSummaries,
    projectedMemberships: projection.memberships,
    projectedProvenance: projection.provenance,
    totalMs,
  };
}

/**
 * Perform an atomic reparse:
 * 1. Close current DB
 * 2. Create a fresh temp DB with current schema
 * 3. Redirect config.dbPath → temp, run full scan into it
 * 4. Copy preserved (non-scanner) data from old DB via ATTACH
 * 5. Merge session metadata from hooks/OTLP and rewind scanner sync state
 * 6. Atomic file swap (rename)
 * 7. Reopen the main DB handle
 */
export function reparseAll(
  log: (msg: string) => void = () => {},
): ReparseResult {
  const startedAt = performance.now();
  const statusStartedAtMs = Date.now();
  const origPath = config.dbPath;
  const tempPath = `${origPath}-reparse`;

  // Clean up stale temp DB from a prior crash
  removeTempFiles(tempPath);

  writeReparseStatus(
    "reparse_init",
    "Starting atomic reparse...",
    statusStartedAtMs,
  );
  log("Starting atomic reparse...");

  // 1. Create fresh temp DB and verify schema
  let tempDb: Database;
  let initTempDbMs = 0;
  try {
    const initStartedAt = performance.now();
    tempDb = initTempDb(tempPath);
    tempDb.close();
    initTempDbMs = performance.now() - initStartedAt;
    log(`Temp DB initialized in ${formatMs(initTempDbMs)}`);
  } catch (err) {
    removeTempFiles(tempPath);
    return {
      success: false,
      filesScanned: 0,
      newTurns: 0,
      error: `Failed to create temp DB: ${err}`,
    };
  }

  // Snapshot old session count for safety check
  let oldSessionCount = 0;
  try {
    const oldDb = new Database(origPath);
    oldSessionCount = (
      oldDb.prepare("SELECT COUNT(*) as c FROM sessions").get() as {
        c: number;
      }
    ).c;
    oldDb.close();
  } catch {}

  // 2. Close current DB, redirect to temp, scan
  closeDb();
  const savedDbPath = config.dbPath;
  (config as { dbPath: string }).dbPath = tempPath;

  let filesScanned = 0;
  let newTurns = 0;
  let scanMs = 0;
  try {
    writeReparseStatus(
      "reparse_scan",
      "Scanning raw session files into temp DB...",
      statusStartedAtMs,
    );
    log("Scanning raw session files into temp DB...");
    const scanStartedAt = performance.now();
    const result = scanOnce({
      profileLabel: "reparse scan",
      logDetails: true,
      progressEveryMs: 15_000,
      onProgress: (progress) => {
        if (progress.phase === "sessions") {
          log(
            `Reparse session processing progress: processed=${progress.processedSessions ?? 0}/${progress.totalSessions ?? 0} touched_sessions=${progress.touchedSessions} elapsed=${formatMs(progress.elapsedMs)}${progress.currentSessionId ? ` session=${progress.currentSessionId}` : ""}`,
          );
          writeReparseStatus(
            "reparse_process",
            "Processing touched sessions from temp DB scan...",
            statusStartedAtMs,
            progress,
          );
          return;
        }

        log(
          `Reparse scan progress: processed=${progress.processedFiles}/${progress.discoveredFiles} (${formatPercent(progress.processedFiles, progress.discoveredFiles)}) files_scanned=${progress.filesScanned} turns=${progress.newTurns} touched_sessions=${progress.touchedSessions} elapsed=${formatMs(progress.elapsedMs)}${progress.currentSource ? ` source=${progress.currentSource}` : ""}`,
        );
        writeReparseStatus(
          "reparse_scan",
          "Scanning raw session files into temp DB...",
          statusStartedAtMs,
          progress,
        );
      },
    });
    scanMs = performance.now() - scanStartedAt;
    filesScanned = result.filesScanned;
    newTurns = result.newTurns;
    log(
      `Temp DB scan finished in ${formatMs(scanMs)} (${filesScanned} files, ${newTurns} turns, ${result.touchedSessions.length} touched sessions)`,
    );
  } catch (err) {
    writeReparseStatus(
      "reparse_error",
      `Reparse scan failed: ${err}`,
      statusStartedAtMs,
    );
    clearScannerStatus();
    (config as { dbPath: string }).dbPath = savedDbPath;
    closeDb();
    getDb(); // reopen original
    removeTempFiles(tempPath);
    return {
      success: false,
      filesScanned: 0,
      newTurns: 0,
      error: `Scan into temp DB failed: ${err}`,
    };
  }

  // Check session count in temp DB
  const db = getDb();
  const tempSessionCount = (
    db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }
  ).c;
  closeDb();

  // Restore config path for all subsequent operations
  (config as { dbPath: string }).dbPath = savedDbPath;

  // Abort if scan produced nothing but old DB had data
  if (tempSessionCount === 0 && oldSessionCount > 0) {
    writeReparseStatus(
      "reparse_error",
      `Reparse aborted: 0 sessions in reparse vs ${oldSessionCount} in old DB`,
      statusStartedAtMs,
    );
    clearScannerStatus();
    log(
      `Reparse aborted: temp DB has 0 sessions but old DB has ${oldSessionCount}`,
    );
    getDb(); // reopen original
    removeTempFiles(tempPath);
    return {
      success: false,
      filesScanned,
      newTurns,
      error: `Aborted: 0 sessions in reparse vs ${oldSessionCount} in old DB`,
    };
  }

  // 3. Copy preserved data from old DB into temp DB
  writeReparseStatus(
    "reparse_copy",
    "Copying preserved data from old database...",
    statusStartedAtMs,
  );
  log("Copying preserved data from old database...");
  let copyMs = 0;
  let deriveMs = 0;
  try {
    const copyStartedAt = performance.now();
    tempDb = new Database(tempPath);
    tempDb.pragma("journal_mode = WAL");
    tempDb.function("decompress", (blob: unknown) =>
      blob ? gunzipSync(blob as Uint8Array).toString() : null,
    );
    const escapedPath = origPath.replace(/'/g, "''");
    tempDb.exec(`ATTACH DATABASE '${escapedPath}' AS old_db`);

    const tx = tempDb.transaction(() => {
      for (const table of PRESERVED_TABLES) {
        try {
          tempDb.exec(
            `INSERT OR IGNORE INTO main.${table} SELECT * FROM old_db.${table}`,
          );
        } catch (e) {
          log(`  Skipping ${table}: ${e instanceof Error ? e.message : e}`);
        }
      }

      // Rebuild hook_events_fts from copied hook_events
      try {
        tempDb.exec(
          "INSERT INTO main.hook_events_fts(rowid, payload) SELECT id, decompress(payload) FROM main.hook_events",
        );
      } catch (e) {
        log(`  hook_events_fts rebuild: ${e instanceof Error ? e.message : e}`);
      }

      // Merge session metadata from hooks/OTLP into scanner-created sessions
      const setClauses = SESSION_MERGE_COLUMNS.map(
        (col) => `${col} = old_db.sessions.${col}`,
      ).join(", ");
      try {
        tempDb.exec(`
          UPDATE main.sessions SET ${setClauses}
          FROM old_db.sessions
          WHERE main.sessions.session_id = old_db.sessions.session_id
        `);
      } catch (e) {
        log(`  Session merge: ${e instanceof Error ? e.message : e}`);
      }

      // Copy session_repositories and session_cwds
      try {
        tempDb.exec(
          "INSERT OR IGNORE INTO main.session_repositories SELECT * FROM old_db.session_repositories",
        );
      } catch (e) {
        log(`  session_repositories: ${e instanceof Error ? e.message : e}`);
      }
      try {
        tempDb.exec(
          "INSERT OR IGNORE INTO main.session_cwds SELECT * FROM old_db.session_cwds",
        );
      } catch (e) {
        log(`  session_cwds: ${e instanceof Error ? e.message : e}`);
      }

      const rewound = rewindTargetSessionSyncForScannerReparse(tempDb);
      if (rewound.rewoundRows > 0) {
        log(
          `  target_session_sync: rewound scanner watermarks for ${rewound.rewoundRows} session${rewound.rewoundRows === 1 ? "" : "s"}`,
        );
      }
    });
    tx();

    tempDb.exec("DETACH DATABASE old_db");
    tempDb.close();
    copyMs = performance.now() - copyStartedAt;
    log(`Preserved-data copy finished in ${formatMs(copyMs)}`);

    log("Rebuilding derived state from copied raw data...");
    writeReparseStatus(
      "reparse_derive",
      "Rebuilding derived state from raw data...",
      statusStartedAtMs,
    );
    (config as { dbPath: string }).dbPath = tempPath;
    closeDb();
    deriveMs = rebuildDerivedStateFromRaw(log).totalMs;
    markAllDataRebuildsComplete();
    closeDb();
    (config as { dbPath: string }).dbPath = savedDbPath;
  } catch (err) {
    writeReparseStatus(
      "reparse_error",
      `Reparse copy/rebuild failed: ${err}`,
      statusStartedAtMs,
    );
    clearScannerStatus();
    (config as { dbPath: string }).dbPath = savedDbPath;
    closeDb();
    log(`Failed to copy preserved data: ${err}`);
    getDb(); // reopen original
    removeTempFiles(tempPath);
    return {
      success: false,
      filesScanned,
      newTurns,
      error: `Copy preserved data failed: ${err}`,
    };
  }

  // 4. Atomic file swap
  writeReparseStatus(
    "reparse_finalize",
    "Swapping rebuilt database into place...",
    statusStartedAtMs,
  );
  log("Swapping database files...");
  let swapMs = 0;
  try {
    const swapStartedAt = performance.now();
    removeWAL(origPath);
    fs.renameSync(tempPath, origPath);
    removeWAL(tempPath);
    swapMs = performance.now() - swapStartedAt;
    log(`Database swap finished in ${formatMs(swapMs)}`);
  } catch (err) {
    writeReparseStatus(
      "reparse_error",
      `Reparse swap failed: ${err}`,
      statusStartedAtMs,
    );
    clearScannerStatus();
    log(`File swap failed: ${err}`);
    getDb();
    removeTempFiles(tempPath);
    return {
      success: false,
      filesScanned,
      newTurns,
      error: `Atomic swap failed: ${err}`,
    };
  }

  // 5. Reopen the main DB handle
  getDb();

  log(
    `Reparse complete: ${filesScanned} files, ${newTurns} turns, ${tempSessionCount} sessions in ${formatMs(performance.now() - startedAt)} (init=${formatMs(initTempDbMs)} scan=${formatMs(scanMs)} copy=${formatMs(copyMs)} derive=${formatMs(deriveMs)} swap=${formatMs(swapMs)})`,
  );
  clearScannerStatus();

  return { success: true, filesScanned, newTurns };
}
