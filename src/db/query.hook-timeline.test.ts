/**
 * Tests for the hook event projection on the query path:
 *   - hookTimeline() for cross-session / per-session audit queries
 *   - sessionTimeline({ includeHooks: true }) populating hookEvents[]
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
import { hookTimeline, sessionTimeline } from "./query.js";
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

describe("sessionTimeline includeHooks flag", () => {
  it("returns empty hookEvents[] by default", () => {
    const result = sessionTimeline({ sessionId: SESSION_A });
    expect(result.hookEvents).toEqual([]);
  });

  it("populates hookEvents[] ordered ASC when includeHooks=true", () => {
    const result = sessionTimeline({
      sessionId: SESSION_A,
      includeHooks: true,
    });
    expect(result.hookEvents).toHaveLength(4);
    expect(result.hookEvents.map((e) => e.timestampMs)).toEqual([
      1000, 2000, 3000, 4000,
    ]);
    expect(result.hookEvents.every((e) => e.sessionId === SESSION_A)).toBe(
      true,
    );
  });

  it("ignores hook events from other sessions", () => {
    const result = sessionTimeline({
      sessionId: SESSION_B,
      includeHooks: true,
    });
    expect(result.hookEvents).toHaveLength(1);
    expect(result.hookEvents[0].userPrompt).toBe("different session");
  });

  it("returns empty hookEvents[] when the session does not exist", () => {
    const result = sessionTimeline({
      sessionId: "does-not-exist",
      includeHooks: true,
    });
    expect(result.session).toBeNull();
    expect(result.hookEvents).toEqual([]);
  });
});
