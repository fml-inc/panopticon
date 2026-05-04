import { getDb } from "../db/schema.js";
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

export function readSyncPending(target: string): SyncPendingResult {
  const db = getDb();
  const pending: SyncPendingResult["tables"] = {};

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
