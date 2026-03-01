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
import { readWatermark, watermarkKey, writeWatermark } from "./state.js";

export interface SyncTarget {
  name: string; // e.g. "dev", "prod"
  url: string;
}

interface SyncConfig {
  backendType?: "fml" | "otlp";
  targets: SyncTarget[];
  allowedOrgs?: string[];
  /** Maps directory paths to GitHub org names, e.g. {"/Users/gus/workspace/fml-inc": "fml-inc"} */
  orgDirs?: Record<string, string>;
  batchSize?: number;
  intervalMs?: number;
}

const HOOK_EVENTS_BATCH_LIMIT = 25;
const OTEL_LOGS_BATCH_LIMIT = 25;
const OTEL_METRICS_BATCH_LIMIT = 50;

const WATERMARK_TABLES = [
  "hook_events_last_id",
  "otel_logs_last_id",
  "otel_metrics_last_id",
];

function loadSyncConfig(): SyncConfig | null {
  try {
    const raw = fs.readFileSync(config.syncConfigFile, "utf-8");
    const parsed = JSON.parse(raw);

    // Auto-migrate old urls[] format → targets[]
    if (Array.isArray(parsed.urls) && !Array.isArray(parsed.targets)) {
      parsed.targets = parsed.urls.map((url: string, i: number) => ({
        name: i === 0 ? "default" : `target-${i}`,
        url,
      }));
      delete parsed.urls;

      // Rewrite config file with new format
      fs.writeFileSync(
        config.syncConfigFile,
        `${JSON.stringify(parsed, null, 2)}\n`,
      );

      // Migrate watermark keys: copy old keys → :default suffix
      for (const table of WATERMARK_TABLES) {
        const existing = readWatermark(table);
        if (existing !== null) {
          writeWatermark(watermarkKey(table, "default"), existing);
        }
      }
    }

    if (!Array.isArray(parsed.targets) || parsed.targets.length === 0)
      return null;
    return parsed as SyncConfig;
  } catch {
    return null;
  }
}

/**
 * Resolve the org for a cwd using the orgDirs config.
 * Returns the org name if cwd falls under a configured orgDir, undefined otherwise.
 */
function resolveOrgFromCwd(
  cwd: string,
  orgDirs: Record<string, string> | undefined,
): string | undefined {
  if (!orgDirs) return undefined;
  // Normalize: ensure no trailing slash for comparison
  const normalizedCwd = cwd.replace(/\/+$/, "");
  for (const [dir, org] of Object.entries(orgDirs)) {
    const normalizedDir = dir.replace(/\/+$/, "");
    if (
      normalizedCwd === normalizedDir ||
      normalizedCwd.startsWith(`${normalizedDir}/`)
    ) {
      return org;
    }
  }
  return undefined;
}

/**
 * Resolve the orgName for an event/entry.
 * Prefers repositoryFullName (split to get org), falls back to cwd-based org resolution.
 */
function resolveOrgName(
  repositoryFullName: string | undefined,
  cwd: string | undefined,
  orgDirs: Record<string, string> | undefined,
): string | undefined {
  if (repositoryFullName) return repositoryFullName.split("/")[0];
  if (cwd) return resolveOrgFromCwd(cwd, orgDirs);
  return undefined;
}

function isAllowedOrg(
  repository: string | undefined,
  allowedOrgs: string[] | undefined,
  cwd?: string,
  orgDirs?: Record<string, string>,
): boolean {
  if (!allowedOrgs || allowedOrgs.length === 0) return false;
  if (allowedOrgs.includes("*")) return true;
  if (repository) {
    const org = repository.split("/")[0];
    return allowedOrgs.includes(org);
  }
  // No repository — check if cwd falls under a configured orgDir
  if (cwd) {
    const org = resolveOrgFromCwd(cwd, orgDirs);
    return org !== undefined && allowedOrgs.includes(org);
  }
  return false;
}

interface SessionMaps {
  repoMap: Map<string, string>;
  cwdMap: Map<string, string>;
}

/**
 * Build mappings from session_id → resolved "org/repo" and session_id → cwd
 * by looking up hook_events rows for the given session IDs.
 * Used to backfill repo/cwd info on OTel rows which lack those fields.
 */
function buildSessionMaps(sessionIds: string[]): SessionMaps {
  if (sessionIds.length === 0) return { repoMap: new Map(), cwdMap: new Map() };
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

  const repoMap = new Map<string, string>();
  const cwdMap = new Map<string, string>();
  for (const row of rows) {
    if (!repoMap.has(row.session_id)) {
      const repo =
        row.repository || (row.cwd ? resolveRepoFromCwd(row.cwd) : null);
      if (repo) repoMap.set(row.session_id, repo);
    }
    if (!cwdMap.has(row.session_id) && row.cwd) {
      cwdMap.set(row.session_id, row.cwd);
    }
  }
  return { repoMap, cwdMap };
}

async function syncHookEvents(
  syncConfig: SyncConfig,
  target: SyncTarget,
  token: string,
  batchSize: number,
): Promise<boolean> {
  const db = getDb();
  const wmKey = watermarkKey("hook_events_last_id", target.name);
  const watermark = readWatermark(wmKey) ?? 0;

  const rows = db
    .prepare(
      "SELECT id, session_id, event_type, timestamp_ms, cwd, repository, tool_name, decompress(payload) as payload FROM hook_events WHERE id > ? ORDER BY id LIMIT ?",
    )
    .all(watermark, batchSize) as HookEventDbRow[];

  if (rows.length === 0) return false;

  // Map first (resolves repo from cwd when row.repository is empty),
  // then stamp orgName and filter on the resolved repositoryFullName.
  const events = rows.map(mapHookEvent);
  for (const e of events) {
    e.orgName = resolveOrgName(e.repositoryFullName, e.cwd, syncConfig.orgDirs);
  }
  const filtered = events.filter((e) =>
    isAllowedOrg(
      e.repositoryFullName,
      syncConfig.allowedOrgs,
      e.cwd,
      syncConfig.orgDirs,
    ),
  );

  if (filtered.length > 0) {
    const batches = chunk(filtered, HOOK_EVENTS_BATCH_LIMIT);
    const url = `${target.url.replace(/\/$/, "")}/panopticon/ingest-batch`;

    for (const batch of batches) {
      if (syncConfig.backendType === "otlp") continue;
      await postBatch(url, { events: batch }, token);
    }
  }

  // Advance watermark to the last row we processed (even if filtered out)
  const lastId = rows[rows.length - 1].id;
  writeWatermark(wmKey, lastId);

  return rows.length === batchSize;
}

async function syncOtelLogs(
  syncConfig: SyncConfig,
  target: SyncTarget,
  token: string,
  batchSize: number,
): Promise<boolean> {
  const db = getDb();
  const wmKey = watermarkKey("otel_logs_last_id", target.name);
  const watermark = readWatermark(wmKey) ?? 0;

  const rows = db
    .prepare(
      "SELECT id, timestamp_ns, severity_text, body, attributes, resource_attributes, session_id, prompt_id, trace_id, span_id FROM otel_logs WHERE id > ? ORDER BY id LIMIT ?",
    )
    .all(watermark, batchSize) as OtelLogDbRow[];

  if (rows.length === 0) return false;

  const mapped = rows.map(mapOtelLog);

  // Backfill repositoryFullName from hook_events for rows missing it
  const needsRepo = mapped.filter((l) => !l.repositoryFullName);
  let sessionCwdMap = new Map<string, string>();
  if (needsRepo.length > 0) {
    const sessionIds = [...new Set(needsRepo.map((l) => l.sessionId))];
    const { repoMap, cwdMap } = buildSessionMaps(sessionIds);
    sessionCwdMap = cwdMap;
    for (const entry of needsRepo) {
      const repo = repoMap.get(entry.sessionId);
      if (repo) entry.repositoryFullName = repo;
    }
  }

  // Stamp orgName using repo or cwd fallback
  for (const entry of mapped) {
    const cwd = entry.repositoryFullName
      ? undefined
      : sessionCwdMap.get(entry.sessionId);
    entry.orgName = resolveOrgName(
      entry.repositoryFullName,
      cwd,
      syncConfig.orgDirs,
    );
  }

  const filtered = mapped.filter((l) =>
    isAllowedOrg(
      l.repositoryFullName,
      syncConfig.allowedOrgs,
      l.repositoryFullName ? undefined : sessionCwdMap.get(l.sessionId),
      syncConfig.orgDirs,
    ),
  );

  if (filtered.length > 0) {
    const batches = chunk(filtered, OTEL_LOGS_BATCH_LIMIT);
    const url = `${target.url.replace(/\/$/, "")}/panopticon/ingest-logs`;

    for (const batch of batches) {
      if (syncConfig.backendType === "otlp") {
        const otlpUrl = `${target.url.replace(/\/$/, "")}/v1/logs`;
        const payload = {
          resourceLogs: [
            {
              resource: { attributes: [] },
              scopeLogs: [
                {
                  logRecords: batch.map((l) => ({
                    timeUnixNano: (l.timestampMs * 1000000).toString(),
                    severityText: l.severityText,
                    body: { stringValue: l.body },
                    traceId: l.traceId,
                    spanId: l.spanId,
                  })),
                },
              ],
            },
          ],
        };
        await postBatch(otlpUrl, payload, token);
      } else {
        await postBatch(url, { logs: batch }, token);
      }
    }
  }

  const lastId = rows[rows.length - 1].id;
  writeWatermark(wmKey, lastId);

  return rows.length === batchSize;
}

async function syncOtelMetrics(
  syncConfig: SyncConfig,
  target: SyncTarget,
  token: string,
  batchSize: number,
): Promise<boolean> {
  const db = getDb();
  const wmKey = watermarkKey("otel_metrics_last_id", target.name);
  const watermark = readWatermark(wmKey) ?? 0;

  const rows = db
    .prepare(
      "SELECT id, timestamp_ns, name, value, unit, attributes, resource_attributes, session_id FROM otel_metrics WHERE id > ? ORDER BY id LIMIT ?",
    )
    .all(watermark, batchSize) as OtelMetricDbRow[];

  if (rows.length === 0) return false;

  const mapped = rows.map(mapOtelMetric);

  // Backfill repositoryFullName from hook_events for rows missing it
  const needsRepo = mapped.filter((m) => !m.repositoryFullName);
  let sessionCwdMap = new Map<string, string>();
  if (needsRepo.length > 0) {
    const sessionIds = [...new Set(needsRepo.map((m) => m.sessionId))];
    const { repoMap, cwdMap } = buildSessionMaps(sessionIds);
    sessionCwdMap = cwdMap;
    for (const entry of needsRepo) {
      const repo = repoMap.get(entry.sessionId);
      if (repo) entry.repositoryFullName = repo;
    }
  }

  // Stamp orgName using repo or cwd fallback
  for (const entry of mapped) {
    const cwd = entry.repositoryFullName
      ? undefined
      : sessionCwdMap.get(entry.sessionId);
    entry.orgName = resolveOrgName(
      entry.repositoryFullName,
      cwd,
      syncConfig.orgDirs,
    );
  }

  const filtered = mapped.filter((m) =>
    isAllowedOrg(
      m.repositoryFullName,
      syncConfig.allowedOrgs,
      m.repositoryFullName ? undefined : sessionCwdMap.get(m.sessionId),
      syncConfig.orgDirs,
    ),
  );

  if (filtered.length > 0) {
    const batches = chunk(filtered, OTEL_METRICS_BATCH_LIMIT);
    const url = `${target.url.replace(/\/$/, "")}/panopticon/ingest-metrics`;

    for (const batch of batches) {
      if (syncConfig.backendType === "otlp") {
        const otlpUrl = `${target.url.replace(/\/$/, "")}/v1/metrics`;
        const payload = {
          resourceMetrics: [
            {
              resource: { attributes: [] },
              scopeMetrics: [
                {
                  metrics: batch.map((m) => ({
                    name: m.name,
                    unit: m.unit,
                    gauge: {
                      dataPoints: [
                        {
                          timeUnixNano: (m.timestampMs * 1000000).toString(),
                          asDouble: m.value,
                        },
                      ],
                    },
                  })),
                },
              ],
            },
          ],
        };
        await postBatch(otlpUrl, payload, token);
      } else {
        await postBatch(url, { metrics: batch }, token);
      }
    }
  }

  const lastId = rows[rows.length - 1].id;
  writeWatermark(wmKey, lastId);

  return rows.length === batchSize;
}

async function runOnce(syncConfig: SyncConfig): Promise<void> {
  const token = resolveGitHubToken();
  if (!token) {
    console.error("[sync] No GitHub token available, skipping cycle");
    return;
  }

  const batchSize = syncConfig.batchSize ?? 20;

  // Drain each table per target — each target tracks its own watermarks
  // Errors for one target don't block others
  for (const target of syncConfig.targets) {
    try {
      let moreHooks = true;
      while (moreHooks) {
        moreHooks = await syncHookEvents(syncConfig, target, token, batchSize);
      }

      let moreLogs = true;
      while (moreLogs) {
        moreLogs = await syncOtelLogs(syncConfig, target, token, batchSize);
      }

      let moreMetrics = true;
      while (moreMetrics) {
        moreMetrics = await syncOtelMetrics(
          syncConfig,
          target,
          token,
          batchSize,
        );
      }
    } catch (err) {
      console.error(
        `[sync] Error syncing to ${target.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
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
    `[sync] Starting daemon — targets: ${syncConfig.targets.map((t) => `${t.name}(${t.url})`).join(", ")}, interval: ${intervalMs}ms`,
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
  process.on("SIGHUP", shutdown);

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
