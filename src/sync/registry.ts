import {
  readHookEvents,
  readMessages,
  readMetrics,
  readOtelLogs,
  readOtelSpans,
  readRepoConfigSnapshots,
  readScannerEvents,
  readScannerTurns,
  readSessions,
  readToolCalls,
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
  MessageSyncRecord,
  MetricRow,
  OtelLogRecord,
  OtelSpanRecord,
  RepoConfigSnapshotRecord,
  ScannerEventRecord,
  ScannerTurnRecord,
  SessionSyncRecord,
  TableSyncDescriptor,
  ToolCallSyncRecord,
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
    table: "messages",
    logNoun: "messages",
    capability: "api",
    read: (afterId, limit, _ctx) => readMessages(afterId, limit),
    serialize: (rows) => rows,
    endpoint: "/v1/messages",
  } satisfies TableSyncDescriptor<MessageSyncRecord>,

  {
    table: "tool_calls",
    logNoun: "tool calls",
    capability: "api",
    read: (afterId, limit, _ctx) => readToolCalls(afterId, limit),
    serialize: (rows) => rows,
    endpoint: "/v1/tool-calls",
  } satisfies TableSyncDescriptor<ToolCallSyncRecord>,

  {
    table: "sessions",
    logNoun: "sessions",
    capability: "api",
    read: (afterId, limit, _ctx) => readSessions(afterId, limit),
    serialize: (rows) => rows,
    endpoint: "/v1/sessions",
  } satisfies TableSyncDescriptor<SessionSyncRecord>,
];
