import { getDb } from "../db/schema.js";
import { loadUnifiedConfig } from "../unified-config.js";
import { buildSyncableSessionIds } from "./filter.js";
import { TABLE_SYNC_REGISTRY } from "./registry.js";
import { readWatermark, watermarkKey } from "./watermark.js";

export interface SyncPendingResult {
  target: string;
  totalPending: number;
  rejectedSessions: number;
  tables: Record<string, { total: number; synced: number; pending: number }>;
}

export interface SyncRejectedSession {
  sessionId: string;
  code: string;
  reason: string;
  rejectedAtMs: number | null;
  syncSeq: number;
}

export interface SyncRejectedOptions {
  limit?: number;
  offset?: number;
}

export interface SyncRejectedResult {
  target: string;
  total: number;
  limit: number;
  offset: number;
  sessions: SyncRejectedSession[];
}

const SESSION_WATERMARK_COLUMNS: Record<string, string> = {
  messages: "wm_messages",
  tool_calls: "wm_tool_calls",
  scanner_turns: "wm_scanner_turns",
  scanner_events: "wm_scanner_events",
  hook_events: "wm_hook_events",
  otel_logs: "wm_otel_logs",
  otel_metrics: "wm_otel_metrics",
  otel_spans: "wm_otel_spans",
};

type SessionPendingRow = {
  session_id: string;
  target_session_id: string | null;
  confirmed: number | null;
  sync_seq: number;
  target_sync_seq: number;
};

type RejectedSessionRow = {
  session_id: string;
};

type RejectedSessionDetailRow = {
  session_id: string;
  rejection_code: string | null;
  rejection_reason: string | null;
  rejected_at_ms: number | null;
  sync_seq: number | null;
};

function addPendingTable(
  pending: SyncPendingResult["tables"],
  table: string,
  total: number,
  pendingCount: number,
): void {
  if (pendingCount <= 0) return;
  pending[table] = {
    total,
    synced: Math.max(0, total - pendingCount),
    pending: pendingCount,
  };
}

function syncableSessionIdsForConfiguredFilter(): Set<string> | null {
  return buildSyncableSessionIds(loadUnifiedConfig().sync.filter);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function readSyncPending(target: string): SyncPendingResult {
  const db = getDb();
  const pending: SyncPendingResult["tables"] = {};
  const syncableSessionIds = syncableSessionIdsForConfiguredFilter();

  const sessionRows = db
    .prepare(
      `SELECT sessions.session_id,
              target_session_sync.session_id AS target_session_id,
              target_session_sync.confirmed,
              COALESCE(sessions.sync_seq, 0) AS sync_seq,
              COALESCE(target_session_sync.sync_seq, 0) AS target_sync_seq
       FROM sessions
       LEFT JOIN target_session_sync
         ON target_session_sync.session_id = sessions.session_id
        AND target_session_sync.target = ?
       WHERE target_session_sync.session_id IS NULL
          OR target_session_sync.confirmed = 1`,
    )
    .all(target) as SessionPendingRow[];
  let sessionTotal = 0;
  let pendingSessionRows = 0;
  for (const row of sessionRows) {
    if (syncableSessionIds && !syncableSessionIds.has(row.session_id)) {
      continue;
    }
    sessionTotal++;
    if (
      row.target_session_id === null ||
      (row.confirmed === 1 && row.sync_seq > row.target_sync_seq)
    ) {
      pendingSessionRows++;
    }
  }
  addPendingTable(pending, "sessions", sessionTotal, pendingSessionRows);

  const rejectedRows = db
    .prepare(
      `SELECT target_session_sync.session_id
       FROM target_session_sync
       INNER JOIN sessions ON sessions.session_id = target_session_sync.session_id
       WHERE target_session_sync.target = ?
         AND target_session_sync.rejected = 1`,
    )
    .all(target) as RejectedSessionRow[];
  let rejectedSessions = 0;
  for (const row of rejectedRows) {
    if (syncableSessionIds && !syncableSessionIds.has(row.session_id)) {
      continue;
    }
    rejectedSessions++;
  }

  const derivedRows = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE
                    WHEN COALESCE(sessions.derived_sync_seq, 0) > COALESCE(target_session_sync.derived_synced_seq, 0)
                    THEN 1 ELSE 0
                  END) AS pending
       FROM target_session_sync
       INNER JOIN sessions ON sessions.session_id = target_session_sync.session_id
       WHERE target_session_sync.target = ?
         AND target_session_sync.confirmed = 1
         AND (
           COALESCE(sessions.derived_sync_seq, 0) > 0
           OR COALESCE(target_session_sync.derived_synced_seq, 0) > 0
         )`,
    )
    .get(target) as { total: number; pending: number | null } | undefined;
  addPendingTable(
    pending,
    "session_derived_state",
    derivedRows?.total ?? 0,
    derivedRows?.pending ?? 0,
  );

  for (const desc of TABLE_SYNC_REGISTRY) {
    const wmCol = SESSION_WATERMARK_COLUMNS[desc.table];
    if (desc.sessionLinked && wmCol) {
      const total =
        (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM ${desc.table} t
               INNER JOIN target_session_sync tss
                 ON tss.session_id = t.session_id AND tss.target = ?
               WHERE tss.confirmed = 1`,
            )
            .get(target) as { c: number }
        )?.c ?? 0;
      const pendingCount =
        (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM ${desc.table} t
               INNER JOIN target_session_sync tss
                 ON tss.session_id = t.session_id AND tss.target = ?
               WHERE tss.confirmed = 1 AND t.id > tss.${wmCol}`,
            )
            .get(target) as { c: number }
        )?.c ?? 0;
      if (pendingCount > 0) {
        pending[desc.table] = {
          total,
          synced: total - pendingCount,
          pending: pendingCount,
        };
      }
      continue;
    }

    const key = watermarkKey(desc.table, target);
    const wm = readWatermark(key);
    const maxId =
      (
        db
          .prepare(
            `SELECT MAX(${desc.table === "sessions" ? "sync_seq" : "id"}) as m FROM ${desc.table}`,
          )
          .get() as { m: number | null }
      )?.m ?? 0;
    const count = Math.max(0, maxId - wm);
    if (count > 0) {
      pending[desc.table] = { total: maxId, synced: wm, pending: count };
    }
  }

  return {
    target,
    totalPending: Object.values(pending).reduce(
      (sum, value) => sum + value.pending,
      0,
    ),
    rejectedSessions,
    tables: pending,
  };
}

export function readSyncRejectedSessions(
  target: string,
  opts: SyncRejectedOptions = {},
): SyncRejectedResult {
  const db = getDb();
  const syncableSessionIds = syncableSessionIdsForConfiguredFilter();
  const limit = boundedInteger(opts.limit, 50, 1, 500);
  const offset = boundedInteger(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const rows = db
    .prepare(
      `SELECT target_session_sync.session_id,
              target_session_sync.rejection_code,
              target_session_sync.rejection_reason,
              target_session_sync.rejected_at_ms,
              COALESCE(target_session_sync.sync_seq, 0) AS sync_seq
       FROM target_session_sync
       INNER JOIN sessions ON sessions.session_id = target_session_sync.session_id
       WHERE target_session_sync.target = ?
         AND target_session_sync.rejected = 1
       ORDER BY COALESCE(target_session_sync.rejected_at_ms, 0) DESC,
                target_session_sync.session_id ASC`,
    )
    .all(target) as RejectedSessionDetailRow[];

  const sessions = rows
    .filter(
      (row) => !syncableSessionIds || syncableSessionIds.has(row.session_id),
    )
    .map((row) => ({
      sessionId: row.session_id,
      code: row.rejection_code ?? "rejected",
      reason: row.rejection_reason ?? "session rejected by sync target",
      rejectedAtMs: row.rejected_at_ms,
      syncSeq: row.sync_seq ?? 0,
    }));

  return {
    target,
    total: sessions.length,
    limit,
    offset,
    sessions: sessions.slice(offset, offset + limit),
  };
}
