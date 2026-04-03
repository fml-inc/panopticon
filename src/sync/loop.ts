import { execSync } from "node:child_process";
import { getDb } from "../db/schema.js";
import { log } from "../log.js";
import { captureException } from "../sentry.js";
import { postSync } from "./post.js";
import { SESSION_READERS } from "./reader.js";
import { TABLE_SYNC_REGISTRY } from "./registry.js";
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
const MAX_SESSIONS_PER_TICK = 10;
const STALE_PENDING_DAYS = 30;

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

  function resolveHeaders(target: SyncTarget): Record<string, string> {
    const headers: Record<string, string> = { ...target.headers };
    const token = resolveToken(target);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;
  let stopping = false;

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

  // ── Phase 1: Sync sessions (watermark on sync_seq, repo-filtered) ────────

  async function syncSessions(
    target: SyncTarget,
    syncableSessionIds: Set<string> | null,
  ): Promise<boolean> {
    const sessionsDesc = TABLE_SYNC_REGISTRY.find(
      (d) => d.table === "sessions",
    );
    if (!sessionsDesc) return false;

    const wmKey = watermarkKey(sessionsDesc.table, target.name);
    const wm = readWatermark(wmKey);
    const { rows, maxId } = sessionsDesc.read(wm, batchSize);
    if (rows.length === 0) return false;

    // Filter by repo attribution
    let filtered = rows;
    if (syncableSessionIds) {
      filtered = rows.filter((r: unknown) => {
        const row = r as Record<string, unknown>;
        const sessionId =
          (row.sessionId as string) ?? (row.session_id as string);
        return sessionId && syncableSessionIds.has(sessionId);
      });
    }

    if (filtered.length > 0) {
      log.sync.info(
        `sessions: ${filtered.length} sessions (watermark ${wm} → ${maxId})`,
      );

      // POST in batches and collect accepted session IDs
      for (let j = 0; j < filtered.length; j += postBatchSize) {
        const batch = filtered.slice(j, j + postBatchSize);
        const response = await postSync(
          `${target.url}/v1/sync`,
          { table: "sessions", rows: batch },
          resolveHeaders(target),
        );

        // Record confirmed sessions from backend response
        const accepted = response.accepted;
        if (Array.isArray(accepted)) {
          recordConfirmedSessions(accepted as string[], target.name);
        }
      }
    }

    writeWatermark(wmKey, maxId);
    return rows.length === batchSize;
  }

  // ── Phase 2: Sync dependent data (per-session, gated by confirmed) ───────

  async function syncSessionData(target: SyncTarget): Promise<boolean> {
    const db = getDb();

    // Clean up stale pending entries
    const staleCutoff = Date.now() - STALE_PENDING_DAYS * 24 * 60 * 60 * 1000;
    db.prepare(
      `DELETE FROM pending_session_sync
       WHERE (confirmed = 0 AND rowid IN (
         SELECT p.rowid FROM pending_session_sync p
         WHERE p.target = ? AND json_extract(p.table_watermarks, '$.created_at_ms') < ?
       ))
       OR session_id NOT IN (SELECT session_id FROM sessions)`,
    ).run(target.name, staleCutoff);

    // Get confirmed sessions that have new data (sync_seq > synced_seq)
    const pending = db
      .prepare(
        `SELECT p.session_id, p.table_watermarks, s.sync_seq
         FROM pending_session_sync p
         JOIN sessions s ON s.session_id = p.session_id
         WHERE p.target = ? AND p.confirmed = 1
           AND s.sync_seq > p.synced_seq
         ORDER BY p.rowid
         LIMIT ?`,
      )
      .all(target.name, MAX_SESSIONS_PER_TICK) as Array<{
      session_id: string;
      table_watermarks: string;
      sync_seq: number;
    }>;

    if (pending.length === 0) return false;

    const headers = resolveHeaders(target);
    const url = `${target.url}/v1/sync`;

    for (const entry of pending) {
      const watermarks = parseTableWatermarks(entry.table_watermarks);
      let anyData = false;

      for (const [table, reader] of Object.entries(SESSION_READERS)) {
        // Read and POST in batches, draining until no more rows
        let afterId = watermarks[table] ?? 0;
        for (;;) {
          const { rows, maxId } = reader(entry.session_id, afterId, batchSize);
          if (rows.length === 0) break;

          anyData = true;

          for (let i = 0; i < rows.length; i += postBatchSize) {
            const batch = rows.slice(i, i + postBatchSize);
            await postSync(url, { table, rows: batch }, headers);
          }

          afterId = maxId;
          watermarks[table] = maxId;

          if (rows.length < batchSize) break;
        }
      }

      // Update watermarks and mark as synced up to current sync_seq
      db.prepare(
        `UPDATE pending_session_sync
         SET table_watermarks = ?, synced_seq = ?
         WHERE session_id = ? AND target = ?`,
      ).run(
        JSON.stringify(watermarks),
        entry.sync_seq,
        entry.session_id,
        target.name,
      );

      if (anyData) {
        log.sync.info(
          `session-sync: synced data for ${entry.session_id} to ${target.name}`,
        );
      }
    }

    // Check if more confirmed sessions with new data remain
    const remaining = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM pending_session_sync p
         JOIN sessions s ON s.session_id = p.session_id
         WHERE p.target = ? AND p.confirmed = 1
           AND s.sync_seq > p.synced_seq`,
      )
      .get(target.name) as { cnt: number };

    return remaining.cnt > 0;
  }

  // ── Phase 3: Sync non-session tables (unchanged) ─────────────────────────

  async function syncNonSessionTables(target: SyncTarget): Promise<boolean> {
    let hasMore = false;

    for (const desc of TABLE_SYNC_REGISTRY) {
      if (desc.sessionLinked) continue; // handled by Phase 1 and 2

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
          `${desc.table}: ${filtered.length} ${desc.logNoun} (watermark ${wm} → ${maxId})`,
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
      `INSERT INTO pending_session_sync (session_id, target, confirmed, table_watermarks)
       VALUES (?, ?, 1, '{}')
       ON CONFLICT(session_id, target) DO UPDATE SET confirmed = 1`,
    );
    for (const sessionId of sessionIds) {
      upsert.run(sessionId, targetName);
    }
  }

  function parseTableWatermarks(json: string): Record<string, number> {
    try {
      const parsed = JSON.parse(json);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  // ── Main loop ────────────────────────────────────────────────────────────

  async function runOnce(): Promise<boolean> {
    let hasMore = false;

    const syncableSessionIds = buildSyncableSessionIds(opts);

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
      log.sync.info("Starting sync");
      tick().catch((err) => log.sync.error(`Tick error: ${err}`));
    },
    stop() {
      stopping = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        log.sync.info("Stopped sync");
      }
    },
  };
}
