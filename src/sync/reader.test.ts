/**
 * Merge logic tests derived from real panopticon data.
 *
 * Scenarios observed in production:
 * 1. ToolSearch — exact name match, tight timestamps (~15ms delta)
 * 2. MCP tools — hook has full qualified name (mcp__plugin_...), OTLP has "mcp_tool"
 * 3. SessionStart/Stop/SessionEnd — no OTLP mapping, stay unmerged
 * 4. UserPromptSubmit — matches claude_code.user_prompt (~51ms delta)
 * 5. Same-timestamp OTLP logs — tool_decision and tool_result at identical ns
 * 6. Dedup — multiple OTLP matches for one hook, keep closest timestamp
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-reader");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { readMergedEvents, readUnmatchedOtelLogs } from "./reader.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SESSION = "test-sess-001";
const BASE_MS = 1774283300000; // arbitrary fixed base

function insertHook(
  id: number,
  eventType: string,
  timestampMs: number,
  toolName: string | null = null,
): void {
  const db = getDb();
  const payload = gzipSync(Buffer.from(JSON.stringify({ test: true })));
  db.prepare(
    "INSERT INTO hook_events (id, session_id, event_type, timestamp_ms, tool_name, cwd, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, SESSION, eventType, timestampMs, toolName, "/workspace", payload);
}

function insertOtelLog(
  id: number,
  body: string,
  timestampNs: number,
  toolName: string | null = null,
  promptId: string | null = "prompt-1",
): void {
  const db = getDb();
  const attrs = toolName
    ? JSON.stringify({ tool_name: toolName })
    : JSON.stringify({});
  db.prepare(
    "INSERT INTO otel_logs (id, session_id, body, timestamp_ns, attributes, prompt_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, SESSION, body, timestampNs, attrs, promptId);
}

function msToNs(ms: number, offsetMs = 0): number {
  // Use string math to avoid MAX_SAFE_INTEGER issues in test setup
  return (ms + offsetMs) * 1_000_000;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("readMergedEvents", () => {
  beforeEach(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("merges ToolSearch PreToolUse with tool_decision (exact name match)", () => {
    const hookMs = BASE_MS + 40937;
    insertHook(1, "PreToolUse", hookMs, "ToolSearch");
    insertOtelLog(
      100,
      "claude_code.tool_decision",
      msToNs(hookMs, 15), // 15ms later in OTLP
      "ToolSearch",
    );

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolName).toBe("ToolSearch");
    expect(rows[0].otelPromptId).toBe("prompt-1"); // merged
  });

  it("merges PostToolUse with tool_result", () => {
    const hookMs = BASE_MS + 40985;
    insertHook(1, "PostToolUse", hookMs, "ToolSearch");
    insertOtelLog(
      100,
      "claude_code.tool_result",
      msToNs(hookMs, -32), // 32ms earlier in OTLP
      "ToolSearch",
    );

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].otelPromptId).toBe("prompt-1");
  });

  it("merges UserPromptSubmit with user_prompt (no tool_name)", () => {
    const hookMs = BASE_MS + 36783;
    insertHook(1, "UserPromptSubmit", hookMs, null);
    insertOtelLog(
      100,
      "claude_code.user_prompt",
      msToNs(hookMs, -51), // 51ms earlier
      null,
    );

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("UserPromptSubmit");
    expect(rows[0].otelPromptId).toBe("prompt-1");
  });

  it("does NOT merge SessionStart (no OTLP mapping)", () => {
    insertHook(1, "SessionStart", BASE_MS, null);
    // Even if there's an OTLP log nearby, SessionStart has no CASE mapping
    insertOtelLog(100, "claude_code.user_prompt", msToNs(BASE_MS), null);

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("SessionStart");
    expect(rows[0].otelPromptId).toBeNull(); // unmerged
  });

  it("does NOT merge Stop events", () => {
    insertHook(1, "Stop", BASE_MS + 48621, null);

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].otelPromptId).toBeNull();
  });

  it("does NOT merge SessionEnd events", () => {
    insertHook(1, "SessionEnd", BASE_MS + 79842, null);

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].otelPromptId).toBeNull();
  });

  it("merges MCP tools when OTLP uses 'mcp_tool' as tool_name", () => {
    // Real scenario: hook has full qualified MCP name, OTLP normalizes to "mcp_tool"
    const hookMs = BASE_MS + 44132;
    insertHook(1, "PreToolUse", hookMs, "mcp__plugin_fml_fml__fml_whoami");
    insertOtelLog(
      100,
      "claude_code.tool_decision",
      msToNs(hookMs, 36), // 36ms delta — realistic for MCP round-trip
      "mcp_tool",
    );

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].otelPromptId).toBe("prompt-1");
  });

  it("merges MCP PostToolUse when OTLP uses 'mcp_tool'", () => {
    const hookMs = BASE_MS + 45035;
    insertHook(
      1,
      "PostToolUse",
      hookMs,
      "mcp__plugin_panopticon_panopticon__panopticon_sessions",
    );
    insertOtelLog(
      100,
      "claude_code.tool_result",
      msToNs(hookMs, -33),
      "mcp_tool",
    );

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].otelPromptId).toBe("prompt-1");
  });

  it("rejects matches beyond 100ms timestamp delta", () => {
    const hookMs = BASE_MS + 40000;
    insertHook(1, "PreToolUse", hookMs, "Bash");
    insertOtelLog(
      100,
      "claude_code.tool_decision",
      msToNs(hookMs, 150), // 150ms delta — too far
      "Bash",
    );

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].otelPromptId).toBeNull(); // no merge
  });

  it("keeps closest OTLP match when multiple candidates exist (dedup)", () => {
    const hookMs = BASE_MS + 50000;
    insertHook(1, "PreToolUse", hookMs, "Read");
    // Two OTLP logs match — one closer than the other
    insertOtelLog(
      100,
      "claude_code.tool_decision",
      msToNs(hookMs, 80),
      "Read",
      "prompt-far",
    );
    insertOtelLog(
      101,
      "claude_code.tool_decision",
      msToNs(hookMs, 5),
      "Read",
      "prompt-close",
    );

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].otelPromptId).toBe("prompt-close");
  });

  it("merges PostToolUseFailure with tool_result", () => {
    const hookMs = BASE_MS + 60000;
    insertHook(1, "PostToolUseFailure", hookMs, "Bash");
    insertOtelLog(100, "claude_code.tool_result", msToNs(hookMs, 10), "Bash");

    const { rows } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("PostToolUseFailure");
    expect(rows[0].otelPromptId).toBe("prompt-1");
  });

  it("handles a realistic mixed session sequence", () => {
    // Modeled after real session ce7d228a
    // SessionStart (no merge)
    insertHook(1, "SessionStart", BASE_MS, null);

    // UserPromptSubmit → user_prompt
    insertHook(2, "UserPromptSubmit", BASE_MS + 9252, null);
    insertOtelLog(
      200,
      "claude_code.user_prompt",
      msToNs(BASE_MS + 9252, -51),
      null,
    );

    // ToolSearch PreToolUse → tool_decision
    insertHook(3, "PreToolUse", BASE_MS + 13406, "ToolSearch");
    insertOtelLog(
      201,
      "claude_code.tool_decision",
      msToNs(BASE_MS + 13406, 16),
      "ToolSearch",
    );

    // ToolSearch PostToolUse → tool_result
    insertHook(4, "PostToolUse", BASE_MS + 13454, "ToolSearch");
    insertOtelLog(
      202,
      "claude_code.tool_result",
      msToNs(BASE_MS + 13454, -32),
      "ToolSearch",
    );

    // MCP tool PreToolUse → tool_decision (name mismatch)
    insertHook(
      5,
      "PreToolUse",
      BASE_MS + 16601,
      "mcp__plugin_fml_fml__fml_whoami",
    );
    insertOtelLog(
      203,
      "claude_code.tool_decision",
      msToNs(BASE_MS + 16601, 36),
      "mcp_tool",
    );

    // MCP tool PostToolUse → tool_result (name mismatch)
    insertHook(
      6,
      "PostToolUse",
      BASE_MS + 17504,
      "mcp__plugin_fml_fml__fml_whoami",
    );
    insertOtelLog(
      204,
      "claude_code.tool_result",
      msToNs(BASE_MS + 17504, -46),
      "mcp_tool",
    );

    // Stop (no merge)
    insertHook(7, "Stop", BASE_MS + 21090, null);

    // SessionEnd (no merge)
    insertHook(8, "SessionEnd", BASE_MS + 52311, null);

    // Unmatched OTLP: api_request logs
    insertOtelLog(
      205,
      "claude_code.api_request",
      msToNs(BASE_MS + 10000),
      null,
    );
    insertOtelLog(
      206,
      "claude_code.api_request",
      msToNs(BASE_MS + 16500),
      null,
    );

    const { rows, maxId } = readMergedEvents(0, 100);
    expect(rows).toHaveLength(8);
    expect(maxId).toBe(8);

    // SessionStart — unmerged
    expect(rows[0].otelPromptId).toBeNull();
    // UserPromptSubmit — merged
    expect(rows[1].otelPromptId).toBe("prompt-1");
    // ToolSearch Pre — merged
    expect(rows[2].otelPromptId).toBe("prompt-1");
    // ToolSearch Post — merged
    expect(rows[3].otelPromptId).toBe("prompt-1");
    // MCP Pre — should be merged (currently broken)
    expect(rows[4].otelPromptId).toBe("prompt-1");
    // MCP Post — should be merged (currently broken)
    expect(rows[5].otelPromptId).toBe("prompt-1");
    // Stop — unmerged
    expect(rows[6].otelPromptId).toBeNull();
    // SessionEnd — unmerged
    expect(rows[7].otelPromptId).toBeNull();
  });
});

describe("readUnmatchedOtelLogs", () => {
  beforeEach(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("returns api_request logs (not in merged set)", () => {
    insertOtelLog(1, "claude_code.api_request", msToNs(BASE_MS), null);
    insertOtelLog(2, "claude_code.api_error", msToNs(BASE_MS + 100), null);

    const { rows } = readUnmatchedOtelLogs(0, 100);
    expect(rows).toHaveLength(2);
    expect(rows[0].body).toBe("claude_code.api_request");
    expect(rows[1].body).toBe("claude_code.api_error");
  });

  it("excludes merged body types", () => {
    insertOtelLog(1, "claude_code.user_prompt", msToNs(BASE_MS), null);
    insertOtelLog(2, "claude_code.tool_decision", msToNs(BASE_MS + 1), null);
    insertOtelLog(3, "claude_code.tool_result", msToNs(BASE_MS + 2), null);
    insertOtelLog(4, "claude_code.api_request", msToNs(BASE_MS + 3), null);

    const { rows } = readUnmatchedOtelLogs(0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("claude_code.api_request");
  });
});
