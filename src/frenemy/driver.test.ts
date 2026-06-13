import { describe, expect, it, vi } from "vitest";
import type { InstancesResult } from "../service/types.js";
import type { HookEvent, HookTimelineResult } from "../types.js";
import {
  type FrenemyCursors,
  formatActivity,
  parseChallenge,
  runFrenemyOnce,
} from "./driver.js";

function hookEvent(over: Partial<HookEvent>): HookEvent {
  return {
    sessionId: "p1",
    timestampMs: 1000,
    eventType: "PreToolUse",
    toolName: "Edit",
    cwd: null,
    repository: "fml-inc/panopticon",
    target: "claude",
    userPrompt: null,
    plan: null,
    filePath: null,
    command: null,
    toolResult: null,
    allowedPrompts: null,
    ...over,
  };
}

function roster(
  instances: Array<{ session_id: string; status?: string; role?: string }>,
): InstancesResult {
  return {
    now_ms: 0,
    room: "fml-inc/panopticon",
    counts: { active: 0, idle: 0, exited: 0, total: instances.length },
    // Minimal stub — runFrenemyOnce only reads session_id/status/role.
    instances: instances.map((i) => ({
      session_id: i.session_id,
      status: i.status ?? "active",
      role: i.role ?? null,
    })) as unknown as InstancesResult["instances"],
  };
}

function timeline(events: HookEvent[]): HookTimelineResult {
  return {
    events,
    totalEvents: events.length,
    hasMore: false,
    source: "local",
  };
}

function makeDeps(
  over: Partial<{
    rosterResult: InstancesResult;
    timelineFor: (id: string) => HookEvent[];
    critiqueImpl: (activity: string) => Promise<string | null>;
  }> = {},
) {
  const sends: Array<{ to: string; body: string }> = [];
  const critiqueCalls: string[] = [];
  const deps = {
    busRoster: vi.fn(
      async () => over.rosterResult ?? roster([{ session_id: "p1" }]),
    ),
    hookTimeline: vi.fn(async (input: { sessionId: string }) =>
      timeline(over.timelineFor ? over.timelineFor(input.sessionId) : []),
    ),
    busSend: vi.fn(async (input: { to: string; body: string }) => {
      sends.push({ to: input.to, body: input.body });
    }),
    critique: vi.fn(async (activity: string) => {
      critiqueCalls.push(activity);
      return over.critiqueImpl
        ? over.critiqueImpl(activity)
        : "CHALLENGE: that looks risky";
    }),
  };
  return { deps, sends, critiqueCalls };
}

const OPTS = { room: "fml-inc/panopticon" };

describe("parseChallenge", () => {
  it("extracts a challenge and ignores SKIP / empty", () => {
    expect(parseChallenge("CHALLENGE: keep the null check")).toBe(
      "keep the null check",
    );
    expect(parseChallenge("challenge: lower case works")).toBe(
      "lower case works",
    );
    expect(parseChallenge("SKIP")).toBeNull();
    expect(parseChallenge("CHALLENGE:")).toBeNull();
    expect(parseChallenge("")).toBeNull();
    expect(parseChallenge(null)).toBeNull();
  });
});

describe("formatActivity", () => {
  it("renders bash, file edits, and prompts", () => {
    const out = formatActivity([
      hookEvent({ toolName: "Bash", command: "rm -rf build" }),
      hookEvent({ toolName: "Edit", filePath: "src/auth.ts" }),
      hookEvent({ eventType: "UserPromptSubmit", userPrompt: "make CI pass" }),
    ]);
    expect(out).toContain("Bash: rm -rf build");
    expect(out).toContain("Edit src/auth.ts");
    expect(out).toContain("prompt: make CI pass");
  });
});

describe("runFrenemyOnce", () => {
  it("challenges a live primary's fresh activity", async () => {
    const { deps, sends } = makeDeps({
      timelineFor: () => [hookEvent({ timestampMs: 1000 })],
    });
    const cursors: FrenemyCursors = new Map();
    const sent = await runFrenemyOnce(OPTS, cursors, deps);

    expect(sends).toEqual([{ to: "p1", body: "that looks risky" }]);
    expect(sent).toHaveLength(1);
    expect(cursors.get("p1")).toBe(1000);
  });

  it("does not re-critique already-seen activity (cursor)", async () => {
    const { deps, sends, critiqueCalls } = makeDeps({
      timelineFor: () => [hookEvent({ timestampMs: 1000 })],
    });
    const cursors: FrenemyCursors = new Map();
    await runFrenemyOnce(OPTS, cursors, deps);
    await runFrenemyOnce(OPTS, cursors, deps); // same event, <= cursor

    expect(sends).toHaveLength(1);
    expect(critiqueCalls).toHaveLength(1);
  });

  it("advances the cursor on SKIP without sending", async () => {
    const { deps, sends } = makeDeps({
      timelineFor: () => [hookEvent({ timestampMs: 1000 })],
      critiqueImpl: async () => "SKIP",
    });
    const cursors: FrenemyCursors = new Map();
    await runFrenemyOnce(OPTS, cursors, deps);

    expect(sends).toHaveLength(0);
    expect(cursors.get("p1")).toBe(1000);
  });

  it("ignores frenemy-role and exited instances", async () => {
    const { deps, sends } = makeDeps({
      rosterResult: roster([
        { session_id: "frenemy-x", role: "frenemy" },
        { session_id: "dead", status: "exited" },
        { session_id: "frenemy" },
      ]),
      timelineFor: () => [hookEvent({ timestampMs: 1000 })],
    });
    const cursors: FrenemyCursors = new Map();
    await runFrenemyOnce(OPTS, cursors, deps);
    // frenemy-role excluded, exited excluded, the reserved FRENEMY_FROM id excluded.
    expect(sends).toHaveLength(0);
  });
});
