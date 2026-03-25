import type { SyncTarget } from "../sync/types.js";
import { readWatermark, watermarkKey } from "../sync/watermark.js";
import type { RetentionConfig } from "../unified-config.js";
import { getDb } from "./schema.js";

export interface SyncPruneResult {
  hook_events: number;
  otel_logs: number;
  otel_metrics: number;
}

/**
 * Compute the minimum watermark for a table across all sync targets.
 * Returns 0 if no targets exist or any target has watermark 0 (hasn't synced yet).
 */
export function minWatermarkForTable(
  table: string,
  targets: SyncTarget[],
): number {
  if (targets.length === 0) return 0;

  let min = Infinity;
  for (const t of targets) {
    const wm = readWatermark(watermarkKey(table, t.name));
    if (wm === 0) return 0;
    if (wm < min) min = wm;
  }
  return min === Infinity ? 0 : min;
}

/**
 * Aggressively prune rows that have been confirmed synced to ALL targets
 * and are older than `syncedMaxAgeDays`.
 *
 * No-op when:
 * - No sync targets configured
 * - `syncedMaxAgeDays` is not set
 * - Any target has watermark 0 for a given table (hasn't completed first sync)
 */
export function syncAwarePrune(
  targets: SyncTarget[],
  retention: RetentionConfig,
): SyncPruneResult {
  const result: SyncPruneResult = {
    hook_events: 0,
    otel_logs: 0,
    otel_metrics: 0,
  };

  if (!retention.syncedMaxAgeDays || targets.length === 0) {
    return result;
  }

  const cutoffMs =
    Date.now() - retention.syncedMaxAgeDays * 24 * 60 * 60 * 1000;
  const cutoffNs = cutoffMs * 1_000_000;
  const db = getDb();

  const tx = db.transaction(() => {
    // -- hook_events --
    const hookMinWm = minWatermarkForTable("hook_events", targets);
    if (hookMinWm > 0) {
      db.prepare(
        "DELETE FROM hook_events_fts WHERE rowid IN (SELECT id FROM hook_events WHERE id <= ? AND timestamp_ms < ?)",
      ).run(hookMinWm, cutoffMs);

      result.hook_events = db
        .prepare("DELETE FROM hook_events WHERE id <= ? AND timestamp_ms < ?")
        .run(hookMinWm, cutoffMs).changes;
    }

    // -- otel_logs --
    const logsMinWm = minWatermarkForTable("otel_logs", targets);
    if (logsMinWm > 0) {
      result.otel_logs = db
        .prepare("DELETE FROM otel_logs WHERE id <= ? AND timestamp_ns < ?")
        .run(logsMinWm, cutoffNs).changes;
    }

    // -- otel_metrics --
    const metricsMinWm = minWatermarkForTable("otel_metrics", targets);
    if (metricsMinWm > 0) {
      result.otel_metrics = db
        .prepare("DELETE FROM otel_metrics WHERE id <= ? AND timestamp_ns < ?")
        .run(metricsMinWm, cutoffNs).changes;
    }

    // Session metadata (session_repositories, session_cwds) is local-only —
    // not synced to remote targets. Left to regular time/size-based pruneExecute.
  });

  tx();
  return result;
}
