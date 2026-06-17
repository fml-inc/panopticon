/**
 * Tests for core query functions in db/query.ts:
 *   - listSessions
 *   - costBreakdown
 *   - search
 *   - activitySummary
 *   - sessionTimeline
 *   - rawQuery
 *   - dbStats
 *
 * hookTimeline is covered by query.hook-timeline.test.ts.
 * Session-summary-specific queries are covered by query.session-summaries.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-query-core");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

vi.mock("../session_summaries/display.js", () => ({
  selectSessionSummaryDisplay: () => ({
    summaryText: null,
    enrichment: {
      summaryText: null,
      stale: false,
      staleReasons: [],
      invalidReason: null,
      summaryVersion: null,
      currentSummaryVersion: 1,
    },
  }),
}));
vi.mock("../session_summaries/enrichment-quality.js", () => ({
  invalidSessionSummaryEnrichmentReason: () => null,
}));
vi.mock("../session_summaries/policy.js", () => ({
  getSessionSummaryRunnerPolicy: () => ({ policyHash: "test" }),
}));
vi.mock("../session_summaries/query.js", () => ({
  ensureSessionSummaryProjections: () => {},
}));
vi.mock("../session_summaries/search-index.js", () => ({
  SESSION_SUMMARY_SEARCH_CORPUS: {
    llmSummary: "llm_summary",
    llmSearch: "llm_search",
  },
  SESSION_SUMMARY_SEARCH_PRIORITY: { deterministicSummary: 50 },
}));
vi.mock("../targets/index.js", () => ({ allTargets: () => [] }));

import { config } from "../config.js";
import {
  activitySummary,
  costBreakdown,
  dbStats,
  listSessions,
  rawQuery,
  search,
  sessionTimeline,
} from "./query.js";
import { closeDb, getDb } from "./schema.js";
import { insertHookEvent, upsertSession } from "./store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function insertMessage(opts: {
  session_id: string;
  ordinal: number;
  role: string;
  content: string;
  timestamp_ms: number;
  model?: string;
  is_system?: number;
  has_thinking?: number;
  has_tool_use?: number;
  uuid?: string;
  parent_uuid?: string;
}): number {
  const db = getDb();
  const content = opts.content;
  db.prepare(
    `INSERT INTO messages (session_id, ordinal, role, content, timestamp_ms,
       model, is_system, has_thinking, has_tool_use, content_length,
       uuid, parent_uuid, token_usage, context_tokens, output_tokens, sync_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, hex(randomblob(8)))`,
  ).run(
    opts.session_id,
    opts.ordinal,
    opts.role,
    content,
    opts.timestamp_ms,
    opts.model ?? "",
    opts.is_system ?? 0,
    opts.has_thinking ?? 0,
    opts.has_tool_use ?? 0,
    content.length,
    opts.uuid ?? null,
    opts.parent_uuid ?? null,
  );
  const row = db.prepare("SELECT last_insert_rowid() as id").get() as {
    id: number;
  };
  // Also insert into messages_fts for search
  db.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)").run(
    row.id,
    content,
  );
  return row.id;
}

function insertToolCall(opts: {
  message_id: number;
  session_id: string;
  tool_name: string;
  category?: string;
  tool_use_id?: string;
  input_json?: string;
  skill_name?: string;
  result_content_length?: number;
  duration_ms?: number;
  subagent_session_id?: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO tool_calls (message_id, session_id, call_index, tool_name, category,
       tool_use_id, input_json, skill_name, result_content_length, duration_ms, subagent_session_id, sync_id)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, hex(randomblob(8)))`,
  ).run(
    opts.message_id,
    opts.session_id,
    opts.tool_name,
    opts.category ?? "general",
    opts.tool_use_id ?? null,
    opts.input_json ?? null,
    opts.skill_name ?? null,
    opts.result_content_length ?? null,
    opts.duration_ms ?? null,
    opts.subagent_session_id ?? null,
  );
}

function insertModelPricing(opts: {
  model_id: string;
  input_per_m: number;
  output_per_m: number;
  cache_read_per_m?: number;
  cache_write_per_m?: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO model_pricing (model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.model_id,
    opts.input_per_m,
    opts.output_per_m,
    opts.cache_read_per_m ?? 0,
    opts.cache_write_per_m ?? 0,
    Date.now(),
  );
}

function insertSessionRepository(opts: {
  session_id: string;
  repository: string;
  git_user_name?: string;
  git_user_email?: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_repositories (session_id, repository, first_seen_ms, git_user_name, git_user_email)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.session_id,
    opts.repository,
    Date.now(),
    opts.git_user_name ?? null,
    opts.git_user_email ?? null,
  );
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb(); // initializes schema
});

afterEach(() => {
  closeDb();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

// ── listSessions ─────────────────────────────────────────────────────────────

describe("listSessions", () => {
  it("returns empty when no sessions exist", () => {
    const result = listSessions();
    expect(result.sessions).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.source).toBe("local");
  });

  it("returns sessions with correct fields", () => {
    upsertSession({
      session_id: "sess-1",
      target: "claude-code",
      model: "claude-sonnet-4-20250514",
      project: "my-project",
      started_at_ms: 1000,
      ended_at_ms: 2000,
      first_prompt: "hello world",
      turn_count: 5,
      total_input_tokens: 100,
      total_output_tokens: 200,
    });

    const result = listSessions();
    expect(result.sessions).toHaveLength(1);
    const s = result.sessions[0];
    expect(s.sessionId).toBe("sess-1");
    expect(s.target).toBe("claude-code");
    expect(s.model).toBe("claude-sonnet-4-20250514");
    expect(s.project).toBe("my-project");
    expect(s.startedAt).toBe(new Date(1000).toISOString());
    expect(s.endedAt).toBe(new Date(2000).toISOString());
    expect(s.firstPrompt).toBe("hello world");
    expect(s.turnCount).toBe(5);
    expect(s.totalInputTokens).toBe(100);
    expect(s.totalOutputTokens).toBe(200);
    expect(s.repositories).toEqual([]);
    expect(s.parentSessionId).toBeNull();
    expect(s.relationshipType).toBeNull();
  });

  it("respects limit parameter", () => {
    for (let i = 1; i <= 5; i++) {
      upsertSession({
        session_id: `sess-${i}`,
        target: "claude-code",
        started_at_ms: i * 1000,
      });
    }
    const result = listSessions({ limit: 3 });
    expect(result.sessions).toHaveLength(3);
    // Ordered by started_at_ms DESC
    expect(result.sessions.map((s) => s.sessionId)).toEqual([
      "sess-5",
      "sess-4",
      "sess-3",
    ]);
  });

  it("filters by since parameter (relative time string)", () => {
    const now = Date.now();
    upsertSession({
      session_id: "old",
      target: "claude-code",
      started_at_ms: now - 48 * 3600000, // 48 hours ago
    });
    upsertSession({
      session_id: "recent",
      target: "claude-code",
      started_at_ms: now - 1 * 3600000, // 1 hour ago
    });

    const result = listSessions({ since: "24h" });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe("recent");
  });

  it("includes repository info from session_repositories", () => {
    upsertSession({
      session_id: "sess-repo",
      target: "claude-code",
      started_at_ms: 1000,
    });
    insertSessionRepository({
      session_id: "sess-repo",
      repository: "org/my-repo",
      git_user_name: "Alice",
      git_user_email: "alice@example.com",
    });

    const result = listSessions();
    expect(result.sessions[0].repositories).toEqual([
      {
        name: "org/my-repo",
        gitUserName: "Alice",
        gitUserEmail: "alice@example.com",
      },
    ]);
  });

  it("includes parent session info", () => {
    upsertSession({
      session_id: "parent-sess",
      target: "claude-code",
      started_at_ms: 1000,
    });
    upsertSession({
      session_id: "child-sess",
      target: "claude-code",
      started_at_ms: 2000,
      parent_session_id: "parent-sess",
      relationship_type: "fork",
    });

    const result = listSessions();
    const child = result.sessions.find((s) => s.sessionId === "child-sess");
    expect(child?.parentSessionId).toBe("parent-sess");
    expect(child?.relationshipType).toBe("fork");
  });
});

// ── costBreakdown ────────────────────────────────────────────────────────────

describe("costBreakdown", () => {
  it("returns empty groups with zero totals when no sessions exist", () => {
    const result = costBreakdown();
    expect(result.groups).toEqual([]);
    expect(result.totals.totalTokens).toBe(0);
    expect(result.totals.totalCost).toBe(0);
    expect(result.groupBy).toBe("session");
    expect(result.source).toBe("local");
  });

  it("groups by session (default)", () => {
    upsertSession({
      session_id: "sess-a",
      target: "claude-code",
      model: "claude-sonnet-4-20250514",
      started_at_ms: 1000,
      total_input_tokens: 500,
      total_output_tokens: 200,
    });
    upsertSession({
      session_id: "sess-b",
      target: "claude-code",
      model: "claude-sonnet-4-20250514",
      started_at_ms: 2000,
      total_input_tokens: 300,
      total_output_tokens: 100,
    });

    const result = costBreakdown();
    expect(result.groups).toHaveLength(2);
    const keys = result.groups.map((g) => g.key);
    expect(keys).toContain("sess-a");
    expect(keys).toContain("sess-b");
    expect(result.groupBy).toBe("session");
  });

  it("groups by model", () => {
    upsertSession({
      session_id: "sess-a",
      target: "claude-code",
      model: "claude-opus",
      started_at_ms: 1000,
      total_input_tokens: 500,
      total_output_tokens: 200,
    });
    upsertSession({
      session_id: "sess-b",
      target: "claude-code",
      model: "claude-sonnet",
      started_at_ms: 2000,
      total_input_tokens: 300,
      total_output_tokens: 100,
    });
    upsertSession({
      session_id: "sess-c",
      target: "claude-code",
      model: "claude-opus",
      started_at_ms: 3000,
      total_input_tokens: 100,
      total_output_tokens: 50,
    });

    const result = costBreakdown({ groupBy: "model" });
    expect(result.groupBy).toBe("model");
    expect(result.groups).toHaveLength(2);
    const opusGroup = result.groups.find((g) => g.key === "claude-opus");
    expect(opusGroup).toBeDefined();
    expect(opusGroup!.sessionCount).toBe(2);
    expect(opusGroup!.inputTokens).toBe(600); // 500 + 100
    expect(opusGroup!.outputTokens).toBe(250); // 200 + 50
  });

  it("groups by day", () => {
    // Two sessions on different "days" in UTC
    upsertSession({
      session_id: "sess-day1",
      target: "claude-code",
      model: "claude-sonnet",
      started_at_ms: new Date("2025-01-15T10:00:00Z").getTime(),
      total_input_tokens: 100,
      total_output_tokens: 50,
    });
    upsertSession({
      session_id: "sess-day2",
      target: "claude-code",
      model: "claude-sonnet",
      started_at_ms: new Date("2025-01-16T10:00:00Z").getTime(),
      total_input_tokens: 200,
      total_output_tokens: 100,
    });

    const result = costBreakdown({ groupBy: "day" });
    expect(result.groupBy).toBe("day");
    expect(result.groups).toHaveLength(2);
    // Days ordered DESC
    expect(result.groups[0].key).toBe("2025-01-16");
    expect(result.groups[1].key).toBe("2025-01-15");
  });

  it("computes cost using model_pricing", () => {
    insertModelPricing({
      model_id: "claude-sonnet-4-20250514",
      input_per_m: 3.0,
      output_per_m: 15.0,
    });

    upsertSession({
      session_id: "sess-priced",
      target: "claude-code",
      model: "claude-sonnet-4-20250514",
      started_at_ms: 1000,
      total_input_tokens: 1_000_000, // 1M tokens → $3
      total_output_tokens: 1_000_000, // 1M tokens → $15
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
    });

    const result = costBreakdown();
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].totalCost).toBeCloseTo(18.0, 2);
    expect(result.totals.totalCost).toBeCloseTo(18.0, 2);
  });

  it("filters by since", () => {
    const now = Date.now();
    upsertSession({
      session_id: "old-sess",
      target: "claude-code",
      model: "claude-sonnet",
      started_at_ms: now - 48 * 3600000,
      total_input_tokens: 100,
      total_output_tokens: 50,
    });
    upsertSession({
      session_id: "recent-sess",
      target: "claude-code",
      model: "claude-sonnet",
      started_at_ms: now - 1 * 3600000,
      total_input_tokens: 200,
      total_output_tokens: 100,
    });

    const result = costBreakdown({ since: "24h" });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].key).toBe("recent-sess");
  });

  it("computes correct totals across multiple groups", () => {
    upsertSession({
      session_id: "s1",
      target: "claude-code",
      model: "m1",
      started_at_ms: 1000,
      total_input_tokens: 100,
      total_output_tokens: 200,
    });
    upsertSession({
      session_id: "s2",
      target: "claude-code",
      model: "m2",
      started_at_ms: 2000,
      total_input_tokens: 300,
      total_output_tokens: 400,
    });

    const result = costBreakdown({ groupBy: "session" });
    expect(result.totals.inputTokens).toBe(100 + 300);
    expect(result.totals.outputTokens).toBe(200 + 400);
    expect(result.totals.totalTokens).toBe(100 + 200 + 300 + 400);
  });
});

// ── search ───────────────────────────────────────────────────────────────────

describe("search", () => {
  it("returns empty results for a query with no matches", () => {
    const result = search({ query: "nonexistent" });
    expect(result.results).toEqual([]);
    expect(result.totalMatches).toBe(0);
    expect(result.query).toBe("nonexistent");
    expect(result.source).toBe("local");
  });

  it("returns hook events matching query", () => {
    upsertSession({ session_id: "sess-x", target: "claude-code" });
    insertHookEvent({
      session_id: "sess-x",
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "refactor the database module" },
    });

    const result = search({ query: "refactor" });
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    const hookMatch = result.results.find(
      (r) => r.sessionId === "sess-x" && r.matchType === "prompt",
    );
    expect(hookMatch).toBeDefined();
  });

  it("returns messages matching query", () => {
    upsertSession({ session_id: "sess-msg", target: "claude-code" });
    insertMessage({
      session_id: "sess-msg",
      ordinal: 1,
      role: "assistant",
      content:
        "The authentication module has been refactored to use JWT tokens",
      timestamp_ms: 1000,
    });

    const result = search({ query: "authentication" });
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    const msgMatch = result.results.find((r) => r.matchType === "message");
    expect(msgMatch).toBeDefined();
    expect(msgMatch!.sessionId).toBe("sess-msg");
  });

  it("respects limit and offset", () => {
    upsertSession({ session_id: "sess-search", target: "claude-code" });
    for (let i = 0; i < 5; i++) {
      insertHookEvent({
        session_id: "sess-search",
        event_type: "PreToolUse",
        timestamp_ms: (i + 1) * 1000,
        tool_name: "Bash",
        payload: {
          tool_name: "Bash",
          tool_input: { command: `searching for widgets ${i}` },
        },
      });
    }

    const result = search({ query: "searching", limit: 2, offset: 0 });
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.totalMatches).toBeGreaterThanOrEqual(5);
  });

  it("matches by event_type LIKE", () => {
    upsertSession({ session_id: "sess-evt", target: "claude-code" });
    insertHookEvent({
      session_id: "sess-evt",
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "xyz" },
    });

    const result = search({ query: "UserPromptSubmit" });
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
  });

  it("matches by tool_name LIKE", () => {
    upsertSession({ session_id: "sess-tn", target: "claude-code" });
    insertHookEvent({
      session_id: "sess-tn",
      event_type: "PreToolUse",
      timestamp_ms: 1000,
      tool_name: "TodoRead",
      payload: { tool_name: "TodoRead", tool_input: {} },
    });

    const result = search({ query: "TodoRead" });
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
  });

  it("filters by eventTypes on hook events", () => {
    upsertSession({ session_id: "sess-filter", target: "claude-code" });
    insertHookEvent({
      session_id: "sess-filter",
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "testing filter keyword" },
    });
    insertHookEvent({
      session_id: "sess-filter",
      event_type: "PreToolUse",
      timestamp_ms: 2000,
      tool_name: "Bash",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "testing filter keyword" },
      },
    });

    const result = search({
      query: "testing filter keyword",
      eventTypes: ["UserPromptSubmit"],
    });
    // eventTypes only filters hook events; messages + otel still included
    // but we should get at least the UserPromptSubmit hook match
    const hookMatches = result.results.filter(
      (r) => r.eventType === "UserPromptSubmit",
    );
    expect(hookMatches.length).toBeGreaterThanOrEqual(1);
  });
});

// ── sessionTimeline ──────────────────────────────────────────────────────────

describe("sessionTimeline", () => {
  it("returns null session for non-existent session", () => {
    const result = sessionTimeline({ sessionId: "does-not-exist" });
    expect(result.session).toBeNull();
    expect(result.messages).toEqual([]);
    expect(result.totalMessages).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.source).toBe("local");
  });

  it("returns session metadata and messages", () => {
    upsertSession({
      session_id: "sess-tl",
      target: "claude-code",
      model: "claude-sonnet-4-20250514",
      project: "test-proj",
    });
    insertMessage({
      session_id: "sess-tl",
      ordinal: 1,
      role: "user",
      content: "Hello there",
      timestamp_ms: 1000,
    });
    insertMessage({
      session_id: "sess-tl",
      ordinal: 2,
      role: "assistant",
      content: "Hi! How can I help?",
      timestamp_ms: 2000,
    });

    const result = sessionTimeline({ sessionId: "sess-tl" });
    expect(result.session).not.toBeNull();
    expect(result.session!.sessionId).toBe("sess-tl");
    expect(result.session!.target).toBe("claude-code");
    expect(result.session!.model).toBe("claude-sonnet-4-20250514");
    expect(result.session!.project).toBe("test-proj");
    expect(result.totalMessages).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hello there");
    expect(result.messages[1].role).toBe("assistant");
  });

  it("includes tool calls attached to messages", () => {
    upsertSession({ session_id: "sess-tc", target: "claude-code" });
    const msgId = insertMessage({
      session_id: "sess-tc",
      ordinal: 1,
      role: "assistant",
      content: "Running a command",
      timestamp_ms: 1000,
      has_tool_use: 1,
    });
    insertToolCall({
      message_id: msgId,
      session_id: "sess-tc",
      tool_name: "Bash",
      category: "shell",
      input_json: '{"command":"ls -la"}',
      duration_ms: 150,
    });

    const result = sessionTimeline({ sessionId: "sess-tc" });
    expect(result.messages[0].toolCalls).toHaveLength(1);
    expect(result.messages[0].toolCalls[0].toolName).toBe("Bash");
    expect(result.messages[0].toolCalls[0].category).toBe("shell");
    expect(result.messages[0].toolCalls[0].inputJson).toBe(
      '{"command":"ls -la"}',
    );
    expect(result.messages[0].toolCalls[0].durationMs).toBe(150);
  });

  it("truncates content when fullPayloads is false (default)", () => {
    upsertSession({ session_id: "sess-trunc", target: "claude-code" });
    const longContent = "x".repeat(1000);
    insertMessage({
      session_id: "sess-trunc",
      ordinal: 1,
      role: "assistant",
      content: longContent,
      timestamp_ms: 1000,
    });

    const result = sessionTimeline({ sessionId: "sess-trunc" });
    // Default truncate = 500 chars
    expect(result.messages[0].content.length).toBe(500);
    expect(result.messages[0].contentLength).toBe(1000);
  });

  it("does not truncate content when fullPayloads is true", () => {
    upsertSession({ session_id: "sess-full", target: "claude-code" });
    const longContent = "y".repeat(1000);
    insertMessage({
      session_id: "sess-full",
      ordinal: 1,
      role: "assistant",
      content: longContent,
      timestamp_ms: 1000,
    });

    const result = sessionTimeline({
      sessionId: "sess-full",
      fullPayloads: true,
    });
    expect(result.messages[0].content.length).toBe(1000);
  });

  it("reports hasMore when paginated", () => {
    upsertSession({ session_id: "sess-page", target: "claude-code" });
    for (let i = 1; i <= 5; i++) {
      insertMessage({
        session_id: "sess-page",
        ordinal: i,
        role: i % 2 === 1 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp_ms: i * 1000,
      });
    }

    const page1 = sessionTimeline({
      sessionId: "sess-page",
      limit: 2,
      offset: 0,
    });
    expect(page1.messages).toHaveLength(2);
    expect(page1.totalMessages).toBe(5);
    expect(page1.hasMore).toBe(true);

    const page3 = sessionTimeline({
      sessionId: "sess-page",
      limit: 2,
      offset: 4,
    });
    expect(page3.messages).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
  });

  it("includes child sessions (forks/subagents)", () => {
    upsertSession({
      session_id: "parent",
      target: "claude-code",
      started_at_ms: 1000,
    });
    upsertSession({
      session_id: "child-fork",
      target: "claude-code",
      model: "claude-opus",
      started_at_ms: 2000,
      parent_session_id: "parent",
      relationship_type: "fork",
      turn_count: 3,
      first_prompt: "sub task",
    });

    const result = sessionTimeline({ sessionId: "parent" });
    expect(result.session!.childSessions).toHaveLength(1);
    expect(result.session!.childSessions[0].sessionId).toBe("child-fork");
    expect(result.session!.childSessions[0].relationshipType).toBe("fork");
    expect(result.session!.childSessions[0].turnCount).toBe(3);
  });

  it("includes repositories info", () => {
    upsertSession({ session_id: "sess-repo-tl", target: "claude-code" });
    insertSessionRepository({
      session_id: "sess-repo-tl",
      repository: "org/repo",
      git_user_name: "Bob",
      git_user_email: "bob@test.com",
    });

    const result = sessionTimeline({ sessionId: "sess-repo-tl" });
    expect(result.session!.repositories).toHaveLength(1);
    expect(result.session!.repositories[0].name).toBe("org/repo");
  });

  it("truncates tool call inputJson when fullPayloads is false", () => {
    upsertSession({ session_id: "sess-tc-trunc", target: "claude-code" });
    const msgId = insertMessage({
      session_id: "sess-tc-trunc",
      ordinal: 1,
      role: "assistant",
      content: "tool call",
      timestamp_ms: 1000,
      has_tool_use: 1,
    });
    const longInput = JSON.stringify({ data: "z".repeat(1000) });
    insertToolCall({
      message_id: msgId,
      session_id: "sess-tc-trunc",
      tool_name: "Write",
      input_json: longInput,
    });

    const result = sessionTimeline({ sessionId: "sess-tc-trunc" });
    expect(result.messages[0].toolCalls[0].inputJson!.length).toBe(500);

    const fullResult = sessionTimeline({
      sessionId: "sess-tc-trunc",
      fullPayloads: true,
    });
    expect(fullResult.messages[0].toolCalls[0].inputJson!.length).toBe(
      longInput.length,
    );
  });
});

// ── rawQuery ─────────────────────────────────────────────────────────────────

describe("rawQuery", () => {
  it("allows SELECT statements", () => {
    upsertSession({ session_id: "rq-1", target: "claude-code" });
    const rows = rawQuery("SELECT session_id FROM sessions") as Array<{
      session_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("rq-1");
  });

  it("allows WITH (CTE) statements", () => {
    upsertSession({ session_id: "rq-cte", target: "claude-code" });
    const rows = rawQuery(
      "WITH s AS (SELECT session_id FROM sessions) SELECT * FROM s",
    ) as Array<{ session_id: string }>;
    expect(rows).toHaveLength(1);
  });

  it("allows PRAGMA statements", () => {
    const rows = rawQuery("PRAGMA table_info('sessions')") as Array<{
      name: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    const names = rows.map((r) => r.name);
    expect(names).toContain("session_id");
  });

  it("rejects INSERT statements", () => {
    expect(() =>
      rawQuery("INSERT INTO sessions (session_id) VALUES ('bad')"),
    ).toThrow("Only SELECT, WITH, and PRAGMA statements are allowed");
  });

  it("rejects UPDATE statements", () => {
    expect(() =>
      rawQuery("UPDATE sessions SET target = 'bad' WHERE session_id = 'x'"),
    ).toThrow("Only SELECT, WITH, and PRAGMA statements are allowed");
  });

  it("rejects DELETE statements", () => {
    expect(() => rawQuery("DELETE FROM sessions")).toThrow(
      "Only SELECT, WITH, and PRAGMA statements are allowed",
    );
  });

  it("rejects DROP TABLE statements", () => {
    expect(() => rawQuery("DROP TABLE sessions")).toThrow(
      "Only SELECT, WITH, and PRAGMA statements are allowed",
    );
  });

  it("auto-appends LIMIT 1000 when no LIMIT present", () => {
    // Insert 2 rows, query without LIMIT — should still work
    upsertSession({ session_id: "rq-lim-1", target: "claude-code" });
    upsertSession({ session_id: "rq-lim-2", target: "claude-code" });
    const rows = rawQuery("SELECT session_id FROM sessions") as unknown[];
    expect(rows).toHaveLength(2);
    // The function should have appended LIMIT 1000 (we can't exceed it but it shouldn't fail)
  });

  it("does not append LIMIT when one is already present", () => {
    upsertSession({ session_id: "rq-existing-lim", target: "claude-code" });
    const rows = rawQuery(
      "SELECT session_id FROM sessions LIMIT 1",
    ) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("does not append LIMIT for PRAGMA statements", () => {
    // PRAGMA should work without LIMIT appending
    const rows = rawQuery("PRAGMA table_list") as unknown[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ── dbStats ──────────────────────────────────────────────────────────────────

describe("dbStats", () => {
  it("returns zero counts for empty database", () => {
    const stats = dbStats();
    expect(stats.sessions).toBe(0);
    expect(stats.messages).toBe(0);
    expect(stats.tool_calls).toBe(0);
    expect(stats.hook_events).toBe(0);
    expect(stats.otel_logs).toBe(0);
    expect(stats.otel_metrics).toBe(0);
    expect(stats.otel_spans).toBe(0);
    expect(stats.scanner_turns).toBe(0);
    expect(stats.scanner_events).toBe(0);
  });

  it("returns correct counts after inserting data", () => {
    upsertSession({ session_id: "stat-sess", target: "claude-code" });
    insertHookEvent({
      session_id: "stat-sess",
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "hello" },
    });
    insertHookEvent({
      session_id: "stat-sess",
      event_type: "PreToolUse",
      timestamp_ms: 2000,
      tool_name: "Bash",
      payload: { tool_name: "Bash", tool_input: { command: "echo hi" } },
    });
    insertMessage({
      session_id: "stat-sess",
      ordinal: 1,
      role: "user",
      content: "hello",
      timestamp_ms: 1000,
    });

    const stats = dbStats();
    expect(stats.sessions).toBe(1);
    expect(stats.hook_events).toBe(2);
    expect(stats.messages).toBe(1);
  });
});

// ── activitySummary ──────────────────────────────────────────────────────────

describe("activitySummary", () => {
  it("returns empty summary when no sessions exist", () => {
    const result = activitySummary({ since: "24h" });
    expect(result.totalSessions).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.sessions).toEqual([]);
    expect(result.topTools).toEqual([]);
    expect(result.source).toBe("local");
    expect(result.period.since).toBeDefined();
    expect(result.period.until).toBeDefined();
  });

  it("aggregates sessions within time window", () => {
    const now = Date.now();
    upsertSession({
      session_id: "act-1",
      target: "claude-code",
      model: "claude-sonnet-4-20250514",
      project: "proj-a",
      started_at_ms: now - 3600000, // 1h ago
      ended_at_ms: now - 3000000,
      total_input_tokens: 1000,
      total_output_tokens: 500,
    });
    upsertSession({
      session_id: "act-2",
      target: "claude-code",
      model: "claude-sonnet-4-20250514",
      started_at_ms: now - 1800000, // 30min ago
      ended_at_ms: now - 1200000,
      total_input_tokens: 2000,
      total_output_tokens: 1000,
    });
    // Old session outside window
    upsertSession({
      session_id: "act-old",
      target: "claude-code",
      model: "claude-sonnet-4-20250514",
      started_at_ms: now - 48 * 3600000,
      total_input_tokens: 999,
      total_output_tokens: 999,
    });

    const result = activitySummary({ since: "24h" });
    expect(result.totalSessions).toBe(2);
    expect(result.totalTokens).toBe(1000 + 500 + 2000 + 1000);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].sessionId).toBe("act-1"); // ordered ASC
    expect(result.sessions[1].sessionId).toBe("act-2");
  });

  it("computes duration in minutes", () => {
    const now = Date.now();
    upsertSession({
      session_id: "act-dur",
      target: "claude-code",
      started_at_ms: now - 3600000,
      ended_at_ms: now - 3600000 + 600000, // 10 minutes
      total_input_tokens: 0,
      total_output_tokens: 0,
    });

    const result = activitySummary({ since: "24h" });
    expect(result.sessions[0].durationMinutes).toBe(10);
  });

  it("includes per-session user prompts", () => {
    const now = Date.now();
    upsertSession({
      session_id: "act-prompts",
      target: "claude-code",
      started_at_ms: now - 3600000,
      total_input_tokens: 0,
      total_output_tokens: 0,
    });
    insertMessage({
      session_id: "act-prompts",
      ordinal: 1,
      role: "user",
      content: "first prompt",
      timestamp_ms: now - 3500000,
    });
    insertMessage({
      session_id: "act-prompts",
      ordinal: 2,
      role: "assistant",
      content: "response",
      timestamp_ms: now - 3400000,
    });
    insertMessage({
      session_id: "act-prompts",
      ordinal: 3,
      role: "user",
      content: "second prompt",
      timestamp_ms: now - 3300000,
    });

    const result = activitySummary({ since: "24h" });
    expect(result.sessions[0].userPrompts).toEqual([
      "first prompt",
      "second prompt",
    ]);
  });

  it("includes per-session tool usage counts", () => {
    const now = Date.now();
    upsertSession({
      session_id: "act-tools",
      target: "claude-code",
      started_at_ms: now - 3600000,
      total_input_tokens: 0,
      total_output_tokens: 0,
    });
    const msgId = insertMessage({
      session_id: "act-tools",
      ordinal: 1,
      role: "assistant",
      content: "working",
      timestamp_ms: now - 3500000,
      has_tool_use: 1,
    });
    insertToolCall({
      message_id: msgId,
      session_id: "act-tools",
      tool_name: "Bash",
    });
    insertToolCall({
      message_id: msgId,
      session_id: "act-tools",
      tool_name: "Bash",
    });
    insertToolCall({
      message_id: msgId,
      session_id: "act-tools",
      tool_name: "Write",
    });

    const result = activitySummary({ since: "24h" });
    const tools = result.sessions[0].toolsUsed;
    const bash = tools.find((t) => t.tool === "Bash");
    const write = tools.find((t) => t.tool === "Write");
    expect(bash?.count).toBe(2);
    expect(write?.count).toBe(1);
  });

  it("includes global top tools", () => {
    const now = Date.now();
    upsertSession({
      session_id: "act-global",
      target: "claude-code",
      started_at_ms: now - 3600000,
      total_input_tokens: 0,
      total_output_tokens: 0,
    });
    const msgId = insertMessage({
      session_id: "act-global",
      ordinal: 1,
      role: "assistant",
      content: "work",
      timestamp_ms: now - 3500000,
      has_tool_use: 1,
    });
    insertToolCall({
      message_id: msgId,
      session_id: "act-global",
      tool_name: "Read",
    });
    insertToolCall({
      message_id: msgId,
      session_id: "act-global",
      tool_name: "Read",
    });
    insertToolCall({
      message_id: msgId,
      session_id: "act-global",
      tool_name: "Edit",
    });

    const result = activitySummary({ since: "24h" });
    expect(result.topTools.length).toBeGreaterThanOrEqual(1);
    expect(result.topTools[0].tool).toBe("Read");
    expect(result.topTools[0].count).toBe(2);
  });

  it("includes files modified from Write/Edit tool calls", () => {
    const now = Date.now();
    upsertSession({
      session_id: "act-files",
      target: "claude-code",
      started_at_ms: now - 3600000,
      total_input_tokens: 0,
      total_output_tokens: 0,
    });
    const msgId = insertMessage({
      session_id: "act-files",
      ordinal: 1,
      role: "assistant",
      content: "editing files",
      timestamp_ms: now - 3500000,
      has_tool_use: 1,
    });
    insertToolCall({
      message_id: msgId,
      session_id: "act-files",
      tool_name: "Write",
      input_json: JSON.stringify({ file_path: "/src/main.ts" }),
    });
    insertToolCall({
      message_id: msgId,
      session_id: "act-files",
      tool_name: "Edit",
      input_json: JSON.stringify({ file_path: "/src/utils.ts" }),
    });

    const result = activitySummary({ since: "24h" });
    const files = result.sessions[0].filesModified;
    expect(files).toContain("/src/main.ts");
    expect(files).toContain("/src/utils.ts");
  });

  it("includes repository info per session", () => {
    const now = Date.now();
    upsertSession({
      session_id: "act-repo",
      target: "claude-code",
      started_at_ms: now - 3600000,
      total_input_tokens: 0,
      total_output_tokens: 0,
    });
    insertSessionRepository({
      session_id: "act-repo",
      repository: "org/my-repo",
      git_user_name: "Dev",
      git_user_email: "dev@co.com",
    });

    const result = activitySummary({ since: "24h" });
    expect(result.sessions[0].repositories).toEqual([
      {
        name: "org/my-repo",
        gitUserName: "Dev",
        gitUserEmail: "dev@co.com",
      },
    ]);
  });

  it("defaults to 24h since when not specified", () => {
    const now = Date.now();
    upsertSession({
      session_id: "act-default",
      target: "claude-code",
      started_at_ms: now - 3600000,
      total_input_tokens: 100,
      total_output_tokens: 50,
    });
    // Old session - should not appear
    upsertSession({
      session_id: "act-too-old",
      target: "claude-code",
      started_at_ms: now - 48 * 3600000,
      total_input_tokens: 100,
      total_output_tokens: 50,
    });

    const result = activitySummary(); // no since specified
    expect(result.totalSessions).toBe(1);
    expect(result.sessions[0].sessionId).toBe("act-default");
  });
});
