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

export interface SessionSummaryEnrichment {
  summaryText: string | null;
  searchText: string | null;
  source: "llm" | null;
  runner: string | null;
  model: string | null;
  generatedAt: string | null;
  dirty: boolean;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  status: "active" | "landed" | "mixed" | "abandoned";
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
  projectionVersion: number;
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
