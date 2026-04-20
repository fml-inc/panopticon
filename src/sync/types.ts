export interface SyncTarget {
  /** Unique name for this target, used as watermark namespace */
  name: string;
  /** Sync endpoint base URL (e.g. "https://example.com") */
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
  /** Only sync sessions with associated repo attribution (default true) */
  requireRepo?: boolean;
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
}

export interface SyncHandle {
  start: () => void;
  stop: () => void;
  /**
   * Run a single sync cycle without scheduling further ticks. Resolves to
   * `true` if more work is pending. Useful for tests and manual triggers.
   */
  runOnce: () => Promise<boolean>;
}

/** Hook event record for sync. */
export interface HookEventRecord {
  hookId: number;
  sessionId: string;
  syncId: string | null;
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
  syncId: string | null;
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
  syncId: string | null;
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
  syncId: string | null;
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
  syncId: string | null;
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
  pluginHooks: unknown[];
  /** Panopticon's own allowlist (allowed.json content, or null). */
  panopticonAllowed: Record<string, unknown> | null;
  /** Panopticon's own approvals state (approvals.json content, or null). */
  panopticonApprovals: Record<string, unknown> | null;
  /** Claude Code memory files keyed by project slug, then relative path. */
  memoryFiles: Record<string, Record<string, string>>;
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
  hookToolCounts: Record<string, number>;
  eventTypeCounts: Record<string, number>;
  hookEventTypeCounts: Record<string, number>;
  project: string | null;
  machine: string;
  messageCount: number;
  userMessageCount: number;
  parentSessionId: string | null;
  relationshipType: string;
  isAutomated: boolean;
  createdAt: number | null;
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

// ── Message sync records ────────────────────────────────────────────────────

export interface MessageSyncRecord {
  id: number;
  syncId: string | null;
  sessionId: string;
  ordinal: number;
  role: string;
  content: string;
  timestampMs: number | null;
  hasThinking: boolean;
  hasToolUse: boolean;
  contentLength: number;
  isSystem: boolean;
  model: string;
  tokenUsage: string;
  contextTokens: number;
  outputTokens: number;
  hasContextTokens: boolean;
  hasOutputTokens: boolean;
}

export interface ToolCallSyncRecord {
  id: number;
  messageId: number;
  messageSyncId: string | null;
  sessionId: string;
  callIndex: number;
  syncId: string | null;
  toolName: string;
  category: string;
  toolUseId: string | null;
  inputJson: string | null;
  skillName: string | null;
  resultContentLength: number | null;
  resultContent: string | null;
  subagentSessionId: string | null;
}

// ── Sync registry ───────────────────────────────────────────────────────────

/**
 * Descriptor for a single table that participates in the sync loop.
 * All tables POST to /v1/sync with {table, rows} payload.
 */
export interface TableSyncDescriptor<TRow = unknown> {
  /** Table name, used as watermark key and sent in the POST body. */
  table: string;
  /** Noun for log messages (e.g. "events", "logs"). */
  logNoun: string;
  /** Read rows from SQLite starting after the given watermark. */
  read: (afterId: number, limit: number) => { rows: TRow[]; maxId: number };
  /** Whether this table's rows are linked to sessions (filtered by repo). */
  sessionLinked: boolean;
}
