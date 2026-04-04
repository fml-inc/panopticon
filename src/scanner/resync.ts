/**
 * Atomic DB resync: builds a fresh database from scratch, copies
 * non-scanner metadata from the old DB, then swaps files atomically.
 *
 * This avoids the cost of row-by-row deletes on large databases and
 * ensures that parser changes (tracked via SCANNER_DATA_VERSION) are
 * applied cleanly to all existing session data.
 */
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { config } from "../config.js";
import {
  closeDb,
  getDb,
  SCANNER_DATA_VERSION,
  SCHEMA_SQL,
} from "../db/schema.js";
import { scanOnce } from "./loop.js";

/**
 * Tables whose data is independent of the scanner and must be
 * preserved across resync. Copied row-by-row from old → new DB.
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

export interface ResyncResult {
  success: boolean;
  filesScanned: number;
  newTurns: number;
  error?: string;
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

function initTempDb(tempPath: string): Database.Database {
  const db = new Database(tempPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.function("decompress", (blob: Buffer | null) =>
    blob ? gunzipSync(blob).toString() : null,
  );
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Perform an atomic resync:
 * 1. Close current DB
 * 2. Create a fresh temp DB with current schema
 * 3. Redirect config.dbPath → temp, run full scan into it
 * 4. Copy preserved (non-scanner) data from old DB via ATTACH
 * 5. Merge session metadata from hooks/OTLP
 * 6. Atomic file swap (rename)
 * 7. Reopen the main DB handle
 */
export function resyncAll(log: (msg: string) => void = () => {}): ResyncResult {
  const origPath = config.dbPath;
  const tempPath = `${origPath}-resync`;

  // Clean up stale temp DB from a prior crash
  removeTempFiles(tempPath);

  log("Starting atomic resync...");

  // 1. Create fresh temp DB and verify schema
  let tempDb: Database.Database;
  try {
    tempDb = initTempDb(tempPath);
    tempDb.close();
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
  try {
    const result = scanOnce();
    filesScanned = result.filesScanned;
    newTurns = result.newTurns;
  } catch (err) {
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
    log(
      `Resync aborted: temp DB has 0 sessions but old DB has ${oldSessionCount}`,
    );
    getDb(); // reopen original
    removeTempFiles(tempPath);
    return {
      success: false,
      filesScanned,
      newTurns,
      error: `Aborted: 0 sessions in resync vs ${oldSessionCount} in old DB`,
    };
  }

  // 3. Copy preserved data from old DB into temp DB
  log("Copying preserved data from old database...");
  try {
    tempDb = new Database(tempPath);
    tempDb.pragma("journal_mode = WAL");
    tempDb.function("decompress", (blob: Buffer | null) =>
      blob ? gunzipSync(blob).toString() : null,
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
    });
    tx();

    tempDb.exec("DETACH DATABASE old_db");
    tempDb.pragma(`user_version = ${SCANNER_DATA_VERSION}`);
    tempDb.close();
  } catch (err) {
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
  log("Swapping database files...");
  try {
    removeWAL(origPath);
    fs.renameSync(tempPath, origPath);
    removeWAL(tempPath);
  } catch (err) {
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
    `Resync complete: ${filesScanned} files, ${newTurns} turns, ${tempSessionCount} sessions`,
  );

  return { success: true, filesScanned, newTurns };
}
