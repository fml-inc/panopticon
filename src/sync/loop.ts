declare const __PANOPTICON_VERSION__: string;

import { execSync } from "node:child_process";
import {
  clearAttemptBackoff,
  isAttemptBackoffActive,
  recordAttemptBackoffFailure,
} from "../attempt-backoff.js";
import { getDb } from "../db/schema.js";
import { log } from "../log.js";
import { captureException } from "../sentry.js";
import {
  buildSyncableSessionIds,
  repoMatchesFilter,
  sessionHasSyncableRepoSql,
} from "./filter.js";
import { isExpectedSyncError, postSync } from "./post.js";
import {
  readSessionDerivedState,
  readSessionsByIds,
  SESSION_READERS,
} from "./reader.js";
import {
  DEFAULT_NON_SESSION_TABLES,
  DEFAULT_SESSION_TABLES,
  TABLE_SYNC_REGISTRY,
} from "./registry.js";
import { syncArchivedSessionFiles } from "./session-files.js";
import type { SyncHandle, SyncOptions, SyncTarget } from "./types.js";
import { readWatermark, watermarkKey, writeWatermark } from "./watermark.js";

const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_POST_BATCH_SIZE = 100;
const DEFAULT_POST_BATCH_MAX_BYTES = 900 * 1024;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_CATCHUP_MS = 100;
const DEFAULT_MAX_SESSIONS_PER_TICK = 10;
const SYNC_TARGET_BACKOFF_SCOPE = "sync-target";
const DERIVED_STATE_TABLE = "session_derived_state";

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
  row_id: number;
  session_id: string;
  sync_seq: number;
  synced_seq: number;
} & Record<(typeof WM_COLUMNS)[SessionTableName], number>;

type PendingDerivedSessionRow = {
  row_id: number;
  session_id: string;
  derived_sync_seq: number;
  derived_synced_seq: number;
};

function syncPostBodyBytes(table: string, rows: unknown[]): number {
  return Buffer.byteLength(JSON.stringify({ table, rows }));
}

function splitRowsForPost(
  table: string,
  rows: unknown[],
  maxRows: number,
  maxBytes: number,
): unknown[][] {
  const batches: unknown[][] = [];
  let batch: unknown[] = [];

  for (const row of rows) {
    const candidate = [...batch, row];
    if (
      batch.length > 0 &&
      (candidate.length > maxRows ||
        syncPostBodyBytes(table, candidate) > maxBytes)
    ) {
      batches.push(batch);
      batch = [row];
      continue;
    }
    batch = candidate;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

function isSessionTableName(table: string): table is SessionTableName {
  return table in WM_COLUMNS && table in SESSION_READERS;
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
      windowsHide: true,
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
  const postBatchMaxBytes = DEFAULT_POST_BATCH_MAX_BYTES;
  const idleMs = opts.idleIntervalMs ?? DEFAULT_IDLE_MS;
  const catchUpMs = opts.catchUpIntervalMs ?? DEFAULT_CATCHUP_MS;
  const maxSessionsPerTick =
    opts.maxSessionsPerTick ?? DEFAULT_MAX_SESSIONS_PER_TICK;
  const sessionRowBudget = Math.max(1, opts.sessionRowBudget ?? batchSize);
  const sessionPendingMode = opts.sessionPendingMode ?? "sync-seq";
  const syncSessionsEnabled = opts.syncSessions ?? true;
  const syncSessionFilesEnabled = opts.syncSessionFiles ?? false;
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
  const backoffScopeKind = opts.loopName
    ? `${SYNC_TARGET_BACKOFF_SCOPE}:${opts.loopName}`
    : SYNC_TARGET_BACKOFF_SCOPE;
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

  async function postRowsInBatches(
    url: string,
    table: string,
    rows: unknown[],
    headers: Record<string, string>,
  ): Promise<void> {
    for (const batch of splitRowsForPost(
      table,
      rows,
      postBatchSize,
      postBatchMaxBytes,
    )) {
      await postSync(url, { table, rows: batch }, headers);
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;
  let stopping = false;
  const pendingSessionCursorByTarget = new Map<string, number>();
  const pendingDerivedCursorByTarget = new Map<string, number>();

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
      ? `AND (${sessionHasSyncableRepoSql("s")})`
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
      log.sync.debug(formatLog(`sessions: ${rows.length} sessions to sync`));

      for (const batch of splitRowsForPost(
        "sessions",
        rows,
        postBatchSize,
        postBatchMaxBytes,
      )) {
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

  function buildPendingSessionWhereClause(): string {
    return sessionPendingMode === "watermark-gap"
      ? watermarkGapPredicate
        ? `AND (${watermarkGapPredicate})`
        : "AND 0"
      : "AND sync_seq > synced_seq";
  }

  function hasRemainingPendingSessions(targetName: string): boolean {
    if (sessionTables.length === 0) return false;

    const db = getDb();
    const whereClause = buildPendingSessionWhereClause();
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

  function readPendingSessionsPage(
    targetName: string,
    whereClause: string,
    rowPredicate: string,
    rowParam: number,
    limit: number,
  ): PendingSessionRow[] {
    if (limit <= 0) return [];

    const db = getDb();
    return db
      .prepare(
        `SELECT rowid AS row_id, session_id, sync_seq, synced_seq,
                wm_messages, wm_tool_calls, wm_scanner_turns,
                wm_scanner_events, wm_hook_events, wm_otel_logs,
                wm_otel_metrics, wm_otel_spans
         FROM target_session_sync
         WHERE target = ? AND confirmed = 1
           ${whereClause}
           AND ${rowPredicate}
         ORDER BY rowid
         LIMIT ?`,
      )
      .all(targetName, rowParam, limit) as PendingSessionRow[];
  }

  function readPendingSessions(targetName: string): PendingSessionRow[] {
    if (sessionTables.length === 0) return [];

    const whereClause = buildPendingSessionWhereClause();
    const cursor = pendingSessionCursorByTarget.get(targetName) ?? 0;
    const firstPage = readPendingSessionsPage(
      targetName,
      whereClause,
      "rowid > ?",
      cursor,
      maxSessionsPerTick,
    );
    const wrappedPage =
      firstPage.length < maxSessionsPerTick && cursor > 0
        ? readPendingSessionsPage(
            targetName,
            whereClause,
            "rowid <= ?",
            cursor,
            maxSessionsPerTick - firstPage.length,
          )
        : [];
    const pending = [...firstPage, ...wrappedPage];

    if (pending.length === 0) {
      pendingSessionCursorByTarget.set(targetName, 0);
      return pending;
    }

    pendingSessionCursorByTarget.set(
      targetName,
      pending[pending.length - 1].row_id,
    );
    return pending;
  }

  function writeSessionProgress(
    sessionId: string,
    targetName: string,
    watermarks: Partial<Record<SessionTableName, number>>,
    expectedSyncSeq: number,
    syncedSeq?: number,
  ): void {
    const assignments: string[] = [];
    const params: Array<number | string> = [];

    for (const [table, watermark] of Object.entries(watermarks) as Array<
      [SessionTableName, number]
    >) {
      assignments.push(`${WM_COLUMNS[table]} = ?`);
      params.push(watermark);
    }

    if (syncedSeq !== undefined) {
      assignments.push("synced_seq = ?");
      params.push(syncedSeq);
    }

    if (assignments.length === 0) return;

    const db = getDb();
    db.prepare(
      `UPDATE target_session_sync
       SET ${assignments.join(", ")}
       WHERE session_id = ? AND target = ? AND sync_seq = ?`,
    ).run(...params, sessionId, targetName, expectedSyncSeq);
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

          await postRowsInBatches(url, table, rows, headers);

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
          : undefined;
      const ownedWatermarks = Object.fromEntries(
        sessionTables.map((table) => [table, watermarks[table]]),
      ) as Partial<Record<SessionTableName, number>>;

      writeSessionProgress(
        entry.session_id,
        target.name,
        ownedWatermarks,
        entry.sync_seq,
        nextSyncedSeq,
      );

      if (anyData) {
        log.sync.debug(
          formatLog(
            `session-sync: ${fullyDrained ? "synced" : "advanced"} data for ${entry.session_id} to ${target.name}`,
          ),
        );
      }
    }

    return hasRemainingPendingSessions(target.name);
  }

  // ── Phase 2a: Sync derived session state bundles ───────────────────────

  function hasRemainingPendingDerivedSessions(targetName: string): boolean {
    if (!syncSessionsEnabled) return false;

    const db = getDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM target_session_sync tss
         JOIN sessions s ON s.session_id = tss.session_id
         WHERE tss.target = ?
           AND tss.confirmed = 1
           AND COALESCE(s.derived_sync_seq, 0) > COALESCE(tss.derived_synced_seq, 0)`,
      )
      .get(targetName) as { cnt: number };
    return row.cnt > 0;
  }

  function readPendingDerivedSessionsPage(
    targetName: string,
    rowPredicate: string,
    rowParam: number,
    limit: number,
  ): PendingDerivedSessionRow[] {
    if (limit <= 0) return [];

    const db = getDb();
    return db
      .prepare(
        `SELECT tss.rowid AS row_id,
                tss.session_id,
                COALESCE(s.derived_sync_seq, 0) AS derived_sync_seq,
                COALESCE(tss.derived_synced_seq, 0) AS derived_synced_seq
         FROM target_session_sync tss
         JOIN sessions s ON s.session_id = tss.session_id
         WHERE tss.target = ?
           AND tss.confirmed = 1
           AND COALESCE(s.derived_sync_seq, 0) > COALESCE(tss.derived_synced_seq, 0)
           AND ${rowPredicate}
         ORDER BY tss.rowid
         LIMIT ?`,
      )
      .all(targetName, rowParam, limit) as PendingDerivedSessionRow[];
  }

  function readPendingDerivedSessions(
    targetName: string,
  ): PendingDerivedSessionRow[] {
    if (!syncSessionsEnabled) return [];

    const cursor = pendingDerivedCursorByTarget.get(targetName) ?? 0;
    const firstPage = readPendingDerivedSessionsPage(
      targetName,
      "tss.rowid > ?",
      cursor,
      maxSessionsPerTick,
    );
    const wrappedPage =
      firstPage.length < maxSessionsPerTick && cursor > 0
        ? readPendingDerivedSessionsPage(
            targetName,
            "tss.rowid <= ?",
            cursor,
            maxSessionsPerTick - firstPage.length,
          )
        : [];
    const pending = [...firstPage, ...wrappedPage];

    if (pending.length === 0) {
      pendingDerivedCursorByTarget.set(targetName, 0);
      return pending;
    }

    pendingDerivedCursorByTarget.set(
      targetName,
      pending[pending.length - 1].row_id,
    );
    return pending;
  }

  function writeDerivedSessionProgress(
    sessionId: string,
    targetName: string,
    syncedDerivedSeq: number,
  ): void {
    const db = getDb();
    db.prepare(
      `UPDATE target_session_sync
       SET derived_synced_seq = MAX(COALESCE(derived_synced_seq, 0), ?)
       WHERE session_id = ? AND target = ?`,
    ).run(syncedDerivedSeq, sessionId, targetName);
  }

  async function syncSessionDerivedState(target: SyncTarget): Promise<boolean> {
    if (!syncSessionsEnabled) return false;

    const db = getDb();
    db.prepare(
      `DELETE FROM target_session_sync
       WHERE session_id NOT IN (SELECT session_id FROM sessions)`,
    ).run();

    const pending = readPendingDerivedSessions(target.name);
    if (pending.length === 0) return false;

    const headers = resolveHeaders(target);
    const url = `${target.url}/v1/sync`;

    for (const entry of pending) {
      const row = readSessionDerivedState(entry.session_id);
      await postSync(
        url,
        {
          table: DERIVED_STATE_TABLE,
          rows: [row],
        },
        headers,
      );
      writeDerivedSessionProgress(
        entry.session_id,
        target.name,
        entry.derived_sync_seq,
      );
      log.sync.debug(
        formatLog(
          `session-derived-sync: synced derived state for ${entry.session_id} to ${target.name}`,
        ),
      );
    }

    return hasRemainingPendingDerivedSessions(target.name);
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
        log.sync.debug(
          formatLog(
            `${desc.table}: ${filtered.length} ${desc.logNoun} (watermark ${wm} → ${maxId})`,
          ),
        );

        await postRowsInBatches(
          `${target.url}/v1/sync`,
          desc.table,
          filtered,
          resolveHeaders(target),
        );
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
      ? buildSyncableSessionIds(opts.filter)
      : null;

    for (const target of opts.targets) {
      if (isAttemptBackoffActive(backoffScopeKind, target.name)) {
        log.sync.debug(
          formatLog(`Skipping ${target.name}: target backoff active`),
        );
        continue;
      }
      try {
        // Phase 1: Sync sessions (repo-filtered, backend confirms)
        if (await syncSessions(target, syncableSessionIds)) hasMore = true;

        // Phase 2: Sync derived state for confirmed sessions
        if (await syncSessionDerivedState(target)) hasMore = true;

        // Phase 3: Sync dependent raw session data for confirmed sessions
        if (await syncSessionData(target)) hasMore = true;

        // Phase 4: Multipart-upload archived raw session files for confirmed sessions
        if (
          syncSessionFilesEnabled &&
          (await syncArchivedSessionFiles(target, resolveHeaders(target), {
            limit: maxSessionsPerTick,
          }))
        ) {
          hasMore = true;
        }

        // Phase 5: Sync non-session tables
        if (await syncNonSessionTables(target)) hasMore = true;
        clearAttemptBackoff(backoffScopeKind, target.name);
      } catch (err) {
        recordAttemptBackoffFailure(
          backoffScopeKind,
          target.name,
          err instanceof Error ? err.message : String(err),
        );
        log.sync.error(
          `Error syncing to ${target.name}: ${err instanceof Error ? err.message : err}`,
        );
        // Unreachable/misconfigured targets and auth rejections are expected
        // operational failures — already logged and backed off. Only report
        // genuinely unexpected failures to Sentry.
        if (!isExpectedSyncError(err)) {
          captureException(err, {
            component: "sync",
            target: target.name,
          });
        }
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
