/** Which class of sync data a target can receive. */
export type SyncCapability = "otlp" | "api";

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
  /** Which table classes this target receives. Default: ["otlp"]. */
  capabilities?: SyncCapability[];
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
  target: string | null;
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

/** Scanner turn record for sync. */
export interface ScannerTurnRecord {
  id: number;
  sessionId: string;
  source: string; // "claude" | "codex" | "gemini"
  turnIndex: number;
  timestampMs: number;
  model: string | null;
  role: string | null;
  contentPreview: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  cliVersion: string | null;
}

/** Scanner event record for sync. */
export interface ScannerEventRecord {
  id: number;
  sessionId: string;
  source: string;
  eventType: string;
  timestampMs: number;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
}

/** OTLP span record for sync. */
export interface OtelSpanRecord {
  id: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number | null;
  startTimeNs: number;
  endTimeNs: number;
  statusCode: number | null;
  statusMessage: string | null;
  attributes: Record<string, unknown> | null;
  resourceAttributes: Record<string, unknown> | null;
  sessionId: string | null;
}

// ── Config snapshot records ──────────────────────────────────────────────────

export interface UserConfigSnapshotRecord {
  id: number;
  deviceName: string;
  snapshotAtMs: number;
  contentHash: string;
  permissions: Record<string, unknown>;
  enabledPlugins: unknown[];
  hooks: unknown[];
  commands: unknown[];
  rules: unknown[];
  skills: unknown[];
}

export interface RepoConfigSnapshotRecord {
  id: number;
  repository: string;
  cwd: string;
  sessionId: string | null;
  snapshotAtMs: number;
  contentHash: string;
  hooks: unknown[];
  mcpServers: unknown[];
  commands: unknown[];
  agents: unknown[];
  rules: unknown[];
  localHooks: unknown[];
  localMcpServers: unknown[];
  localPermissions: Record<string, unknown>;
  localIsGitignored: boolean;
  instructions: unknown[];
}

// ── Session sync record ─────────────────────────────────────────────────────

export interface SessionSyncRecord {
  sessionId: string;
  target: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  cwd: string | null;
  firstPrompt: string | null;
  permissionMode: string | null;
  agentVersion: string | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCacheReadTokens: number | null;
  totalCacheCreationTokens: number | null;
  totalReasoningTokens: number | null;
  turnCount: number | null;
  models: string | null;
  summary: string | null;
  toolCounts: Record<string, number>;
  eventTypeCounts: Record<string, number>;
  repositories: Array<{
    repository: string;
    firstSeenMs: number;
    gitUserName: string | null;
    gitUserEmail: string | null;
    branch: string | null;
  }>;
  cwds: Array<{
    cwd: string;
    firstSeenMs: number;
  }>;
}

// ── Sync registry ───────────────────────────────────────────────────────────

/** Context passed to reader functions that need values from SyncOptions. */
export interface ReaderContext {
  hooksInstalled: boolean;
}

/**
 * Descriptor for a single table that participates in the sync loop.
 * The generic loop reads rows, optionally filters by repo, serializes,
 * and POSTs — this descriptor captures all the per-table variation.
 */
export interface TableSyncDescriptor<TRow = unknown> {
  /** Table name, used as the watermark namespace key. */
  table: string;
  /** Noun for log messages (e.g. "events", "logs"). */
  logNoun: string;
  /** Which capability class this table belongs to. */
  capability: SyncCapability;
  /** Read rows from SQLite starting after the given watermark. */
  read: (
    afterId: number,
    limit: number,
    ctx: ReaderContext,
  ) => { rows: TRow[]; maxId: number };
  /** Serialize a batch of rows into the POST body. */
  serialize: (rows: TRow[]) => unknown;
  /** URL path suffix appended to target.url (e.g. "/v1/logs"). */
  endpoint: string;
  /** Extract repo string from a row for shouldSync filtering. If omitted, no filtering. */
  extractRepo?: (row: TRow) => string | null;
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

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status?: { code?: number; message?: string };
  attributes: OtlpKeyValue[];
}

export interface OtlpResourceSpans {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      spans: OtlpSpan[];
    }>;
  }>;
}
