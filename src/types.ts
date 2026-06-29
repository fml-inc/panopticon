/**
 * Unified response types for panopticon query functions.
 *
 * These types define the canonical shapes returned by both local queries
 * (panopticon SQLite) and remote queries (FML backend). Both sources
 * populate the same fields — the data originates from panopticon either way.
 *
 * Conventions:
 *   - camelCase field names
 *   - ISO 8601 strings for timestamps
 *   - null for genuinely absent data, never for source-dependent gaps
 */

// ── Common ────────────────────────────────────────────────────────────────────

export interface Repository {
  name: string;
  gitUserName: string | null;
  gitUserEmail: string | null;
}

export type SessionSummaryStaleReason =
  | "dirty"
  | "summary_version_changed"
  | "summary_policy_changed";

export interface SessionSummaryEnrichment {
  summaryText: string | null;
  searchText: string | null;
  source: "llm" | null;
  runner: string | null;
  model: string | null;
  summaryVersion: number | null;
  currentSummaryVersion: number;
  stale: boolean;
  staleReasons: SessionSummaryStaleReason[];
  invalidReason: string | null;
  generatedAt: string | null;
  dirty: boolean;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  status: "active" | "landed" | "mixed" | "read-only" | "unlanded";
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  firstIntentAt: string | null;
  lastIntentAt: string | null;
  intentCount: number;
  editCount: number;
  landedEditCount: number;
  openEditCount: number;
  topFiles: string[];
  summaryText: string | null;
  projectionHash: string;
  projectedAt: string;
  sourceLastSeenAt: string | null;
  summarySource: "deterministic" | null;
  summaryGeneratedAt: string | null;
  summaryDirty: boolean;
  enrichment: SessionSummaryEnrichment | null;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface Session {
  sessionId: string;
  target: string | null;
  model: string | null;
  project: string | null;
  startedAt: string | null;
  endedAt: string | null;
  firstPrompt: string | null;
  turnCount: number;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  repositories: Repository[];
  parentSessionId: string | null;
  relationshipType: string | null;
  summary: string | null;
  sessionSummary: SessionSummary | null;
}

export interface SessionListResult {
  sessions: Session[];
  totalCount: number;
  source: "local" | "remote";
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export interface TimelineToolCall {
  toolName: string;
  category: string;
  toolUseId: string | null;
  inputJson: string | null;
  skillName: string | null;
  resultContentLength: number | null;
  durationMs: number | null;
  subagentSessionId: string | null;
  /** Subagent session metadata, present when subagentSessionId is set */
  subagent: {
    sessionId: string;
    model: string | null;
    turnCount: number;
    firstPrompt: string | null;
  } | null;
}

export interface TimelineMessage {
  id: number;
  ordinal: number;
  role: string;
  content: string;
  timestampMs: number | null;
  model: string | null;
  isSystem: boolean;
  hasThinking: boolean;
  hasToolUse: boolean;
  contentLength: number;
  uuid: string | null;
  parentUuid: string | null;
  tokenUsage: string | null;
  contextTokens: number;
  outputTokens: number;
  toolCalls: TimelineToolCall[];
}

export interface ChildSession {
  sessionId: string;
  relationshipType: string;
  model: string | null;
  turnCount: number;
  firstPrompt: string | null;
  startedAtMs: number | null;
}

export interface SessionTimelineResult {
  session: {
    sessionId: string;
    target: string | null;
    model: string | null;
    project: string | null;
    parentSessionId: string | null;
    relationshipType: string | null;
    repositories: Repository[];
    childSessions: ChildSession[];
  } | null;
  messages: TimelineMessage[];
  totalMessages: number;
  hasMore: boolean;
  source: "local" | "remote";
}

// ── Hook events ───────────────────────────────────────────────────────────────

/**
 * Projection of a hook_events row, surfacing only the fields that aren't
 * already covered by messages/tool_calls. Powers the cross-session
 * hookTimeline query.
 */
export interface HookEvent {
  sessionId: string;
  timestampMs: number;
  eventType: string;
  toolName: string | null;
  cwd: string | null;
  repository: string | null;
  target: string | null;
  /** UserPromptSubmit body — every prompt, not just sessions.first_prompt. */
  userPrompt: string | null;
  /** ExitPlanMode plan markdown. */
  plan: string | null;
  /** Absolute file path extracted from tool_input on file-touching events. */
  filePath: string | null;
  /** Command string extracted from Bash tool_input. */
  command: string | null;
  /** PostToolUse tool_result or tool_response text. */
  toolResult: string | null;
  /** Raw stdout field from tool_result/tool_response, when present. */
  toolResultStdout: string | null;
  /** Raw stderr field from tool_result/tool_response, when present. */
  toolResultStderr: string | null;
  /** Raw interrupted field from tool_result/tool_response, when present. */
  toolResultInterrupted: boolean | null;
  /** Raw exit_code/exitCode field from tool_result/tool_response, when present. */
  toolResultExitCode: number | null;
  /** Raw status field from tool_result/tool_response, when present. */
  toolResultStatus: string | null;
  /** Raw is_error/isError field from tool_result/tool_response, when present. */
  toolResultIsError: boolean | null;
  /** Raw error/error_message/errorMessage field from tool_result/tool_response, when present. */
  toolResultError: string | null;
  /** Permission-request allowed_prompts payload. */
  allowedPrompts: string | null;
}

export interface HookTimelineResult {
  events: HookEvent[];
  totalEvents: number;
  hasMore: boolean;
  source: "local" | "remote";
}

// ── Spending ──────────────────────────────────────────────────────────────────

export interface SpendingGroup {
  key: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
  sessionCount: number;
}

export interface SpendingResult {
  groups: SpendingGroup[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCost: number;
  };
  groupBy: "session" | "model" | "day";
  source: "local" | "remote";
}

// ── Activity Summary ──────────────────────────────────────────────────────────

export interface ActivitySessionDetail {
  sessionId: string;
  startedAt: string | null;
  durationMinutes: number;
  model: string | null;
  project: string | null;
  repositories: Repository[];
  userPrompts: string[];
  toolsUsed: Array<{ tool: string; count: number }>;
  filesModified: string[];
  totalCost: number;
}

export interface ActivitySummaryResult {
  period: {
    since: string;
    until: string;
  };
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  topTools: Array<{ tool: string; count: number }>;
  sessions: ActivitySessionDetail[];
  source: "local" | "remote";
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchMatch {
  sessionId: string;
  timestamp: string;
  matchType: string;
  matchSnippet: string;
  eventType: string | null;
  toolName: string | null;
}

export interface SearchResult {
  results: SearchMatch[];
  totalMatches: number;
  query: string;
  source: "local" | "remote";
}
