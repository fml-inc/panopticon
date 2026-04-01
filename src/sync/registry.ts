import { clearSessionDirtyFlags } from "../db/store.js";
import {
  readDirtySessions,
  readHookEvents,
  readMetrics,
  readOtelLogs,
  readOtelSpans,
  readRepoConfigSnapshots,
  readScannerEvents,
  readScannerTurns,
  readUserConfigSnapshots,
} from "./reader.js";
import {
  serializeHookEvents,
  serializeMetrics,
  serializeOtelLogs,
  serializeOtelSpans,
  serializeScannerEvents,
  serializeScannerTurns,
} from "./serialize.js";
import type {
  HookEventRecord,
  MetricRow,
  OtelLogRecord,
  OtelSpanRecord,
  RepoConfigSnapshotRecord,
  ScannerEventRecord,
  ScannerTurnRecord,
  SessionSyncRecord,
  TableSyncDescriptor,
  UserConfigSnapshotRecord,
} from "./types.js";

/**
 * Ordered list of table sync descriptors. The order matches the
 * round-robin execution order in the sync loop.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TABLE_SYNC_REGISTRY: TableSyncDescriptor<any>[] = [
  // ── OTLP tables (standard collector compatible) ───────────────────────────

  {
    table: "hook_events",
    logNoun: "events",
    capability: "otlp",
    read: (afterId, limit, _ctx) => readHookEvents(afterId, limit),
    serialize: (rows) => serializeHookEvents(rows),
    endpoint: "/v1/logs",
    extractRepo: (row) => row.repository,
  } satisfies TableSyncDescriptor<HookEventRecord>,

  {
    table: "otel_logs",
    logNoun: "logs",
    capability: "otlp",
    read: (afterId, limit, ctx) =>
      readOtelLogs(afterId, limit, ctx.hooksInstalled),
    serialize: (rows) => serializeOtelLogs(rows),
    endpoint: "/v1/logs",
    extractRepo: (row) =>
      (row.resourceAttributes?.["repository.full_name"] as string) ?? null,
  } satisfies TableSyncDescriptor<OtelLogRecord>,

  {
    table: "otel_metrics",
    logNoun: "metrics",
    capability: "otlp",
    read: (afterId, limit, _ctx) => readMetrics(afterId, limit),
    serialize: (rows) => serializeMetrics(rows),
    endpoint: "/v1/metrics",
    extractRepo: (row) =>
      (row.resourceAttributes?.["repository.full_name"] as string) ?? null,
  } satisfies TableSyncDescriptor<MetricRow>,

  {
    table: "scanner_turns",
    logNoun: "turns",
    capability: "otlp",
    read: (afterId, limit, _ctx) => readScannerTurns(afterId, limit),
    serialize: (rows) => serializeScannerTurns(rows),
    endpoint: "/v1/logs",
  } satisfies TableSyncDescriptor<ScannerTurnRecord>,

  {
    table: "scanner_events",
    logNoun: "events",
    capability: "otlp",
    read: (afterId, limit, _ctx) => readScannerEvents(afterId, limit),
    serialize: (rows) => serializeScannerEvents(rows),
    endpoint: "/v1/logs",
  } satisfies TableSyncDescriptor<ScannerEventRecord>,

  {
    table: "otel_spans",
    logNoun: "spans",
    capability: "otlp",
    read: (afterId, limit, _ctx) => readOtelSpans(afterId, limit),
    serialize: (rows) => serializeOtelSpans(rows),
    endpoint: "/v1/traces",
  } satisfies TableSyncDescriptor<OtelSpanRecord>,

  // ── API tables (plain JSON, fml backend) ──────────────────────────────────

  {
    table: "user_config_snapshots",
    logNoun: "snapshots",
    capability: "api",
    read: (afterId, limit, _ctx) => readUserConfigSnapshots(afterId, limit),
    serialize: (rows) => rows,
    endpoint: "/v1/user-config-snapshots",
  } satisfies TableSyncDescriptor<UserConfigSnapshotRecord>,

  {
    table: "repo_config_snapshots",
    logNoun: "snapshots",
    capability: "api",
    read: (afterId, limit, _ctx) => readRepoConfigSnapshots(afterId, limit),
    serialize: (rows) => rows,
    endpoint: "/v1/repo-config-snapshots",
    extractRepo: (row) => row.repository,
  } satisfies TableSyncDescriptor<RepoConfigSnapshotRecord>,

  {
    table: "sessions",
    logNoun: "sessions",
    capability: "api",
    dirtyFlag: true,
    read: (_afterId, limit, _ctx) => readDirtySessions(0, limit),
    serialize: (rows) => rows,
    endpoint: "/v1/sessions",
    clearDirty: (rows) => {
      const ids = rows.map((r) => r.sessionId);
      if (ids.length > 0) clearSessionDirtyFlags(ids);
    },
  } satisfies TableSyncDescriptor<SessionSyncRecord>,
];
