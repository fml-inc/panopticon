import { getDb } from "../db/schema.js";
import { loadUnifiedConfig } from "../unified-config.js";
import { buildSyncableSessionIds } from "./filter.js";
import { TABLE_SYNC_REGISTRY } from "./registry.js";
import { readWatermark, watermarkKey } from "./watermark.js";

export interface SyncPendingResult {
  target: string;
  totalPending: number;
  tables: Record<string, { total: number; synced: number; pending: number }>;
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

export function readSyncPending(target: string): SyncPendingResult {
  const db = getDb();
  const pending: SyncPendingResult["tables"] = {};
  const syncableSessionIds = buildSyncableSessionIds(
    loadUnifiedConfig().sync.filter,
  );

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
    tables: pending,
  };
}
