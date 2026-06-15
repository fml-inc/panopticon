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
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { resolveRoom } from "../bus/room.js";
import type { AgentMessageRow } from "../db/bus.js";
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
those changes. You also have read-only Panopticon tools — use them when the diff
alone is ambiguous: \`query\` (SQL over captured history), \`search\`, \`timeline\`,
and \`session_summary_detail\` to see why a line exists, prior work on a path, or
related sessions. Don't review in isolation when the answer is one query away.

Review the diff as a thorough PR reviewer would, in priority order:
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

  // Keep only paths inside THIS worktree's repo. Resolve each against cwd first
  // so both absolute and relative pathspecs are checked correctly (a relative
  // path that escapes via `..` is dropped, not blanket-trusted). An out-of-repo
  // path (a sibling worktree, a ~/.claude skill, a transcript the agent read)
  // would otherwise make git `fatal` on the whole `diff` command, discarding the
  // diff for the real in-repo edits in the same batch and suppressing all review.
  const top = run(["rev-parse", "--show-toplevel"])?.trim();
  const inRepo = top
    ? paths.filter((p) => {
        const abs = resolve(cwd, p);
        return abs === top || abs.startsWith(`${top}/`);
      })
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
    /** Omit to broadcast to the room (the default for findings). */
    to?: string;
    kind: string;
    body: string;
    source: string;
    /** Stable region+state key, so a finding can be deduped on re-review. */
    subject?: string;
    /** Id of the challenge this message resolves (per-finding correlation). */
    reply_to?: number;
  }) => Promise<unknown>;
  /** Read recent room messages (to see what's already been flagged). */
  busRead: (input: {
    room: string;
    kinds?: string[];
    limit?: number;
  }) => Promise<{ messages: AgentMessageRow[] }>;
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
    // No session_id on purpose: busRead with one sets excludeFrom, which would
    // hide the frenemy's OWN prior findings — the exact ones we dedupe against.
    // (Marking-seen would be harmless/accurate; it's the self-exclusion we avoid.)
    busRead: (input) => httpPanopticonService.busRead(input),
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
        // Give the reviewer panopticon's read-only query tools (timeline, query,
        // search, session_summary_detail, …) so it can pull historical context
        // on demand — why a line exists, prior work on a path, related sessions —
        // instead of judging the diff in isolation. Read-only: no bus_send.
        withMcp: true,
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
 * A stable key for "the exact change I'm reviewing": the touched files plus a
 * hash of their diff. Posted as the finding's `subject` so the frenemy can read
 * the room and recognize a finding it already made. Crucially it includes the
 * DIFF hash — so an unchanged-but-still-dirty region keeps the same subject (skip
 * the dupe), while a real fix changes the diff → new subject → fresh review.
 */
export function subjectFor(paths: string[], diffText: string): string {
  const where = paths
    .map((p) => p.split("/").slice(-2).join("/"))
    .sort()
    .join(",");
  const hash = createHash("sha1").update(diffText).digest("hex").slice(0, 8);
  return `review:${where}#${hash}`;
}

/**
 * The "where" (path list) part of a subject, independent of kind prefix and diff
 * hash — so a `review:<where>#<a>` finding and a `resolved:<where>#<b>` resolution
 * for the same files correlate. e.g. "review:bus/chat.ts#ab12" -> "bus/chat.ts".
 */
export function subjectWhere(subject: string): string {
  const hashAt = subject.lastIndexOf("#");
  const noHash = hashAt === -1 ? subject : subject.slice(0, hashAt);
  const colon = noHash.indexOf(":");
  return colon === -1 ? noHash : noHash.slice(colon + 1);
}

/**
 * One frenemy pass: for each live primary in the room, critique its activity
 * newer than the cursor and post any challenge. Returns the challenges sent.
 * Pure-ish: all I/O goes through `deps`, so it is unit-testable.
 *
 * Reads the room first and skips re-posting a finding whose subject is already
 * on the bus (read-the-room dedup): the bus is an append-only chat, so "did I
 * already say this?" is answered by reading it, not by private state.
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

  // Read the room for findings the frenemy already made, keyed by subject, so an
  // unchanged region isn't flagged twice. Read WITHOUT a session_id: that keeps
  // the frenemy's OWN messages in the result (a session_id would exclude them via
  // excludeFrom — exactly the ones we dedupe against).
  const seenSubjects = new Set<string>();
  // The LATEST state per path-key (the "where" of a subject), in chronological
  // (id-ascending) order — so a region that was flagged, resolved, then RE-flagged
  // reads back as "flagged" (open) again, not permanently resolved. Tracking two
  // independent sets (flagged/resolved) made a resolution stick forever and
  // suppressed every later fix on the same file — the lifecycle bug the frenemy
  // itself caught. (busRead with no sinceId returns oldest-first, so last write
  // wins.)
  const whereState = new Map<string, "flagged" | "resolved">();
  // The message id of the latest OPEN challenge per where, so a resolution can
  // reference the specific finding it addresses (reply_to) — per-finding
  // correlation, not just the path-level `resolved:<where>` subject.
  const openChallengeId = new Map<string, number>();
  try {
    const prior = await deps.busRead({
      room: opts.room,
      kinds: ["challenge"],
      limit: 100,
    });
    for (const m of prior.messages) {
      if (m.from_session !== FRENEMY_FROM || !m.subject) continue;
      seenSubjects.add(m.subject);
      const where = subjectWhere(m.subject);
      if (m.subject.startsWith("review:")) {
        whereState.set(where, "flagged");
        openChallengeId.set(where, m.id);
      } else if (m.subject.startsWith("resolved:")) {
        whereState.set(where, "resolved");
        openChallengeId.delete(where);
      }
    }
  } catch {
    // Best-effort: if the read fails, fall through (may re-post, never crash).
  }

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
    const paths = touchedPaths(fresh);
    const diff: FrenemyDiff = cwd
      ? gitDiff(cwd, paths)
      : { text: "", scope: "none" };

    // Read-the-room dedup: if this exact change (paths + diff hash) already has a
    // frenemy finding on the bus, skip — don't re-critique or re-post. A genuine
    // fix changes the diff → new subject → this passes and gets a fresh review.
    const subject = diff.text ? subjectFor(paths, diff.text) : null;
    if (subject && seenSubjects.has(subject)) {
      cursors.set(
        primary.session_id,
        Math.max(...fresh.map((e) => e.timestampMs)),
      );
      continue;
    }

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
    if (!challenge) {
      // Critic SKIP'd → the change is clean. If this region had an OPEN finding
      // (flagged earlier, not yet marked addressed), the issue looks fixed — post
      // a resolution so the thread reflects it. Re-review-on-fix happens for free:
      // the changed diff produced a new subject, so we got here instead of being
      // deduped. Append-only — a plain ✅ message, deduped by a `resolved:`
      // subject so it posts once per fix.
      if (subject) {
        const where = subjectWhere(subject);
        // Resolve only an OPEN region (latest state flagged). The resolution
        // references the specific challenge it addresses via reply_to (the open
        // finding's message id), so a thread reads challenge → ✅ rather than
        // correlating by `where` alone. NB: still triggered by a clean edit to
        // the same path-set, so an unrelated clean edit to a file with a
        // still-open finding can mark it addressed — an accepted false-positive
        // of `where`-level *triggering* (the reply_to just makes the link exact).
        if (whereState.get(where) === "flagged") {
          const resolvedSubject = `resolved:${subject.slice("review:".length)}`;
          await deps.busSend({
            room: opts.room,
            from: FRENEMY_FROM,
            kind: "challenge",
            body: `✅ Earlier finding on ${where} looks addressed.`,
            source: "frenemy",
            subject: resolvedSubject,
            reply_to: openChallengeId.get(where),
          });
          whereState.set(where, "resolved");
          openChallengeId.delete(where);
          seenSubjects.add(resolvedSubject);
          sent.push({ to: primary.session_id, body: `✅ addressed: ${where}` });
        }
      }
      continue;
    }
    // Broadcast to the ROOM, not the author. A finding is addressed to no one:
    // whoever is active reads the thread and decides to act. Directing it to the
    // session whose timeline triggered it is wrong — that session may be idle,
    // exited, or a read-only reviewer who made no edits (the targeting bug).
    await deps.busSend({
      room: opts.room,
      from: FRENEMY_FROM,
      kind: "challenge",
      body: challenge,
      source: "frenemy",
      subject: subject ?? undefined,
    });
    if (subject) {
      seenSubjects.add(subject);
      // (Re)flag → this region is OPEN again, so a later fix can re-resolve it.
      whereState.set(subjectWhere(subject), "flagged");
    }
    // Tracked for the local log line only (which session's activity prompted it).
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
