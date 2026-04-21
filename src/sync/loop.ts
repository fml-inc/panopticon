declare const __PANOPTICON_VERSION__: string;

import { execSync } from "node:child_process";
import { getDb } from "../db/schema.js";
import { log } from "../log.js";
import { captureException } from "../sentry.js";
import { postSync } from "./post.js";
import { readSessionsByIds, SESSION_READERS } from "./reader.js";
import {
  DEFAULT_NON_SESSION_TABLES,
  DEFAULT_SESSION_TABLES,
  TABLE_SYNC_REGISTRY,
} from "./registry.js";
import type {
  SyncFilter,
  SyncHandle,
  SyncOptions,
  SyncTarget,
} from "./types.js";
import { readWatermark, watermarkKey, writeWatermark } from "./watermark.js";

const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_POST_BATCH_SIZE = 100;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_CATCHUP_MS = 100;
const DEFAULT_MAX_SESSIONS_PER_TICK = 10;

/** Maps SESSION_READERS table name → target_session_sync column name. */
const WM_COLUMNS = {
  messages: "wm_messages",
  tool_calls: "wm_tool_calls",
  scanner_turns: "wm_scanner_turns",
  scanner_events: "wm_scanner_events",
  hook_events: "wm_hook_events",
  otel_logs: "wm_otel_logs",
  otel_metrics: "wm_otel_metrics",
  otel_spans: "wm_otel_spans",
} as const;

type SessionTableName = keyof typeof WM_COLUMNS;

type PendingSessionRow = {
  session_id: string;
  sync_seq: number;
  synced_seq: number;
} & Record<(typeof WM_COLUMNS)[SessionTableName], number>;

function isSessionTableName(table: string): table is SessionTableName {
  return table in WM_COLUMNS && table in SESSION_READERS;
}

function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === "*/*") return true;
  if (pattern.endsWith("/*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

/** Returns true if the repository passes the include/exclude filter. */
function repoMatchesFilter(repository: string, filter?: SyncFilter): boolean {
  if (!filter) return true;
  if (filter.excludeRepos?.some((p) => matchesGlob(repository, p)))
    return false;
  if (filter.includeRepos?.length) {
    if (!filter.includeRepos.some((p) => matchesGlob(repository, p)))
      return false;
  }
  return true;
}

/** Set of session IDs that have repo attribution matching the filter. */
function buildSyncableSessionIds(opts: SyncOptions): Set<string> | null {
  const requireRepo = opts.filter?.requireRepo ?? true;
  if (!requireRepo && !opts.filter?.includeRepos?.length) return null; // no filtering

  const db = getDb();
  const rows = db
    .prepare(
      "SELECT DISTINCT sr.session_id, sr.repository FROM session_repositories sr",
    )
    .all() as Array<{ session_id: string; repository: string }>;

  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (!repoMatchesFilter(row.repository, opts.filter)) continue;
    sessionIds.add(row.session_id);
  }

  return sessionIds;
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function resolveToken(target: SyncTarget): string | undefined {
  if (target.token) return target.token;
  if (!target.tokenCommand) return undefined;

  const cached = tokenCache.get(target.name);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  try {
    const token = execSync(target.tokenCommand, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) {
      tokenCache.set(target.name, {
        token,
        expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
      });
    }
    return token || undefined;
  } catch (err) {
    log.sync.error(
      `tokenCommand failed for "${target.name}": ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

export function createSyncLoop(opts: SyncOptions): SyncHandle {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const postBatchSize = opts.postBatchSize ?? DEFAULT_POST_BATCH_SIZE;
  const idleMs = opts.idleIntervalMs ?? DEFAULT_IDLE_MS;
  const catchUpMs = opts.catchUpIntervalMs ?? DEFAULT_CATCHUP_MS;
  const maxSessionsPerTick =
    opts.maxSessionsPerTick ?? DEFAULT_MAX_SESSIONS_PER_TICK;
  const sessionRowBudget = Math.max(1, opts.sessionRowBudget ?? batchSize);
  const sessionPendingMode = opts.sessionPendingMode ?? "sync-seq";
  const syncSessionsEnabled = opts.syncSessions ?? true;
  const sessionTables = (
    opts.sessionTables ?? [...DEFAULT_SESSION_TABLES]
  ).filter(isSessionTableName);
  const nonSessionTableSet = new Set(
    opts.nonSessionTables ?? [...DEFAULT_NON_SESSION_TABLES],
  );
  const nonSessionTables = TABLE_SYNC_REGISTRY.filter(
    (desc) => !desc.sessionLinked && nonSessionTableSet.has(desc.table),
  );
  const loopPrefix = opts.loopName ? `${opts.loopName}: ` : "";
  const watermarkGapPredicate = sessionTables
    .map(
      (table) =>
        `EXISTS (
           SELECT 1
           FROM ${table} t
           WHERE t.session_id = target_session_sync.session_id
             AND t.id > target_session_sync.${WM_COLUMNS[table]}
         )`,
    )
    .join(" OR ");

  const panopticonVersion =
    typeof __PANOPTICON_VERSION__ !== "undefined"
      ? __PANOPTICON_VERSION__
      : "dev";

  function resolveHeaders(target: SyncTarget): Record<string, string> {
    const headers: Record<string, string> = { ...target.headers };
    headers["X-Panopticon-Version"] = panopticonVersion;
    const token = resolveToken(target);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;
  let stopping = false;

  function formatLog(message: string): string {
    return `${loopPrefix}${message}`;
  }

  function scheduleNext(hadWork: boolean): void {
    if (stopping) return;
    const delay = hadWork ? catchUpMs : idleMs;
    timer = setTimeout(() => {
      tick().catch((err) => log.sync.error(`Tick error: ${err}`));
    }, delay);
    if (!opts.keepAlive && timer.unref) {
      timer.unref();
    }
  }

  // ── Phase 1: Sync sessions (compared against target_session_sync) ────────

  async function syncSessions(
    target: SyncTarget,
    syncableSessionIds: Set<string> | null,
  ): Promise<boolean> {
    if (!syncSessionsEnabled) return false;

    const db = getDb();
    const requireRepo = opts.filter?.requireRepo ?? true;

    // SQL-level filter to skip sessions with no repository attribution.
    // Without this, a large backlog of no-repo sessions consumes every LIMIT
    // slot in the "new sessions" branch and starves the "updated sessions"
    // branch indefinitely (so per-session watermarks for confirmed sessions
    // can never advance).
    const repoExists = requireRepo
      ? "AND EXISTS (SELECT 1 FROM session_repositories sr WHERE sr.session_id = s.session_id)"
      : "";

    // Find sessions that need syncing: new (no tss entry) or updated
    // (sessions.sync_seq advanced past tss.sync_seq).
    //
    // These run as two independent queries with their own LIMITs (rather than
    // UNION ALL with one shared LIMIT) so neither branch can starve the other.
    const newRows = db
      .prepare(
        `SELECT s.session_id FROM sessions s
         LEFT JOIN target_session_sync tss
           ON s.session_id = tss.session_id AND tss.target = ?
         WHERE tss.session_id IS NULL ${repoExists}
         LIMIT ?`,
      )
      .all(target.name, batchSize) as Array<{ session_id: string }>;

    const updatedRows = db
      .prepare(
        `SELECT s.session_id FROM sessions s
         JOIN target_session_sync tss
           ON s.session_id = tss.session_id AND tss.target = ?
         WHERE tss.confirmed = 1 AND s.sync_seq > tss.sync_seq ${repoExists}
         LIMIT ?`,
      )
      .all(target.name, batchSize) as Array<{ session_id: string }>;

    if (newRows.length === 0 && updatedRows.length === 0) return false;

    // In-memory filter for includeRepos/excludeRepos globs (requireRepo is
    // already enforced in SQL above).
    let sessionIds = [
      ...newRows.map((r) => r.session_id),
      ...updatedRows.map((r) => r.session_id),
    ];
    if (syncableSessionIds) {
      sessionIds = sessionIds.filter((id) => syncableSessionIds.has(id));
    }

    const hasMore =
      newRows.length >= batchSize || updatedRows.length >= batchSize;

    if (sessionIds.length === 0) return hasMore;

    const rows = readSessionsByIds(sessionIds);
    if (rows.length > 0) {
      log.sync.info(formatLog(`sessions: ${rows.length} sessions to sync`));

      for (let j = 0; j < rows.length; j += postBatchSize) {
        const batch = rows.slice(j, j + postBatchSize);
        const response = await postSync(
          `${target.url}/v1/sync`,
          { table: "sessions", rows: batch },
          resolveHeaders(target),
        );

        const accepted = response.accepted;
        if (Array.isArray(accepted)) {
          recordConfirmedSessions(accepted as string[], target.name);
        }
      }
    }

    return hasMore;
  }

  // ── Phase 2: Sync dependent data (per-session, gated by confirmed) ───────

  function readPendingSessions(targetName: string): PendingSessionRow[] {
    if (sessionTables.length === 0) return [];

    const db = getDb();
    const whereClause =
      sessionPendingMode === "watermark-gap"
        ? watermarkGapPredicate
          ? `AND (${watermarkGapPredicate})`
          : "AND 0"
        : "AND sync_seq > synced_seq";

    return db
      .prepare(
        `SELECT session_id, sync_seq, synced_seq,
                wm_messages, wm_tool_calls, wm_scanner_turns,
                wm_scanner_events, wm_hook_events, wm_otel_logs,
                wm_otel_metrics, wm_otel_spans
         FROM target_session_sync
         WHERE target = ? AND confirmed = 1
           ${whereClause}
         ORDER BY rowid
         LIMIT ?`,
      )
      .all(targetName, maxSessionsPerTick) as PendingSessionRow[];
  }

  function hasRemainingPendingSessions(targetName: string): boolean {
    if (sessionTables.length === 0) return false;

    const db = getDb();
    const whereClause =
      sessionPendingMode === "watermark-gap"
        ? watermarkGapPredicate
          ? `AND (${watermarkGapPredicate})`
          : "AND 0"
        : "AND sync_seq > synced_seq";
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt
         FROM target_session_sync
         WHERE target = ? AND confirmed = 1
           ${whereClause}`,
      )
      .get(targetName) as { cnt: number };
    return row.cnt > 0;
  }

  function writeSessionProgress(
    sessionId: string,
    targetName: string,
    watermarks: Record<SessionTableName, number>,
    syncedSeq: number,
  ): void {
    const db = getDb();
    db.prepare(
      `UPDATE target_session_sync
       SET wm_messages = ?, wm_tool_calls = ?, wm_scanner_turns = ?,
           wm_scanner_events = ?, wm_hook_events = ?, wm_otel_logs = ?,
           wm_otel_metrics = ?, wm_otel_spans = ?, synced_seq = ?
       WHERE session_id = ? AND target = ?`,
    ).run(
      watermarks.messages,
      watermarks.tool_calls,
      watermarks.scanner_turns,
      watermarks.scanner_events,
      watermarks.hook_events,
      watermarks.otel_logs,
      watermarks.otel_metrics,
      watermarks.otel_spans,
      syncedSeq,
      sessionId,
      targetName,
    );
  }

  async function syncSessionData(target: SyncTarget): Promise<boolean> {
    const db = getDb();

    if (sessionTables.length === 0) return false;

    // Clean up orphaned entries (session deleted from local DB)
    db.prepare(
      `DELETE FROM target_session_sync
       WHERE session_id NOT IN (SELECT session_id FROM sessions)`,
    ).run();

    const pending = readPendingSessions(target.name);
    if (pending.length === 0) return false;

    const headers = resolveHeaders(target);
    const url = `${target.url}/v1/sync`;

    for (const entry of pending) {
      const wmRow = entry as unknown as Record<string, number>;
      const watermarks = {} as Record<SessionTableName, number>;
      for (const [table, col] of Object.entries(WM_COLUMNS) as Array<
        [SessionTableName, (typeof WM_COLUMNS)[SessionTableName]]
      >) {
        watermarks[table] = wmRow[col] ?? 0;
      }

      let anyData = false;
      let remainingBudget = sessionRowBudget;
      const activeTables = new Set(sessionTables);

      while (remainingBudget > 0 && activeTables.size > 0) {
        let progressedInPass = false;

        for (const table of sessionTables) {
          if (!activeTables.has(table) || remainingBudget <= 0) continue;

          const limit = Math.min(batchSize, remainingBudget);
          const { rows, maxId } = SESSION_READERS[table](
            entry.session_id,
            watermarks[table],
            limit,
          );
          if (rows.length === 0) {
            activeTables.delete(table);
            continue;
          }

          anyData = true;
          progressedInPass = true;

          for (let i = 0; i < rows.length; i += postBatchSize) {
            const batch = rows.slice(i, i + postBatchSize);
            await postSync(url, { table, rows: batch }, headers);
          }

          watermarks[table] = maxId;
          remainingBudget -= rows.length;

          if (rows.length < limit) {
            activeTables.delete(table);
          }
        }

        if (!progressedInPass) break;
      }

      const fullyDrained = activeTables.size === 0;
      const nextSyncedSeq =
        sessionPendingMode === "sync-seq" && fullyDrained
          ? entry.sync_seq
          : entry.synced_seq;

      writeSessionProgress(
        entry.session_id,
        target.name,
        watermarks,
        nextSyncedSeq,
      );

      if (anyData) {
        log.sync.info(
          formatLog(
            `session-sync: ${fullyDrained ? "synced" : "advanced"} data for ${entry.session_id} to ${target.name}`,
          ),
        );
      }
    }

    return hasRemainingPendingSessions(target.name);
  }

  // ── Phase 3: Sync non-session tables (unchanged) ─────────────────────────

  async function syncNonSessionTables(target: SyncTarget): Promise<boolean> {
    if (nonSessionTables.length === 0) return false;

    let hasMore = false;

    for (const desc of nonSessionTables) {
      const wmKey = watermarkKey(desc.table, target.name);
      const wm = readWatermark(wmKey);
      const { rows, maxId } = desc.read(wm, batchSize);
      if (rows.length === 0) continue;

      // Apply repo filter to repo_config_snapshots
      const filtered =
        desc.table === "repo_config_snapshots"
          ? rows.filter((r: unknown) => {
              const row = r as Record<string, unknown>;
              return repoMatchesFilter(row.repository as string, opts.filter);
            })
          : rows;

      if (filtered.length > 0) {
        log.sync.info(
          formatLog(
            `${desc.table}: ${filtered.length} ${desc.logNoun} (watermark ${wm} → ${maxId})`,
          ),
        );

        for (let j = 0; j < filtered.length; j += postBatchSize) {
          const batch = filtered.slice(j, j + postBatchSize);
          await postSync(
            `${target.url}/v1/sync`,
            { table: desc.table, rows: batch },
            resolveHeaders(target),
          );
        }
      }

      writeWatermark(wmKey, maxId);
      if (rows.length === batchSize) hasMore = true;
    }

    return hasMore;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function recordConfirmedSessions(
    sessionIds: string[],
    targetName: string,
  ): void {
    const db = getDb();
    const upsert = db.prepare(
      `INSERT INTO target_session_sync (session_id, target, confirmed, sync_seq)
       VALUES (?, ?, 1, (SELECT sync_seq FROM sessions WHERE session_id = ?))
       ON CONFLICT(session_id, target) DO UPDATE SET
         confirmed = 1,
         sync_seq = MAX(target_session_sync.sync_seq,
                        (SELECT sync_seq FROM sessions WHERE session_id = excluded.session_id))`,
    );
    for (const sessionId of sessionIds) {
      upsert.run(sessionId, targetName, sessionId);
    }
  }

  // ── Main loop ────────────────────────────────────────────────────────────

  async function runOnce(): Promise<boolean> {
    let hasMore = false;

    const syncableSessionIds = syncSessionsEnabled
      ? buildSyncableSessionIds(opts)
      : null;

    for (const target of opts.targets) {
      try {
        // Phase 1: Sync sessions (repo-filtered, backend confirms)
        if (await syncSessions(target, syncableSessionIds)) hasMore = true;

        // Phase 2: Sync dependent data for confirmed sessions
        if (await syncSessionData(target)) hasMore = true;

        // Phase 3: Sync non-session tables
        if (await syncNonSessionTables(target)) hasMore = true;
      } catch (err) {
        log.sync.error(
          `Error syncing to ${target.name}: ${err instanceof Error ? err.message : err}`,
        );
        captureException(err, {
          component: "sync",
          target: target.name,
        });
      }
    }

    return hasMore;
  }

  async function tick(): Promise<void> {
    if (syncing || stopping) return;
    syncing = true;
    let hasMore = false;
    try {
      getDb(); // ensure DB is accessible
      hasMore = await runOnce();
    } catch (err) {
      log.sync.error(
        `Cycle error: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
      captureException(err, { component: "sync" });
    } finally {
      syncing = false;
    }

    if (!stopping) {
      scheduleNext(hasMore);
    }
  }

  return {
    start() {
      if (timer || syncing) return;
      stopping = false;
      log.sync.info(formatLog("Starting sync"));
      tick().catch((err) => log.sync.error(`Tick error: ${err}`));
    },
    stop() {
      stopping = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        log.sync.info(formatLog("Stopped sync"));
      }
    },
    runOnce,
  };
}
