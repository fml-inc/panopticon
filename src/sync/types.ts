export interface SyncTarget {
  /** Unique name for this target, used as watermark namespace */
  name: string;
  /** OTLP HTTP endpoint base URL (e.g. "https://otlp.example.com") */
  url: string;
  /** Bearer token — sent as Authorization: Bearer <token> */
  token?: string;
  /** Additional headers (merged with token auth if both provided) */
  headers?: Record<string, string>;
}

export interface SyncFilter {
  /** Only sync events matching these repo patterns (glob, e.g. "fml-inc/*") */
  includeRepos?: string[];
  /** Exclude repos matching these patterns (takes precedence over include) */
  excludeRepos?: string[];
}

export interface SyncOptions {
  targets: SyncTarget[];
  filter?: SyncFilter;
  /** Max rows read from SQLite per batch (default 2000) */
  batchSize?: number;
  /** Max records per HTTP POST (default 25) */
  postBatchSize?: number;
  /** If true, timer keeps Node alive (default false) */
  keepAlive?: boolean;
  /** Idle poll interval in ms (default 30000) */
  idleIntervalMs?: number;
  /** Catch-up poll interval in ms (default 1000) */
  catchUpIntervalMs?: number;
  /** Log function (default console.error) */
  log?: (msg: string) => void;
}

export interface SyncHandle {
  start: () => void;
  stop: () => void;
}

/** Hook event row merged with its OTLP counterpart (if any). */
export interface MergedEvent {
  hookId: number;
  sessionId: string;
  eventType: string;
  timestampMs: number;
  cwd: string | null;
  repository: string | null;
  toolName: string | null;
  payload: Record<string, unknown> | null;
  userPrompt: string | null;
  filePath: string | null;
  command: string | null;
  // From OTLP counterpart (null if unmerged)
  otelAttributes: Record<string, unknown> | null;
  otelResourceAttributes: Record<string, unknown> | null;
  otelSeverityText: string | null;
  otelPromptId: string | null;
  otelTraceId: string | null;
  otelSpanId: string | null;
}

/** OTLP log with no hook counterpart (api_request, api_error, etc.) */
export interface UnmatchedOtelLog {
  id: number;
  timestampNs: number;
  body: string | null;
  attributes: Record<string, unknown> | null;
  resourceAttributes: Record<string, unknown> | null;
  severityText: string | null;
  sessionId: string | null;
  promptId: string | null;
  traceId: string | null;
  spanId: string | null;
}

/** Metric row for serialization. */
export interface MetricRow {
  id: number;
  timestampNs: number;
  name: string;
  value: number;
  metricType: string | null;
  unit: string | null;
  attributes: Record<string, unknown> | null;
  resourceAttributes: Record<string, unknown> | null;
  sessionId: string | null;
}

// ── OTLP JSON types ──────────────────────────────────────────────────────────

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityText?: string;
  body: OtlpAnyValue;
  attributes: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
}

export interface OtlpResourceLogs {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{
      logRecords: OtlpLogRecord[];
    }>;
  }>;
}

export interface OtlpNumberDataPoint {
  timeUnixNano: string;
  asDouble: number;
  attributes: OtlpKeyValue[];
}

export interface OtlpResourceMetrics {
  resourceMetrics: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeMetrics: Array<{
      metrics: Array<{
        name: string;
        unit?: string;
        gauge: { dataPoints: OtlpNumberDataPoint[] };
      }>;
    }>;
  }>;
}
