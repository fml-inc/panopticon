import {
  readHookEvents,
  readMetrics,
  readOtelLogs,
  readOtelSpans,
  readScannerEvents,
  readScannerTurns,
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
  ScannerEventRecord,
  ScannerTurnRecord,
  TableSyncDescriptor,
} from "./types.js";

/**
 * Ordered list of table sync descriptors. The order matches the
 * round-robin execution order in the sync loop.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TABLE_SYNC_REGISTRY: TableSyncDescriptor<any>[] = [
  {
    table: "hook_events",
    logNoun: "events",
    read: (afterId, limit, _ctx) => readHookEvents(afterId, limit),
    serialize: (rows) => serializeHookEvents(rows),
    endpoint: "/v1/logs",
    extractRepo: (row) => row.repository,
  } satisfies TableSyncDescriptor<HookEventRecord>,

  {
    table: "otel_logs",
    logNoun: "logs",
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
    read: (afterId, limit, _ctx) => readMetrics(afterId, limit),
    serialize: (rows) => serializeMetrics(rows),
    endpoint: "/v1/metrics",
    extractRepo: (row) =>
      (row.resourceAttributes?.["repository.full_name"] as string) ?? null,
  } satisfies TableSyncDescriptor<MetricRow>,

  {
    table: "scanner_turns",
    logNoun: "turns",
    read: (afterId, limit, _ctx) => readScannerTurns(afterId, limit),
    serialize: (rows) => serializeScannerTurns(rows),
    endpoint: "/v1/logs",
  } satisfies TableSyncDescriptor<ScannerTurnRecord>,

  {
    table: "scanner_events",
    logNoun: "events",
    read: (afterId, limit, _ctx) => readScannerEvents(afterId, limit),
    serialize: (rows) => serializeScannerEvents(rows),
    endpoint: "/v1/logs",
  } satisfies TableSyncDescriptor<ScannerEventRecord>,

  {
    table: "otel_spans",
    logNoun: "spans",
    read: (afterId, limit, _ctx) => readOtelSpans(afterId, limit),
    serialize: (rows) => serializeOtelSpans(rows),
    endpoint: "/v1/traces",
  } satisfies TableSyncDescriptor<OtelSpanRecord>,
];
