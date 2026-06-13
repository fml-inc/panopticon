import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InstancesResult,
  WaitForActivityResult,
} from "../service/types.js";
import type { HookEvent, HookTimelineResult } from "../types.js";
import {
  createFrenemyLoop,
  type FrenemyCursors,
  formatActivity,
  gitDiff,
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

  it("does NOT advance the cursor when the critic fails — retries next pass", async () => {
    const { deps, critiqueCalls } = makeDeps({
      timelineFor: () => [hookEvent({ timestampMs: 1000 })],
      critiqueImpl: async () => null, // transient failure (timeout / missing binary)
    });
    const cursors: FrenemyCursors = new Map();
    await runFrenemyOnce(OPTS, cursors, deps);
    expect(cursors.get("p1")).toBeUndefined(); // unseen — not burned

    await runFrenemyOnce(OPTS, cursors, deps); // same activity is retried
    expect(critiqueCalls).toHaveLength(2);
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

describe("createFrenemyLoop", () => {
  it("wakes on activity, runs a review pass, and stops cleanly", async () => {
    // Regression: the loop must reach the review pass after the settle wait.
    // (A previously unref'd settle timer let the process exit mid-settle.)
    let runs = 0;
    let waits = 0;
    const handle = createFrenemyLoop({
      room: "fml-inc/panopticon",
      settleMs: 5,
      longPollMs: 1000,
      _waitForActivity: async (): Promise<WaitForActivityResult> => {
        waits += 1;
        // First wait: activity is already present. After: block until stop().
        if (waits === 1) {
          return { activityMs: 100, room: "fml-inc/panopticon" };
        }
        return new Promise<WaitForActivityResult>(() => {});
      },
      _runOnce: async () => {
        runs += 1;
        return [];
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toBe(1);
    handle.stop();
    await handle.done; // resolves promptly via the stop-race
  });
});

describe("gitDiff", () => {
  let repo: string;
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });

  beforeEach(() => {
    // realpath so it matches `git rev-parse --show-toplevel` (macOS /var symlink).
    repo = realpathSync(mkdtempSync(join(tmpdir(), "frenemy-gitdiff-")));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", "f.txt");
    git("commit", "-m", "base");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    delete process.env.PANOPTICON_FRENEMY_BASE;
  });

  it("returns uncommitted working-tree changes (staged + unstaged)", () => {
    writeFileSync(join(repo, "f.txt"), "one\ntwo\n");
    const diff = gitDiff(repo, ["f.txt"]);
    expect(diff.scope).toBe("uncommitted");
    expect(diff.text).toContain("+two");
  });

  it("falls back to this branch's committed work vs base when clean", () => {
    git("checkout", "-b", "feat");
    writeFileSync(join(repo, "f.txt"), "one\ncommitted\n");
    git("add", "f.txt");
    git("commit", "-m", "feat work");
    // Working tree clean — the change only lives in the commit.
    const diff = gitDiff(repo, ["f.txt"]);
    expect(diff.scope).toBe("branch");
    expect(diff.base).toBe("main");
    expect(diff.text).toContain("+committed");
  });

  it("honors PANOPTICON_FRENEMY_BASE for the branch fallback", () => {
    git("branch", "stable");
    git("checkout", "-b", "feat");
    writeFileSync(join(repo, "f.txt"), "one\nfromfeat\n");
    git("add", "f.txt");
    git("commit", "-m", "feat work");
    process.env.PANOPTICON_FRENEMY_BASE = "stable";
    const diff = gitDiff(repo, ["f.txt"]);
    expect(diff.scope).toBe("branch");
    expect(diff.base).toBe("stable");
    expect(diff.text).toContain("+fromfeat");
  });

  it("ignores out-of-repo paths so they don't suppress the in-repo diff", () => {
    writeFileSync(join(repo, "f.txt"), "one\ntwo\n");
    // A sibling-worktree / ~/.claude path in the same batch must not make git
    // fatal on the whole command and lose the real edit.
    const diff = gitDiff(repo, [
      join(repo, "f.txt"),
      "/Users/somebody/.claude/skills/review.md",
    ]);
    expect(diff.scope).toBe("uncommitted");
    expect(diff.text).toContain("+two");
  });

  it("returns scope=none when every path is outside the repo", () => {
    const diff = gitDiff(repo, ["/etc/hosts", "/tmp/elsewhere.txt"]);
    expect(diff.scope).toBe("none");
    expect(diff.text).toBe("");
  });

  it("drops a relative path that escapes the repo via ..", () => {
    writeFileSync(join(repo, "f.txt"), "one\ntwo\n");
    // Resolved against cwd, "../f.txt" lands outside the repo and must be
    // dropped — not blanket-trusted just because it isn't absolute.
    const diff = gitDiff(repo, ["../f.txt"]);
    expect(diff.scope).toBe("none");
  });

  it("reports scope=none when nothing changed vs base", () => {
    git("checkout", "-b", "feat"); // no commits beyond base
    const diff = gitDiff(repo, ["f.txt"]);
    expect(diff.scope).toBe("none");
    expect(diff.text).toBe("");
  });

  it("returns scope=none for empty paths without touching git", () => {
    expect(gitDiff(repo, [])).toEqual({ text: "", scope: "none" });
  });
});
