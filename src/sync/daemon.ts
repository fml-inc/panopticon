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

function lookupSessionRepo(sessionId: string): string | undefined {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT repository FROM session_repositories WHERE session_id = ? LIMIT 1",
    )
    .get(sessionId) as { repository: string } | undefined;
  return row?.repository;
}

function lookupSessionCwd(sessionId: string): string | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT cwd FROM session_cwds WHERE session_id = ? LIMIT 1")
    .get(sessionId) as { cwd: string } | undefined;
  return row?.cwd;
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
  // then stamp orgName and pair each entry with its original row ID.
  const tagged = rows.map((row) => {
    const event = mapHookEvent(row);
    event.orgName = resolveOrgName(
      event.repositoryFullName,
      event.cwd,
      syncConfig.orgDirs,
    );
    return { event, rowId: row.id };
  });

  // Batch the original rows, filter within each batch, and advance
  // watermark per-batch so retries don't re-send successful batches.
  const batches = chunk(tagged, HOOK_EVENTS_BATCH_LIMIT);
  const url = `${target.url.replace(/\/$/, "")}/panopticon/ingest-batch`;

  for (const batch of batches) {
    const filtered = batch
      .filter(({ event }) =>
        isAllowedOrg(
          event.repositoryFullName,
          syncConfig.allowedOrgs,
          event.cwd,
          syncConfig.orgDirs,
        ),
      )
      .map(({ event }) => event);

    if (filtered.length > 0 && syncConfig.backendType !== "otlp") {
      await postBatch(url, { events: filtered }, token);
    }

    // Advance watermark after each successful batch (including filtered-out rows)
    const lastId = batch[batch.length - 1].rowId;
    writeWatermark(wmKey, lastId);
  }

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

  // Map and backfill repositoryFullName / orgName, paired with original row IDs
  const tagged = rows.map((row) => {
    const entry = mapOtelLog(row);
    if (!entry.repositoryFullName) {
      const repo = lookupSessionRepo(entry.sessionId);
      if (repo) entry.repositoryFullName = repo;
    }
    const cwd = entry.repositoryFullName
      ? undefined
      : lookupSessionCwd(entry.sessionId);
    entry.orgName = resolveOrgName(
      entry.repositoryFullName,
      cwd,
      syncConfig.orgDirs,
    );
    return { entry, rowId: row.id };
  });

  // Batch the original rows, filter within each batch, and advance
  // watermark per-batch so retries don't re-send successful batches.
  const batches = chunk(tagged, OTEL_LOGS_BATCH_LIMIT);
  const url = `${target.url.replace(/\/$/, "")}/panopticon/ingest-logs`;

  for (const batch of batches) {
    const filtered = batch
      .filter(({ entry }) => {
        const cwd = entry.repositoryFullName
          ? undefined
          : lookupSessionCwd(entry.sessionId);
        return isAllowedOrg(
          entry.repositoryFullName,
          syncConfig.allowedOrgs,
          cwd,
          syncConfig.orgDirs,
        );
      })
      .map(({ entry }) => entry);

    if (filtered.length > 0) {
      if (syncConfig.backendType === "otlp") {
        const otlpUrl = `${target.url.replace(/\/$/, "")}/v1/logs`;
        const payload = {
          resourceLogs: [
            {
              resource: { attributes: [] },
              scopeLogs: [
                {
                  logRecords: filtered.map((l) => ({
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
        await postBatch(url, { logs: filtered }, token);
      }
    }

    // Advance watermark after each successful batch (including filtered-out rows)
    const lastId = batch[batch.length - 1].rowId;
    writeWatermark(wmKey, lastId);
  }

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

  // Map and backfill repositoryFullName / orgName, paired with original row IDs
  const tagged = rows.map((row) => {
    const entry = mapOtelMetric(row);
    if (!entry.repositoryFullName) {
      const repo = lookupSessionRepo(entry.sessionId);
      if (repo) entry.repositoryFullName = repo;
    }
    const cwd = entry.repositoryFullName
      ? undefined
      : lookupSessionCwd(entry.sessionId);
    entry.orgName = resolveOrgName(
      entry.repositoryFullName,
      cwd,
      syncConfig.orgDirs,
    );
    return { entry, rowId: row.id };
  });

  // Batch the original rows, filter within each batch, and advance
  // watermark per-batch so retries don't re-send successful batches.
  const batches = chunk(tagged, OTEL_METRICS_BATCH_LIMIT);
  const url = `${target.url.replace(/\/$/, "")}/panopticon/ingest-metrics`;

  for (const batch of batches) {
    const filtered = batch
      .filter(({ entry }) => {
        const cwd = entry.repositoryFullName
          ? undefined
          : lookupSessionCwd(entry.sessionId);
        return isAllowedOrg(
          entry.repositoryFullName,
          syncConfig.allowedOrgs,
          cwd,
          syncConfig.orgDirs,
        );
      })
      .map(({ entry }) => entry);

    if (filtered.length > 0) {
      if (syncConfig.backendType === "otlp") {
        const otlpUrl = `${target.url.replace(/\/$/, "")}/v1/metrics`;
        const payload = {
          resourceMetrics: [
            {
              resource: { attributes: [] },
              scopeMetrics: [
                {
                  metrics: filtered.map((m) => ({
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
        await postBatch(url, { metrics: filtered }, token);
      }
    }

    // Advance watermark after each successful batch (including filtered-out rows)
    const lastId = batch[batch.length - 1].rowId;
    writeWatermark(wmKey, lastId);
  }

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
  const DEFAULT_INTERVAL_MS = 30000;

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

  const initialConfig = loadSyncConfig();
  if (initialConfig) {
    console.log(
      `[sync] Starting daemon — targets: ${initialConfig.targets.map((t) => `${t.name}(${t.url})`).join(", ")}, interval: ${initialConfig.intervalMs ?? DEFAULT_INTERVAL_MS}ms`,
    );
  } else {
    console.log(
      "[sync] Starting daemon — no sync config yet, waiting for 'panopticon sync setup'",
    );
  }

  // Main loop — reload config each cycle so setup changes are picked up
  while (true) {
    const syncConfig = loadSyncConfig();
    if (syncConfig) {
      try {
        await runOnce(syncConfig);
      } catch (err) {
        console.error(
          "[sync] Cycle error:",
          err instanceof Error ? err.message : err,
        );
      }
      await new Promise((r) =>
        setTimeout(r, syncConfig.intervalMs ?? DEFAULT_INTERVAL_MS),
      );
    } else {
      // No config — idle and re-check periodically
      await new Promise((r) => setTimeout(r, DEFAULT_INTERVAL_MS));
    }
  }
}

main().catch((err) => {
  console.error("[sync] Fatal error:", err);
  process.exit(1);
});
