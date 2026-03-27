export interface SyncTarget {
  /** Unique name for this target, used as watermark namespace */
  name: string;
  /** OTLP HTTP endpoint base URL (e.g. "https://otlp.example.com") */
  url: string;
  /** Bearer token — sent as Authorization: Bearer <token> */
  token?: string;
  /** Shell command that returns a Bearer token on stdout (e.g. "gh auth token"). Cached for 5 minutes. */
  tokenCommand?: string;
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
  /** When true, OTLP logs that hooks cover (tool_decision, tool_result, user_prompt) are filtered out */
  hooksInstalled?: boolean;
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

/** Hook event record for sync. */
export interface HookEventRecord {
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
  toolResult: string | null;
}

/** OTLP log record for sync. */
export interface OtelLogRecord {
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

export interface OtlpMetric {
  name: string;
  unit?: string;
  gauge?: { dataPoints: OtlpNumberDataPoint[] };
  sum?: {
    dataPoints: OtlpNumberDataPoint[];
    aggregationTemporality: number; // 1=CUMULATIVE, 2=DELTA
    isMonotonic: boolean;
  };
}

export interface OtlpResourceMetrics {
  resourceMetrics: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeMetrics: Array<{
      metrics: OtlpMetric[];
    }>;
  }>;
}
