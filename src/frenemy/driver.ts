/**
 * Frenemy driver — an adversarial sidecar that watches the agents working in a
 * workspace and challenges questionable actions.
 *
 * Design: the DRIVER (this code) is deterministic plumbing — it reads the roster
 * and the primaries' recent activity from panopticon's capture, hands the change
 * (with its diff) to a CRITIC, and posts any findings back onto the bus. The
 * critic is a headless Opus review agent with read-only access to the primary's
 * worktree (Read/Grep/Glob/safe-Bash) so it can inspect surrounding code, call
 * sites, and history — a real code review, not a glance at the diff. It holds no
 * state between ticks; the cursor only bookmarks what's new.
 *
 * v1 polls on an interval (the "/loop" version). The seams are shaped so the
 * poll can later become a server-side long-poll, and the per-tick critic a
 * persistent (growing, GC'd) review session, without reshaping the driver.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { resolveRoom } from "../bus/room.js";
import { log } from "../log.js";
import { httpPanopticonService } from "../service/http.js";
import type {
  InstancesResult,
  WaitForActivityInput,
  WaitForActivityResult,
} from "../service/types.js";
import { invokeLlmAsync } from "../summary/llm.js";
import type { HookEvent, HookTimelineResult } from "../types.js";

export const FRENEMY_FROM = "frenemy";

/** Default critic model — a strong reviewer; Opus is the point of the frenemy. */
export const FRENEMY_DEFAULT_MODEL = "opus";

export const FRENEMY_PERSONA = `You are a meticulous senior code reviewer embedded in a developer's workspace —
a "frenemy" who reviews changes AS THEY HAPPEN, so that by the time the work is
finished it has effectively already been code-reviewed. Be a stickler: hunt for
real problems and do not rubber-stamp. But do not nitpick — a reviewer who flags
everything gets ignored.

You are given what an agent just did and, when it edited files, the git diff of
those changes. Review the diff as a thorough PR reviewer would, in priority
order:
- Correctness: bugs, logic errors, wrong conditions, off-by-one, unhandled
  errors, race conditions, broken invariants, behavior changes that weren't
  intended.
- Edge cases the change fails to handle: null/empty, large input, concurrency,
  error/failure paths.
- Security: injection, secrets in code, unsafe shell, auth/permission gaps,
  path traversal, SSRF.
- Reinventing the wheel: code that reimplements something already in this
  codebase, an imported library, or the standard library — name the existing
  thing.
- Maintainability that materially matters: misleading names, dead code,
  swallowed errors, risky logic with no test.
Skip pure style/formatting/import-order nitpicks — a linter handles those.

Respond with EXACTLY one of:
- "SKIP" — if the change is sound. Bias toward SKIP for routine, correct work.
- "CHALLENGE: <findings>" — concise, specific findings. Name the file and the
  concrete risk and the fix for each; reference the changed lines from the diff.
  No preamble, no markdown headers.`;

/** Format a primary's recent hook events into a compact activity description. */
export function formatActivity(events: HookEvent[]): string {
  return events
    .map((e) => {
      if (e.eventType === "UserPromptSubmit" && e.userPrompt) {
        return `- prompt: ${e.userPrompt.slice(0, 300)}`;
      }
      const what = e.command
        ? `Bash: ${e.command.slice(0, 200)}`
        : e.filePath
          ? `${e.toolName ?? "tool"} ${e.filePath}`
          : (e.toolName ?? "tool");
      return `- about to ${what}`;
    })
    .join("\n");
}

/** Parse a critic response into a challenge string, or null for SKIP/empty. */
export function parseChallenge(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  const idx = text.toUpperCase().indexOf("CHALLENGE:");
  if (idx === -1) return null;
  const body = text.slice(idx + "CHALLENGE:".length).trim();
  return body.length > 0 ? body : null;
}

/** Unique file paths touched by these events (for diffing). */
function touchedPaths(events: HookEvent[]): string[] {
  return [
    ...new Set(
      events
        .map((e) => e.filePath)
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    ),
  ];
}

/** First non-null cwd among events — the primary's working directory (worktree). */
function eventCwd(events: HookEvent[]): string | null {
  for (const e of events) if (e.cwd) return e.cwd;
  return null;
}

export interface FrenemyDiff {
  text: string;
  /**
   * Where the diff came from, so the prompt can label it: `uncommitted` =
   * staged+unstaged working-tree edits; `branch` = this branch's committed work
   * vs its base; `none` = nothing to review.
   */
  scope: "uncommitted" | "branch" | "none";
  /** The base ref a `branch`-scope diff was taken against (e.g. "origin/main"). */
  base?: string;
}

/**
 * Best-effort base ref to diff a branch's committed work against. Honors
 * PANOPTICON_FRENEMY_BASE (set this for stacked branches whose real base isn't
 * the repo default), else the repo's default branch (origin/HEAD), else
 * main/master. Returns null if none resolve.
 */
function resolveBaseRef(run: (args: string[]) => string | null): string | null {
  const verify = (ref: string): boolean =>
    run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;

  const override = process.env.PANOPTICON_FRENEMY_BASE?.trim();
  if (override && verify(override)) return override;

  // origin/HEAD resolves to e.g. "refs/remotes/origin/main" — strip to "origin/main".
  const head = run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const defaultRemote = head?.trim().replace(/^refs\/remotes\//, "");
  if (defaultRemote && verify(defaultRemote)) return defaultRemote;

  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (verify(ref)) return ref;
  }
  return null;
}

/**
 * The diff for specific files, so the critic reviews the ACTUAL change, not just
 * "about to edit X". Run in the primary's cwd (its worktree). Prefers uncommitted
 * work; when the worktree is clean (the change already landed in a commit, or the
 * frenemy is in a sibling worktree) it falls back to this branch's committed work
 * vs its base so there's still something real to review. Best-effort: `none` on
 * any failure (not a git repo, etc.). Truncated so a huge diff doesn't blow up
 * the critic prompt.
 */
export function gitDiff(
  cwd: string,
  paths: string[],
  maxChars = 8000,
): FrenemyDiff {
  if (paths.length === 0) return { text: "", scope: "none" };
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", cwd, "--no-pager", ...args], {
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
  const truncate = (out: string): string =>
    out.length > maxChars
      ? `${out.slice(0, maxChars)}\n…[diff truncated]`
      : out;

  // Keep only paths inside THIS worktree's repo. An out-of-repo path (a sibling
  // worktree, a ~/.claude skill, a transcript file the agent read) makes git
  // `fatal` on the whole `diff` command, which would otherwise throw away the
  // diff for the real in-repo edits in the same batch — suppressing all review.
  const top = run(["rev-parse", "--show-toplevel"])?.trim();
  // Drop only ABSOLUTE paths that fall outside the repo; relative paths are
  // resolved by git against cwd and are inherently in-repo.
  const inRepo = top
    ? paths.filter(
        (p) => !isAbsolute(p) || p === top || p.startsWith(`${top}/`),
      )
    : paths;
  if (inRepo.length === 0) return { text: "", scope: "none" };

  // `diff HEAD` so staged AND unstaged edits are reviewed (plain `git diff`
  // misses staged changes). The reviewer also has git tools to dig further.
  const working = run(["diff", "HEAD", "--", ...inRepo]);
  if (working && working.trim().length > 0) {
    return { text: truncate(working), scope: "uncommitted" };
  }

  // Nothing uncommitted: review what this branch committed vs its base (three-dot
  // = only this branch's changes since it diverged), so committed work is still
  // reviewed instead of yielding an empty diff.
  const base = resolveBaseRef(run);
  if (base) {
    const branch = run(["diff", `${base}...HEAD`, "--", ...inRepo]);
    if (branch && branch.trim().length > 0) {
      return { text: truncate(branch), scope: "branch", base };
    }
  }
  return { text: "", scope: "none" };
}

export interface FrenemyOptions {
  room: string;
  runner?: "claude" | "codex";
  model?: string | null;
  /** Hook events to consider per primary (most recent). */
  lookback?: number;
}

/**
 * Per-primary cursor: the highest hook timestampMs already critiqued. Not
 * memory — just bookmarks which activity is new to look at. Statefulness (so the
 * frenemy doesn't repeat itself / can escalate / can debate) comes later from a
 * persistent session that grows and is GC'd by the harness, not a layer here.
 */
export type FrenemyCursors = Map<string, number>;

interface FrenemyDeps {
  busRoster: (input: { room: string }) => Promise<InstancesResult>;
  hookTimeline: (input: {
    sessionId: string;
    eventTypes?: string[];
    since?: string;
    limit?: number;
  }) => Promise<HookTimelineResult>;
  busSend: (input: {
    room: string;
    from: string;
    to: string;
    kind: string;
    body: string;
    source: string;
  }) => Promise<unknown>;
  critique: (reviewInput: string, cwd: string | null) => Promise<string | null>;
}

/**
 * Read-only tools the reviewer may use in the primary's worktree. Deliberately
 * no Write/Edit (the frenemy reviews, never changes code) and Bash limited to
 * safe inspection commands.
 */
const REVIEW_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(cat:*)",
  "Bash(ls:*)",
  "Bash(rg:*)",
  // Note: no `sed` — `sed -i` writes in place, which would break the
  // reviews-never-changes-code invariant. Grep/rg cover content search.
];

function defaultDeps(opts: FrenemyOptions): FrenemyDeps {
  return {
    busRoster: (input) => httpPanopticonService.busRoster(input),
    hookTimeline: (input) => httpPanopticonService.hookTimeline(input),
    busSend: (input) => httpPanopticonService.busSend(input),
    critique: async (reviewInput, cwd) => {
      // Give the reviewer read-only access to the primary's worktree so it can
      // inspect surrounding code, call sites, and history — a real review, not
      // just a glance at the diff.
      const out = await invokeLlmAsync(reviewInput, {
        runner: opts.runner ?? "claude",
        model: opts.model ?? FRENEMY_DEFAULT_MODEL,
        systemPrompt: FRENEMY_PERSONA,
        cwd: cwd ?? undefined,
        allowedTools: cwd ? REVIEW_TOOLS : undefined,
      });
      if (process.env.PANOPTICON_FRENEMY_DEBUG) {
        log.server.info(
          `frenemy critic: in=${JSON.stringify(reviewInput.slice(0, 500))} out=${JSON.stringify(out)}`,
        );
      }
      return out;
    },
  };
}

/**
 * One frenemy pass: for each live primary in the room, critique its activity
 * newer than the cursor and post any challenge. Returns the challenges sent.
 * Pure-ish: all I/O goes through `deps`, so it is unit-testable.
 */
export async function runFrenemyOnce(
  opts: FrenemyOptions,
  cursors: FrenemyCursors,
  deps: FrenemyDeps = defaultDeps(opts),
): Promise<Array<{ to: string; body: string }>> {
  const sent: Array<{ to: string; body: string }> = [];
  const roster = await deps.busRoster({ room: opts.room });
  const primaries = roster.instances.filter(
    (i) =>
      i.role !== "frenemy" &&
      i.session_id !== FRENEMY_FROM &&
      i.status !== "exited",
  );

  for (const primary of primaries) {
    const cursor = cursors.get(primary.session_id) ?? 0;
    const timeline = await deps.hookTimeline({
      // PostToolUse so we review edits that have actually landed (the diff is
      // real), plus PreToolUse/prompt for about-to-run commands and intent.
      sessionId: primary.session_id,
      eventTypes: ["PreToolUse", "PostToolUse", "UserPromptSubmit"],
      since: cursor > 0 ? new Date(cursor).toISOString() : undefined,
      // If a primary emits more than `lookback` events between passes, only the
      // newest `lookback` are reviewed and the cursor jumps past the rest. Fine
      // for a polling reviewer; the long-poll version reviews every event.
      limit: opts.lookback ?? 8,
    });
    // Chronological order reads more naturally for the critic than hook_timeline's
    // newest-first.
    const fresh = timeline.events
      .filter((e) => e.timestampMs > cursor)
      .sort((a, b) => a.timestampMs - b.timestampMs);
    if (fresh.length === 0) continue;

    // Review the ACTUAL diff of the files it changed, not just the action list.
    const cwd = eventCwd(fresh);
    const diff: FrenemyDiff = cwd
      ? gitDiff(cwd, touchedPaths(fresh))
      : { text: "", scope: "none" };
    const diffHeading =
      diff.scope === "branch"
        ? `Diff of the files it changed (committed on this branch vs ${diff.base}):`
        : "Diff of the files it changed:";
    const reviewInput = diff.text
      ? `What the agent just did:\n${formatActivity(fresh)}\n\n${diffHeading}\n${diff.text}`
      : `What the agent just did:\n${formatActivity(fresh)}`;

    const raw = await deps.critique(reviewInput, cwd);
    // Advance the cursor only after a SUCCESSFUL critic response (a challenge or
    // an explicit SKIP). A transient failure (null — timeout, missing binary)
    // leaves the activity unseen so the next pass retries it, rather than
    // silently burning a real questionable action.
    if (raw === null) continue;
    cursors.set(
      primary.session_id,
      Math.max(...fresh.map((e) => e.timestampMs)),
    );

    const challenge = parseChallenge(raw);
    if (!challenge) continue;
    await deps.busSend({
      room: opts.room,
      from: FRENEMY_FROM,
      to: primary.session_id,
      kind: "challenge",
      body: challenge,
      source: "frenemy",
    });
    sent.push({ to: primary.session_id, body: challenge });
  }
  return sent;
}

export interface FrenemyLoopHandle {
  stop: () => void;
  /** Resolves when the loop stops (e.g. via stop() or an unrecoverable error). */
  done: Promise<void>;
}

/**
 * Naive poll loop (the "/loop" driver). Runs runFrenemyOnce every intervalMs.
 * Long-poll driver: instead of fixed-interval polling, block on the server until
 * room activity happens, settle briefly so a burst of edits batches into one
 * review, then run a pass. While the room is idle it does no work and makes no
 * model calls. Wakes promptly (server-side notify) and exits promptly on stop().
 */
export function createFrenemyLoop(
  opts: FrenemyOptions & {
    /** Settle window: batch a burst of edits before reviewing (ms). */
    settleMs?: number;
    /** Max time to block per long-poll before re-waiting (ms). */
    longPollMs?: number;
    onChallenge?: (c: { to: string; body: string }) => void;
    /** Test seams (default to the real service / pass). */
    _waitForActivity?: (
      input: WaitForActivityInput,
    ) => Promise<WaitForActivityResult>;
    _runOnce?: (
      o: FrenemyOptions,
      c: FrenemyCursors,
    ) => Promise<Array<{ to: string; body: string }>>;
  },
): FrenemyLoopHandle {
  const waitForActivity =
    opts._waitForActivity ??
    ((input) => httpPanopticonService.waitForActivity(input));
  const runOnce = opts._runOnce ?? ((o, c) => runFrenemyOnce(o, c));
  const cursors: FrenemyCursors = new Map();
  let stopped = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const settleMs = opts.settleMs ?? 3_000;
  const longPollMs = opts.longPollMs ?? 25_000;

  // A stop signal raced against every await so stop() (Ctrl-C) breaks the loop
  // immediately — even mid long-poll (the dangling request resolves server-side
  // and is harmlessly ignored).
  const STOP = "__frenemy_stop__" as const;
  let resolveStop: () => void = () => {};
  const stopPromise = new Promise<void>((r) => {
    resolveStop = r;
  });
  const untilStop = <T>(p: Promise<T>): Promise<T | typeof STOP> =>
    Promise.race<T | typeof STOP>([p, stopPromise.then(() => STOP)]);
  // NB: do NOT unref this timer. During the settle/backoff wait it is the only
  // pending handle (the long-poll request has already resolved), so an unref'd
  // timer lets Node treat the event loop as empty and exit mid-settle before any
  // review runs. Prompt shutdown comes from the stop-race + process.exit, not
  // from unref.
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => {
      setTimeout(r, ms);
    });

  let watermark = 0;

  async function tick(): Promise<void> {
    while (!stopped) {
      let res: WaitForActivityResult | typeof STOP;
      try {
        res = await untilStop(
          waitForActivity({
            room: opts.room,
            sinceMs: watermark,
            timeoutMs: longPollMs,
          }),
        );
      } catch (err) {
        log.server.error("frenemy wait failed:", err);
        if ((await untilStop(sleep(5_000))) === STOP) break;
        continue;
      }
      if (res === STOP) break;
      if (res.activityMs == null) continue; // idle timeout — keep waiting
      // Advance to the waking event, NOT the newest activity seen during
      // settle/review. Conservative on purpose: edits that land after the diff
      // is read still wake the next wait (one extra, usually-SKIP pass) rather
      // than being silently dropped.
      watermark = Math.max(watermark, res.activityMs);

      if ((await untilStop(sleep(settleMs))) === STOP) break;

      try {
        const sent = await runOnce(opts, cursors);
        for (const c of sent) {
          log.server.info(`frenemy → ${c.to}: ${c.body}`);
          opts.onChallenge?.(c);
        }
      } catch (err) {
        log.server.error("frenemy pass failed:", err);
      }
    }
    resolveDone();
  }
  void tick();

  return {
    stop() {
      stopped = true;
      resolveStop();
    },
    done,
  };
}

/** Resolve the frenemy's room from an explicit value or the current cwd. */
export function resolveFrenemyRoom(explicit?: string): string | null {
  return explicit ?? resolveRoom(process.cwd());
}
