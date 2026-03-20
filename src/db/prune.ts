import fs from "node:fs";
import { config } from "../config.js";
import { getDb } from "./schema.js";

export interface PruneResult {
  otel_logs: number;
  otel_metrics: number;
  hook_events: number;
  session_repositories: number;
  session_cwds: number;
}

export function pruneEstimate(cutoffMs: number): PruneResult {
  const db = getDb();
  const cutoffNs = cutoffMs * 1_000_000;

  const logs = (
    db
      .prepare("SELECT COUNT(*) as c FROM otel_logs WHERE timestamp_ns < ?")
      .get(cutoffNs) as { c: number }
  ).c;
  const metrics = (
    db
      .prepare("SELECT COUNT(*) as c FROM otel_metrics WHERE timestamp_ns < ?")
      .get(cutoffNs) as { c: number }
  ).c;
  const hooks = (
    db
      .prepare("SELECT COUNT(*) as c FROM hook_events WHERE timestamp_ms < ?")
      .get(cutoffMs) as { c: number }
  ).c;
  const sessionRepos = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM session_repositories WHERE first_seen_ms < ?",
      )
      .get(cutoffMs) as { c: number }
  ).c;
  const sessionCwds = (
    db
      .prepare("SELECT COUNT(*) as c FROM session_cwds WHERE first_seen_ms < ?")
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

export function pruneExecute(cutoffMs: number): PruneResult {
  const db = getDb();
  const cutoffNs = cutoffMs * 1_000_000;

  const tx = db.transaction(() => {
    const logs = db
      .prepare("DELETE FROM otel_logs WHERE timestamp_ns < ?")
      .run(cutoffNs).changes;
    const metrics = db
      .prepare("DELETE FROM otel_metrics WHERE timestamp_ns < ?")
      .run(cutoffNs).changes;

    // Delete from FTS5 index before deleting from hook_events
    db.prepare(
      "DELETE FROM hook_events_fts WHERE rowid IN (SELECT id FROM hook_events WHERE timestamp_ms < ?)",
    ).run(cutoffMs);

    const hooks = db
      .prepare("DELETE FROM hook_events WHERE timestamp_ms < ?")
      .run(cutoffMs).changes;

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
  pruneExecute(cutoffMs);
}
