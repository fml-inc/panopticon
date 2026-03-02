import fs from "node:fs";
import { config } from "../config.js";
import { readWatermark } from "../sync/state.js";
import { getDb } from "./schema.js";

export interface PruneResult {
  otel_logs: number;
  otel_metrics: number;
  hook_events: number;
  session_repositories: number;
  session_cwds: number;
}

export function pruneEstimate(
  cutoffMs: number,
  syncedOnly: boolean,
): PruneResult {
  const db = getDb();
  const cutoffNs = cutoffMs * 1_000_000;

  let logWhere = "WHERE timestamp_ns < ?";
  let metricWhere = "WHERE timestamp_ns < ?";
  let hookWhere = "WHERE timestamp_ms < ?";
  const logParams: number[] = [cutoffNs];
  const metricParams: number[] = [cutoffNs];
  const hookParams: number[] = [cutoffMs];

  if (syncedOnly) {
    const logWm = readWatermark("otel_logs_last_id") ?? 0;
    const metricWm = readWatermark("otel_metrics_last_id") ?? 0;
    const hookWm = readWatermark("hook_events_last_id") ?? 0;

    logWhere += " AND id <= ?";
    metricWhere += " AND id <= ?";
    hookWhere += " AND id <= ?";
    logParams.push(logWm);
    metricParams.push(metricWm);
    hookParams.push(hookWm);
  }

  const logs = (
    db
      .prepare(`SELECT COUNT(*) as c FROM otel_logs ${logWhere}`)
      .get(...logParams) as { c: number }
  ).c;
  const metrics = (
    db
      .prepare(`SELECT COUNT(*) as c FROM otel_metrics ${metricWhere}`)
      .get(...metricParams) as { c: number }
  ).c;
  const hooks = (
    db
      .prepare(`SELECT COUNT(*) as c FROM hook_events ${hookWhere}`)
      .get(...hookParams) as { c: number }
  ).c;
  const sessionRepos = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM session_repositories WHERE first_seen_ms < ?`,
      )
      .get(cutoffMs) as { c: number }
  ).c;
  const sessionCwds = (
    db
      .prepare(`SELECT COUNT(*) as c FROM session_cwds WHERE first_seen_ms < ?`)
      .get(cutoffMs) as { c: number }
  ).c;

  return {
    otel_logs: logs,
    otel_metrics: metrics,
    hook_events: hooks,
    session_repositories: sessionRepos,
    session_cwds: sessionCwds,
  };
}

export function pruneExecute(
  cutoffMs: number,
  syncedOnly: boolean,
): PruneResult {
  const db = getDb();
  const cutoffNs = cutoffMs * 1_000_000;

  let logWhere = "WHERE timestamp_ns < ?";
  let metricWhere = "WHERE timestamp_ns < ?";
  let hookWhere = "WHERE timestamp_ms < ?";
  const logParams: number[] = [cutoffNs];
  const metricParams: number[] = [cutoffNs];
  const hookParams: number[] = [cutoffMs];

  if (syncedOnly) {
    const logWm = readWatermark("otel_logs_last_id") ?? 0;
    const metricWm = readWatermark("otel_metrics_last_id") ?? 0;
    const hookWm = readWatermark("hook_events_last_id") ?? 0;

    logWhere += " AND id <= ?";
    metricWhere += " AND id <= ?";
    hookWhere += " AND id <= ?";
    logParams.push(logWm);
    metricParams.push(metricWm);
    hookParams.push(hookWm);
  }

  const tx = db.transaction(() => {
    const logs = db
      .prepare(`DELETE FROM otel_logs ${logWhere}`)
      .run(...logParams).changes;
    const metrics = db
      .prepare(`DELETE FROM otel_metrics ${metricWhere}`)
      .run(...metricParams).changes;

    // Delete from FTS5 index before deleting from hook_events
    db.prepare(
      `DELETE FROM hook_events_fts WHERE rowid IN (SELECT id FROM hook_events ${hookWhere})`,
    ).run(...hookParams);

    const hooks = db
      .prepare(`DELETE FROM hook_events ${hookWhere}`)
      .run(...hookParams).changes;

    const sessionRepos = db
      .prepare("DELETE FROM session_repositories WHERE first_seen_ms < ?")
      .run(cutoffMs).changes;
    const sessionCwds = db
      .prepare("DELETE FROM session_cwds WHERE first_seen_ms < ?")
      .run(cutoffMs).changes;

    return {
      otel_logs: logs,
      otel_metrics: metrics,
      hook_events: hooks,
      session_repositories: sessionRepos,
      session_cwds: sessionCwds,
    };
  });

  return tx();
}

export function autoPrune(maxAgeDays: number, maxSizeMb: number): void {
  let sizeBytes: number;
  try {
    sizeBytes = fs.statSync(config.dbPath).size;
  } catch {
    return; // DB file doesn't exist yet
  }

  if (sizeBytes / (1024 * 1024) <= maxSizeMb) return;

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  pruneExecute(cutoffMs, true);
}
