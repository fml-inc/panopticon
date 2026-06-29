/**
 * Tests for the hook event projection on the query path:
 *   - hookTimeline() for cross-session / per-session audit queries
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-hook-timeline");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { hookTimeline } from "./query.js";
import { closeDb, getDb } from "./schema.js";
import { insertHookEvent, upsertSession } from "./store.js";

const SESSION_A = "sess-a";
const SESSION_B = "sess-b";

function seedHookEvents(): void {
  // Make both sessions queryable through sessionTimeline (needs a sessions row)
  upsertSession({ session_id: SESSION_A, target: "claude-code" });
  upsertSession({ session_id: SESSION_B, target: "claude-code" });

  // Session A: prompt → plan → bash → file edit (ascending timestamps)
  insertHookEvent({
    session_id: SESSION_A,
    event_type: "UserPromptSubmit",
    timestamp_ms: 1_000,
    cwd: "/workspace/a",
    repository: "org/a",
    payload: { prompt: "kick things off" },
  });
  insertHookEvent({
    session_id: SESSION_A,
    event_type: "ExitPlanMode",
    timestamp_ms: 2_000,
    cwd: "/workspace/a",
    repository: "org/a",
    tool_name: "ExitPlanMode",
    payload: {
      tool_name: "ExitPlanMode",
      tool_input: { plan: "## Plan\n- step 1" },
    },
  });
  insertHookEvent({
    session_id: SESSION_A,
    event_type: "PreToolUse",
    timestamp_ms: 3_000,
    cwd: "/workspace/a",
    repository: "org/a",
    tool_name: "Bash",
    payload: { tool_name: "Bash", tool_input: { command: "ls -la" } },
  });
  insertHookEvent({
    session_id: SESSION_A,
    event_type: "PreToolUse",
    timestamp_ms: 4_000,
    cwd: "/workspace/a",
    repository: "org/a",
    tool_name: "Edit",
    payload: {
      tool_name: "Edit",
      tool_input: { file_path: "/workspace/a/src/foo.ts" },
    },
  });

  // Session B: a single prompt in a different repo
  insertHookEvent({
    session_id: SESSION_B,
    event_type: "UserPromptSubmit",
    timestamp_ms: 5_000,
    cwd: "/workspace/b",
    repository: "org/b",
    payload: { prompt: "different session" },
  });
}

beforeEach(() => {
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb();
  seedHookEvents();
});

afterEach(() => {
  closeDb();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

describe("hookTimeline", () => {
  it("returns events across all sessions ordered by timestamp DESC", () => {
    const result = hookTimeline();
    expect(result.totalEvents).toBe(5);
    expect(result.events.map((e) => e.timestampMs)).toEqual([
      5000, 4000, 3000, 2000, 1000,
    ]);
    expect(result.hasMore).toBe(false);
    expect(result.source).toBe("local");
  });

  it("filters by sessionId", () => {
    const result = hookTimeline({ sessionId: SESSION_A });
    expect(result.totalEvents).toBe(4);
    expect(result.events.every((e) => e.sessionId === SESSION_A)).toBe(true);
  });

  it("filters by eventTypes (IN clause)", () => {
    const result = hookTimeline({
      eventTypes: ["UserPromptSubmit", "ExitPlanMode"],
    });
    expect(result.totalEvents).toBe(3);
    expect(result.events.map((e) => e.eventType).sort()).toEqual([
      "ExitPlanMode",
      "UserPromptSubmit",
      "UserPromptSubmit",
    ]);
  });

  it("projects high-value columns onto the result", () => {
    const result = hookTimeline({
      sessionId: SESSION_A,
      eventTypes: ["UserPromptSubmit"],
    });
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.userPrompt).toBe("kick things off");
    expect(ev.cwd).toBe("/workspace/a");
    expect(ev.repository).toBe("org/a");

    const planResult = hookTimeline({
      sessionId: SESSION_A,
      eventTypes: ["ExitPlanMode"],
    });
    expect(planResult.events[0].plan).toBe("## Plan\n- step 1");
    expect(planResult.events[0].toolName).toBe("ExitPlanMode");

    const bashResult = hookTimeline({
      sessionId: SESSION_A,
      eventTypes: ["PreToolUse"],
    });
    const cmd = bashResult.events.find((e) => e.toolName === "Bash");
    const edit = bashResult.events.find((e) => e.toolName === "Edit");
    expect(cmd?.command).toBe("ls -la");
    expect(edit?.filePath).toBe("/workspace/a/src/foo.ts");
  });

  it("projects raw tool result fields without deriving failure", () => {
    insertHookEvent({
      session_id: SESSION_A,
      event_type: "PostToolUse",
      timestamp_ms: 6_000,
      cwd: "/workspace/a",
      repository: "org/a",
      tool_name: "Bash",
      payload: {
        tool_name: "Bash",
        tool_response: {
          stdout: "stdout text",
          stderr: "stderr text",
          interrupted: true,
          exit_code: 2,
          status: "done",
          is_error: false,
          error: { message: "raw error object" },
        },
      },
    });

    const result = hookTimeline({
      sessionId: SESSION_A,
      eventTypes: ["PostToolUse"],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      toolResultStdout: "stdout text",
      toolResultStderr: "stderr text",
      toolResultInterrupted: true,
      toolResultExitCode: 2,
      toolResultStatus: "done",
      toolResultIsError: false,
      toolResultError: '{"message":"raw error object"}',
    });
  });

  it("does not treat top-level hook payload fields as tool result fields", () => {
    insertHookEvent({
      session_id: SESSION_A,
      event_type: "UserPromptSubmit",
      timestamp_ms: 6_500,
      cwd: "/workspace/a",
      repository: "org/a",
      payload: {
        prompt: "do work",
        stdout: "claude",
        stderr: "sync-id-looking-value",
      },
    });

    const result = hookTimeline({
      sessionId: SESSION_A,
      eventTypes: ["UserPromptSubmit"],
    });
    const ev = result.events.find((event) => event.timestampMs === 6_500);
    expect(ev).toMatchObject({
      toolResultStdout: null,
      toolResultStderr: null,
    });
  });

  it("paginates via limit + offset and reports hasMore", () => {
    const first = hookTimeline({ limit: 2, offset: 0 });
    expect(first.events).toHaveLength(2);
    expect(first.events.map((e) => e.timestampMs)).toEqual([5000, 4000]);
    expect(first.hasMore).toBe(true);

    const last = hookTimeline({ limit: 2, offset: 4 });
    expect(last.events).toHaveLength(1);
    expect(last.events[0].timestampMs).toBe(1000);
    expect(last.hasMore).toBe(false);
  });

  it("returns empty result for unmatched filters", () => {
    expect(hookTimeline({ sessionId: "does-not-exist" }).events).toEqual([]);
    expect(hookTimeline({ eventTypes: ["Nope"] }).events).toEqual([]);
  });
});
