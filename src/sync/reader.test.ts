/**
 * Reader tests — hook events, OTLP log filtering, and metrics.
 *
 * Scenarios from real production data:
 * 1. Hook events read in batches without any JOIN
 * 2. OTLP logs filtered when hooks are installed (no tool_decision/tool_result/user_prompt)
 * 3. OTLP logs unfiltered when hooks are NOT installed (all body types)
 * 4. Metrics read independently
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
import { readHookEvents, readMetrics, readOtelLogs } from "./reader.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SESSION = "test-sess-001";
const BASE_MS = 1774283300000;

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

function insertMetric(
  id: number,
  name: string,
  value: number,
  timestampNs: number,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO otel_metrics (id, timestamp_ns, name, value, session_id) VALUES (?, ?, ?, ?, ?)",
  ).run(id, timestampNs, name, value, SESSION);
}

function msToNs(ms: number): number {
  return ms * 1_000_000;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("readHookEvents", () => {
  beforeEach(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("reads hook events in batch order", () => {
    insertHook(1, "SessionStart", BASE_MS);
    insertHook(2, "UserPromptSubmit", BASE_MS + 1000);
    insertHook(3, "PreToolUse", BASE_MS + 2000, "Bash");
    insertHook(4, "PostToolUse", BASE_MS + 3000, "Bash");

    const { rows, maxId } = readHookEvents(0, 100);
    expect(rows).toHaveLength(4);
    expect(maxId).toBe(4);
    expect(rows[0].eventType).toBe("SessionStart");
    expect(rows[2].toolName).toBe("Bash");
    expect(rows[2].cwd).toBe("/workspace");
  });

  it("respects afterId watermark", () => {
    insertHook(1, "SessionStart", BASE_MS);
    insertHook(2, "PreToolUse", BASE_MS + 1000, "Bash");
    insertHook(3, "PostToolUse", BASE_MS + 2000, "Bash");

    const { rows } = readHookEvents(1, 100);
    expect(rows).toHaveLength(2);
    expect(rows[0].hookId).toBe(2);
  });

  it("respects limit", () => {
    insertHook(1, "PreToolUse", BASE_MS, "Bash");
    insertHook(2, "PostToolUse", BASE_MS + 100, "Bash");
    insertHook(3, "PreToolUse", BASE_MS + 200, "Read");

    const { rows, maxId } = readHookEvents(0, 2);
    expect(rows).toHaveLength(2);
    expect(maxId).toBe(2);
  });

  it("returns empty when no rows after watermark", () => {
    insertHook(1, "PreToolUse", BASE_MS, "Bash");

    const { rows, maxId } = readHookEvents(1, 100);
    expect(rows).toHaveLength(0);
    expect(maxId).toBe(1);
  });

  it("includes MCP tool names as-is", () => {
    insertHook(1, "PreToolUse", BASE_MS, "mcp__plugin_fml_fml__fml_whoami");

    const { rows } = readHookEvents(0, 100);
    expect(rows[0].toolName).toBe("mcp__plugin_fml_fml__fml_whoami");
  });
});

describe("readOtelLogs", () => {
  beforeEach(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("returns all logs when hooksInstalled=false", () => {
    insertOtelLog(1, "claude_code.user_prompt", msToNs(BASE_MS));
    insertOtelLog(2, "claude_code.tool_decision", msToNs(BASE_MS + 1));
    insertOtelLog(3, "claude_code.tool_result", msToNs(BASE_MS + 2));
    insertOtelLog(4, "claude_code.api_request", msToNs(BASE_MS + 3));
    insertOtelLog(5, "claude_code.api_error", msToNs(BASE_MS + 4));

    const { rows } = readOtelLogs(0, 100, false);
    expect(rows).toHaveLength(5);
  });

  it("filters hook-covered bodies when hooksInstalled=true", () => {
    insertOtelLog(1, "claude_code.user_prompt", msToNs(BASE_MS));
    insertOtelLog(2, "claude_code.tool_decision", msToNs(BASE_MS + 1));
    insertOtelLog(3, "claude_code.tool_result", msToNs(BASE_MS + 2));
    insertOtelLog(4, "claude_code.api_request", msToNs(BASE_MS + 3));
    insertOtelLog(5, "claude_code.api_error", msToNs(BASE_MS + 4));

    const { rows } = readOtelLogs(0, 100, true);
    expect(rows).toHaveLength(2);
    expect(rows[0].body).toBe("claude_code.api_request");
    expect(rows[1].body).toBe("claude_code.api_error");
  });

  it("preserves prompt_id and attributes", () => {
    insertOtelLog(1, "claude_code.api_request", msToNs(BASE_MS), "Bash", "p-1");

    const { rows } = readOtelLogs(0, 100, true);
    expect(rows[0].promptId).toBe("p-1");
    expect(rows[0].attributes).toEqual({ tool_name: "Bash" });
  });

  it("respects afterId watermark", () => {
    insertOtelLog(1, "claude_code.api_request", msToNs(BASE_MS));
    insertOtelLog(2, "claude_code.api_request", msToNs(BASE_MS + 1));

    const { rows } = readOtelLogs(1, 100, false);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(2);
  });
});

describe("readMetrics", () => {
  beforeEach(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("reads metrics in batch order", () => {
    insertMetric(1, "token_usage", 100, msToNs(BASE_MS));
    insertMetric(2, "token_usage", 200, msToNs(BASE_MS + 1000));

    const { rows, maxId } = readMetrics(0, 100);
    expect(rows).toHaveLength(2);
    expect(maxId).toBe(2);
    expect(rows[0].value).toBe(100);
    expect(rows[1].value).toBe(200);
  });
});
