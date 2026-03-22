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

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface Session {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  toolCount: number;
  totalTokens: number;
  totalCost: number;
  repositories: string[];
  cwd: string | null;
  firstPrompt: string | null;
  githubUsername: string | null;
  eventTypeCounts: Record<string, number>;
}

export interface SessionListResult {
  sessions: Session[];
  totalCount: number;
  source: "local" | "remote";
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export interface TimelineEvent {
  eventType: string;
  timestamp: string;
  toolName: string | null;
  promptPreview: string | null;
  payload: unknown | null;
}

export interface SessionTimelineResult {
  session: {
    sessionId: string;
    githubUsername: string | null;
    repositories: string[];
    cwd: string | null;
  } | null;
  events: TimelineEvent[];
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
  githubUsername: string | null;
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
  startedAt: string;
  durationMinutes: number;
  cwd: string | null;
  repositories: string[];
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
  eventTypeCounts: Record<string, number>;
  engineers: Array<{
    githubUsername: string;
    sessionCount: number;
    lastActiveAt: string;
  }>;
  sessions: ActivitySessionDetail[];
  source: "local" | "remote";
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchMatch {
  sessionId: string;
  timestamp: string;
  githubUsername: string | null;
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
