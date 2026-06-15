import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessageRow } from "../db/bus.js";
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
  subjectFor,
  subjectWhere,
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
    priorMessages: AgentMessageRow[];
  }> = {},
) {
  const sends: Array<{ to: string | undefined; body: string }> = [];
  const sendInputs: Array<{
    to?: string;
    body: string;
    subject?: string;
    reply_to?: number;
  }> = [];
  const critiqueCalls: string[] = [];
  const deps = {
    busRoster: vi.fn(
      async () => over.rosterResult ?? roster([{ session_id: "p1" }]),
    ),
    hookTimeline: vi.fn(async (input: { sessionId: string }) =>
      timeline(over.timelineFor ? over.timelineFor(input.sessionId) : []),
    ),
    busSend: vi.fn(
      async (input: {
        to?: string;
        body: string;
        subject?: string;
        reply_to?: number;
      }) => {
        sends.push({ to: input.to, body: input.body });
        sendInputs.push(input);
      },
    ),
    busRead: vi.fn(async () => ({ messages: over.priorMessages ?? [] })),
    critique: vi.fn(async (activity: string) => {
      critiqueCalls.push(activity);
      return over.critiqueImpl
        ? over.critiqueImpl(activity)
        : "CHALLENGE: that looks risky";
    }),
  };
  return { deps, sends, sendInputs, critiqueCalls };
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

    // Broadcast to the room (to: undefined), not directed to the author p1.
    expect(sends).toEqual([{ to: undefined, body: "that looks risky" }]);
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
    // Proves the loop reaches the review pass after the settle wait and then
    // stops cleanly. NB: this does NOT guard the original bug (an unref'd settle
    // timer let the *process* exit mid-settle) — vitest keeps the process alive
    // regardless, so re-adding the unref leaves this green. It guards the loop's
    // control flow, not process liveness.
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

describe("subjectFor", () => {
  it("is stable for the same paths+diff and changes when either changes", () => {
    const a = subjectFor(["src/a.ts"], "diff-1");
    expect(subjectFor(["src/a.ts"], "diff-1")).toBe(a); // stable
    expect(subjectFor(["src/a.ts"], "diff-2")).not.toBe(a); // diff changed
    expect(subjectFor(["src/b.ts"], "diff-1")).not.toBe(a); // path changed
  });
});

describe("subjectWhere", () => {
  it("extracts the path part so findings and resolutions correlate", () => {
    // A `review:` finding and a `resolved:` note for the same files share a where.
    expect(subjectWhere("review:bus/chat.ts#ab12")).toBe("bus/chat.ts");
    expect(subjectWhere("resolved:bus/chat.ts#cd34")).toBe("bus/chat.ts");
    // subjectFor keeps the last two path segments.
    expect(subjectWhere(subjectFor(["a/b/c.ts"], "d"))).toBe("b/c.ts");
  });
});

describe("runFrenemyOnce read-the-room dedup", () => {
  let repo: string;
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "frenemy-dedup-")));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\n");
    git("add", "f.txt");
    git("commit", "-m", "base");
    // Uncommitted change → a real diff for the reviewer to find.
    writeFileSync(join(repo, "f.txt"), "one\nrisky\n");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const edit = (): HookEvent =>
    hookEvent({ timestampMs: 1000, cwd: repo, filePath: join(repo, "f.txt") });
  const priorFinding = (
    subject: string,
    from = "frenemy",
  ): AgentMessageRow => ({
    id: 1,
    room: "fml-inc/panopticon",
    from_session: from,
    to_session: null,
    kind: "challenge",
    body: "earlier finding",
    subject,
    reply_to: null,
    ref_tool: null,
    ref_path: null,
    source: "frenemy",
    created_at_ms: 0,
    delivered_at_ms: null,
  });
  // The subject runFrenemyOnce will compute for this exact change.
  const currentSubject = (): string =>
    subjectFor(
      [join(repo, "f.txt")],
      gitDiff(repo, [join(repo, "f.txt")]).text,
    );

  it("skips (no critique, no send) when its own finding for this diff is on the bus", async () => {
    const { deps, sends, critiqueCalls } = makeDeps({
      timelineFor: () => [edit()],
      priorMessages: [priorFinding(currentSubject())],
    });
    const cursors: FrenemyCursors = new Map();
    await runFrenemyOnce(OPTS, cursors, deps);
    expect(critiqueCalls).toHaveLength(0); // the expensive critic isn't even called
    expect(sends).toHaveLength(0); // not re-posted
    expect(cursors.get("p1")).toBe(1000); // cursor still advances past seen activity
  });

  it("still reviews when the same subject came from a NON-frenemy sender", async () => {
    const { deps, sends } = makeDeps({
      timelineFor: () => [edit()],
      priorMessages: [priorFinding(currentSubject(), "some-other-agent")],
    });
    await runFrenemyOnce(OPTS, new Map(), deps);
    expect(sends).toHaveLength(1); // only the frenemy's OWN findings seed dedup
  });

  it("re-reviews when the diff changed (a fix → new subject)", async () => {
    const { deps, sends } = makeDeps({
      timelineFor: () => [edit()],
      // A prior finding for a DIFFERENT diff state — must not suppress this one.
      priorMessages: [
        priorFinding(subjectFor([join(repo, "f.txt")], "stale diff")),
      ],
    });
    await runFrenemyOnce(OPTS, new Map(), deps);
    expect(sends).toHaveLength(1);
  });

  // ── Resolution (re-review-on-fix) ──────────────────────────────────────────

  it("posts a ✅ resolution when a previously-flagged region goes clean", async () => {
    const { deps, sends, sendInputs } = makeDeps({
      timelineFor: () => [edit()],
      critiqueImpl: async () => "SKIP", // the change reviews clean now
      // The frenemy flagged this same file earlier, at a different diff state.
      priorMessages: [
        priorFinding(subjectFor([join(repo, "f.txt")], "old buggy diff")),
      ],
    });
    await runFrenemyOnce(OPTS, new Map(), deps);
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toContain("✅");
    expect(sends[0].body).toContain("addressed");
    // The ✅ references the specific open challenge (priorFinding id), not just
    // the path — per-finding correlation via reply_to.
    expect(sendInputs[0].reply_to).toBe(1);
  });

  it("does not resolve a region it never flagged", async () => {
    const { deps, sends } = makeDeps({
      timelineFor: () => [edit()],
      critiqueImpl: async () => "SKIP",
      // No prior finding — a clean region that was never flagged stays silent.
    });
    await runFrenemyOnce(OPTS, new Map(), deps);
    expect(sends).toHaveLength(0);
  });

  it("does not re-resolve a region already marked addressed", async () => {
    const where = subjectWhere(currentSubject());
    const { deps, sends } = makeDeps({
      timelineFor: () => [edit()],
      critiqueImpl: async () => "SKIP",
      priorMessages: [
        priorFinding(subjectFor([join(repo, "f.txt")], "old buggy diff")), // flagged
        priorFinding(`resolved:${where}#deadbeef`), // already resolved once
      ],
    });
    await runFrenemyOnce(OPTS, new Map(), deps);
    expect(sends).toHaveLength(0);
  });

  it("re-resolves after a region is RE-flagged (latest state wins, not permanent)", async () => {
    // The lifecycle bug a live frenemy caught: a file used to get only one ✅
    // ever. A flag→fix→re-flag→fix cycle must resolve the SECOND fix too. Prior
    // room state, chronological: flagged → resolved → re-flagged (latest = open).
    const where = subjectWhere(currentSubject());
    const { deps, sends } = makeDeps({
      timelineFor: () => [edit()],
      critiqueImpl: async () => "SKIP", // the second fix is clean
      priorMessages: [
        priorFinding(`review:${where}#h1`),
        priorFinding(`resolved:${where}#h2`),
        priorFinding(`review:${where}#h3`), // re-flagged after the resolution
      ],
    });
    await runFrenemyOnce(OPTS, new Map(), deps);
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toContain("addressed");
  });
});
