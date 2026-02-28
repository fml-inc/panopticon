#!/usr/bin/env node

/**
 * Sync daemon: polls SQLite tables and POSTs to FML Convex backend.
 * Runs as a detached background process.
 */

import fs from "node:fs";
import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { chunk, postBatch, resolveGitHubToken } from "./client.js";
import {
  type HookEventDbRow,
  mapHookEvent,
  mapOtelLog,
  mapOtelMetric,
  type OtelLogDbRow,
  type OtelMetricDbRow,
  resolveRepoFromCwd,
} from "./mapper.js";
import { readWatermark, writeWatermark } from "./state.js";

interface SyncConfig {
  urls: string[];
  allowedOrgs?: string[];
  batchSize?: number;
  intervalMs?: number;
}

const HOOK_EVENTS_BATCH_LIMIT = 25;
const OTEL_LOGS_BATCH_LIMIT = 25;
const OTEL_METRICS_BATCH_LIMIT = 50;

function loadSyncConfig(): SyncConfig | null {
  try {
    const raw = fs.readFileSync(config.syncConfigFile, "utf-8");
    const parsed = JSON.parse(raw) as SyncConfig;
    if (!Array.isArray(parsed.urls) || parsed.urls.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isAllowedOrg(
  repository: string | undefined,
  allowedOrgs: string[] | undefined,
): boolean {
  if (!allowedOrgs || allowedOrgs.length === 0) return true;
  if (!repository) return false;
  const org = repository.split("/")[0];
  return allowedOrgs.includes(org);
}

/**
 * Build a mapping from session_id → resolved "org/repo" by looking up
 * hook_events rows for the given session IDs.  Used to backfill repo info
 * on OTel rows which lack cwd/repository fields.
 */
function buildSessionRepoMap(sessionIds: string[]): Map<string, string> {
  if (sessionIds.length === 0) return new Map();
  const db = getDb();
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT session_id, cwd, repository FROM hook_events WHERE session_id IN (${placeholders})`,
    )
    .all(...sessionIds) as {
    session_id: string;
    cwd: string | null;
    repository: string | null;
  }[];

  const map = new Map<string, string>();
  for (const row of rows) {
    if (map.has(row.session_id)) continue;
    const repo =
      row.repository || (row.cwd ? resolveRepoFromCwd(row.cwd) : null);
    if (repo) map.set(row.session_id, repo);
  }
  return map;
}

async function syncHookEvents(
  syncConfig: SyncConfig,
  token: string,
  batchSize: number,
): Promise<boolean> {
  const db = getDb();
  const watermark = readWatermark("hook_events_last_id") ?? 0;

  const rows = db
    .prepare(
      "SELECT id, session_id, event_type, timestamp_ms, cwd, repository, tool_name, decompress(payload) as payload FROM hook_events WHERE id > ? ORDER BY id LIMIT ?",
    )
    .all(watermark, batchSize) as HookEventDbRow[];

  if (rows.length === 0) return false;

  // Map first (resolves repo from cwd when row.repository is empty),
  // then filter on the resolved repositoryFullName.
  const events = rows.map(mapHookEvent);
  const filtered = events.filter((e) =>
    isAllowedOrg(e.repositoryFullName, syncConfig.allowedOrgs),
  );

  if (filtered.length > 0) {
    const batches = chunk(filtered, HOOK_EVENTS_BATCH_LIMIT);

    for (const batch of batches) {
      for (const baseUrl of syncConfig.urls) {
        const url = `${baseUrl.replace(/\/$/, "")}/panopticon/ingest-batch`;
        await postBatch(url, { events: batch }, token);
      }
    }
  }

  // Advance watermark to the last row we processed (even if filtered out)
  const lastId = rows[rows.length - 1].id;
  writeWatermark("hook_events_last_id", lastId);

  return rows.length === batchSize;
}

async function syncOtelLogs(
  syncConfig: SyncConfig,
  token: string,
  batchSize: number,
): Promise<boolean> {
  const db = getDb();
  const watermark = readWatermark("otel_logs_last_id") ?? 0;

  const rows = db
    .prepare(
      "SELECT id, timestamp_ns, severity_text, body, attributes, resource_attributes, session_id, prompt_id, trace_id, span_id FROM otel_logs WHERE id > ? ORDER BY id LIMIT ?",
    )
    .all(watermark, batchSize) as OtelLogDbRow[];

  if (rows.length === 0) return false;

  const mapped = rows.map(mapOtelLog);

  // Backfill repositoryFullName from hook_events for rows missing it
  const needsRepo = mapped.filter((l) => !l.repositoryFullName);
  if (needsRepo.length > 0) {
    const sessionIds = [...new Set(needsRepo.map((l) => l.sessionId))];
    const sessionRepoMap = buildSessionRepoMap(sessionIds);
    for (const entry of needsRepo) {
      const repo = sessionRepoMap.get(entry.sessionId);
      if (repo) entry.repositoryFullName = repo;
    }
  }

  const filtered = mapped.filter((l) =>
    isAllowedOrg(l.repositoryFullName, syncConfig.allowedOrgs),
  );

  if (filtered.length > 0) {
    const batches = chunk(filtered, OTEL_LOGS_BATCH_LIMIT);

    for (const batch of batches) {
      for (const baseUrl of syncConfig.urls) {
        const url = `${baseUrl.replace(/\/$/, "")}/panopticon/ingest-logs`;
        await postBatch(url, { logs: batch }, token);
      }
    }
  }

  const lastId = rows[rows.length - 1].id;
  writeWatermark("otel_logs_last_id", lastId);

  return rows.length === batchSize;
}

async function syncOtelMetrics(
  syncConfig: SyncConfig,
  token: string,
  batchSize: number,
): Promise<boolean> {
  const db = getDb();
  const watermark = readWatermark("otel_metrics_last_id") ?? 0;

  const rows = db
    .prepare(
      "SELECT id, timestamp_ns, name, value, unit, attributes, resource_attributes, session_id FROM otel_metrics WHERE id > ? ORDER BY id LIMIT ?",
    )
    .all(watermark, batchSize) as OtelMetricDbRow[];

  if (rows.length === 0) return false;

  const mapped = rows.map(mapOtelMetric);

  // Backfill repositoryFullName from hook_events for rows missing it
  const needsRepo = mapped.filter((m) => !m.repositoryFullName);
  if (needsRepo.length > 0) {
    const sessionIds = [...new Set(needsRepo.map((m) => m.sessionId))];
    const sessionRepoMap = buildSessionRepoMap(sessionIds);
    for (const entry of needsRepo) {
      const repo = sessionRepoMap.get(entry.sessionId);
      if (repo) entry.repositoryFullName = repo;
    }
  }

  const filtered = mapped.filter((m) =>
    isAllowedOrg(m.repositoryFullName, syncConfig.allowedOrgs),
  );

  if (filtered.length > 0) {
    const batches = chunk(filtered, OTEL_METRICS_BATCH_LIMIT);

    for (const batch of batches) {
      for (const baseUrl of syncConfig.urls) {
        const url = `${baseUrl.replace(/\/$/, "")}/panopticon/ingest-metrics`;
        await postBatch(url, { metrics: batch }, token);
      }
    }
  }

  const lastId = rows[rows.length - 1].id;
  writeWatermark("otel_metrics_last_id", lastId);

  return rows.length === batchSize;
}

async function runOnce(syncConfig: SyncConfig): Promise<void> {
  const token = resolveGitHubToken();
  if (!token) {
    console.error("[sync] No GitHub token available, skipping cycle");
    return;
  }

  const batchSize = syncConfig.batchSize ?? 20;

  // Drain each table — keep going while there's a full batch
  let moreHooks = true;
  while (moreHooks) {
    moreHooks = await syncHookEvents(syncConfig, token, batchSize);
  }

  let moreLogs = true;
  while (moreLogs) {
    moreLogs = await syncOtelLogs(syncConfig, token, batchSize);
  }

  let moreMetrics = true;
  while (moreMetrics) {
    moreMetrics = await syncOtelMetrics(syncConfig, token, batchSize);
  }
}

async function main() {
  const syncConfig = loadSyncConfig();
  if (!syncConfig) {
    console.error(
      "[sync] No sync config found. Run 'panopticon sync setup' first.",
    );
    process.exit(1);
  }

  const intervalMs = syncConfig.intervalMs ?? 30000;

  console.log(
    `[sync] Starting daemon — targets: ${syncConfig.urls.join(", ")}, interval: ${intervalMs}ms`,
  );

  // Write PID file
  fs.writeFileSync(config.syncPidFile, String(process.pid));

  const shutdown = () => {
    console.log("[sync] Shutting down...");
    try {
      fs.unlinkSync(config.syncPidFile);
    } catch {}
    closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Main loop
  while (true) {
    try {
      await runOnce(syncConfig);
    } catch (err) {
      console.error(
        "[sync] Cycle error:",
        err instanceof Error ? err.message : err,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((err) => {
  console.error("[sync] Fatal error:", err);
  process.exit(1);
});
