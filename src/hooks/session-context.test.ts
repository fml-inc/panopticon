import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const _fs = require("node:fs");
  const _os = require("node:os");
  const _path = require("node:path");
  const tmpDir = _path.join(_os.tmpdir(), "panopticon-session-context-test");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: _path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => _fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { isFirstUserPromptSubmit } from "./ingest.js";
import {
  buildSessionStartRecentHistoryContext,
  buildUserPromptSubmitLocalContext,
} from "./session-context.js";

const cwd = path.join(os.tmpdir(), "panopticon-session-context-cwd");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("session context builders", () => {
  beforeEach(() => {
    closeDb();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
    fs.mkdirSync(config.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("formats recent session summaries from the same cwd", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "previous",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 1_000,
      firstPrompt: "old request",
    });
    insertSummary({
      sessionId: "previous",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: baseMs + 2_000,
      summaryText: "Added SessionStart context injection for recent history.",
    });
    insertSession({
      id: "other-cwd",
      sessionCwd: path.join(os.tmpdir(), "other-cwd"),
      target: "codex",
      startedAtMs: baseMs + 3_000,
      firstPrompt: "other cwd request",
    });
    insertSummary({
      sessionId: "other-cwd",
      sessionCwd: path.join(os.tmpdir(), "other-cwd"),
      status: "landed",
      lastIntentTsMs: baseMs + 3_500,
      summaryText: "This should not be injected.",
    });
    insertSession({
      id: "current",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 4_000,
      firstPrompt: "current request",
    });
    insertSummary({
      sessionId: "current",
      sessionCwd: cwd,
      status: "active",
      lastIntentTsMs: baseMs + 4_500,
      summaryText: "The current session should be excluded.",
    });

    const context = buildSessionStartRecentHistoryContext({
      session_id: "current",
      cwd,
    });

    expect(context).toContain(`Panopticon recent history for cwd: ${cwd}`);
    expect(context).toContain("background memory only");
    expect(context).toContain("session_summary_detail");
    expect(context).toContain("timeline");
    expect(context).toContain("compact session summary preview");
    expect(context).toContain(
      "Added SessionStart context injection for recent history.",
    );
    expect(context).toContain("[codex/landed]");
    expect(context).toContain("session_id=previous");
    expect(context).toContain("2 intents, 3 edits, 2 landed, 1 open");
    expect(context).not.toContain("This should not be injected.");
    expect(context).not.toContain("The current session should be excluded.");
  });

  it("uses read-only summary projections instead of hook-local prompt fallback", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "read-only",
      sessionCwd: cwd,
      target: "claude",
      startedAtMs: baseMs + 5_000,
      firstPrompt: "Investigate hook timing and sequencing.",
    });
    insertSummary({
      sessionId: "read-only",
      sessionCwd: cwd,
      status: "read-only",
      lastIntentTsMs: baseMs + 5_500,
      summaryText: "Read-only: Investigated hook timing and sequencing.",
    });

    const context = buildSessionStartRecentHistoryContext({
      session_id: "current",
      cwd,
    });

    expect(context).toContain("[claude/read-only]");
    expect(context).toContain(
      "Read-only: Investigated hook timing and sequencing.",
    );
  });

  it("matches sessions by session_cwds even when the summary cwd differs", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "cwd-history",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 6_000,
      firstPrompt: "Continue recent history work.",
    });
    insertSummary({
      sessionId: "cwd-history",
      sessionCwd: path.join(os.tmpdir(), "summary-projection-cwd"),
      status: "mixed",
      lastIntentTsMs: baseMs + 6_500,
      summaryText: "Continued recent-history context from the observed cwd.",
    });

    const context = buildSessionStartRecentHistoryContext({
      session_id: "current",
      cwd,
    });

    expect(context).toContain("session_id=cwd-history");
    expect(context).toContain(
      "Continued recent-history context from the observed cwd.",
    );
  });

  it("does not inject matching cwd sessions older than the recent-history window", () => {
    const oldBaseMs = Date.now() - 31 * DAY_MS;
    insertSession({
      id: "old-history",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: oldBaseMs,
      firstPrompt: "Ancient request.",
    });
    insertSummary({
      sessionId: "old-history",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: oldBaseMs + 1_000,
      summaryText: "This old matching cwd history should not be injected.",
    });

    const context = buildSessionStartRecentHistoryContext({
      session_id: "current",
      cwd,
    });

    expect(context).toBeNull();
  });

  it("does not treat a fresh projection timestamp as recent source activity", () => {
    const oldBaseMs = Date.now() - 31 * DAY_MS;
    insertSession({
      id: "old-reprojected-history",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: oldBaseMs,
      firstPrompt: "Ancient request with a fresh projection.",
    });
    insertSummary({
      sessionId: "old-reprojected-history",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: oldBaseMs + 1_000,
      projectedAtMs: Date.now() - 1_000,
      summaryText:
        "This old reprojected matching cwd history should not be injected.",
    });

    const context = buildSessionStartRecentHistoryContext({
      session_id: "current",
      cwd,
    });

    expect(context).toBeNull();
  });

  it("excludes known automated sessions from recent history", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "automated",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 7_000,
      firstPrompt: "internal summary run",
      isAutomated: true,
    });
    insertSummary({
      sessionId: "automated",
      sessionCwd: cwd,
      status: "read-only",
      lastIntentTsMs: baseMs + 7_500,
      summaryText: "Automated summary should not be injected.",
    });

    expect(
      buildSessionStartRecentHistoryContext({ session_id: "current", cwd }),
    ).toBeNull();
  });

  it("does not require an affirmative interactive classification", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "not-known-automated",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 8_000,
      firstPrompt: "Continue normal work.",
    });
    insertSummary({
      sessionId: "not-known-automated",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: baseMs + 8_500,
      summaryText: "Normal work should still be injected.",
    });

    const context = buildSessionStartRecentHistoryContext({
      session_id: "current",
      cwd,
    });

    expect(context).toContain("session_id=not-known-automated");
    expect(context).toContain("Normal work should still be injected.");
  });

  it("returns null when there is no cwd or no matching history", () => {
    expect(
      buildSessionStartRecentHistoryContext({ session_id: "current" }),
    ).toBeNull();
    expect(
      buildSessionStartRecentHistoryContext({
        session_id: "current",
        cwd: path.join(os.tmpdir(), "empty-cwd"),
      }),
    ).toBeNull();
  });

  it("formats prompt-relevant local context for UserPromptSubmit", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "relevant",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 1_000,
      firstPrompt: "Earlier UserPromptSubmit local data work.",
    });
    insertSummary({
      sessionId: "relevant",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: baseMs + 2_000,
      summaryText:
        "Implemented user_prompt_submit local data context injection for prompt relevance.",
    });
    insertSession({
      id: "unrelated",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 3_000,
      firstPrompt: "Packaging cleanup.",
    });
    insertSummary({
      sessionId: "unrelated",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: baseMs + 3_500,
      summaryText: "Updated npm packaging and install verification.",
    });
    insertSession({
      id: "current",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 4_000,
      firstPrompt: "Current request.",
    });
    insertSummary({
      sessionId: "current",
      sessionCwd: cwd,
      status: "active",
      lastIntentTsMs: baseMs + 4_500,
      summaryText:
        "Current UserPromptSubmit local data work should not be injected.",
    });

    const context = buildUserPromptSubmitLocalContext({
      session_id: "current",
      cwd,
      prompt: "ok lets do the user_prompt_submit using local data first",
    });

    expect(context).toContain("Panopticon prompt-relevant local context");
    expect(context).toContain(`cwd: ${cwd}`);
    expect(context).toContain("background memory only");
    expect(context).toContain("session_summary_detail");
    expect(context).toContain("timeline");
    expect(context).toContain(
      "Implemented user_prompt_submit local data context injection",
    );
    expect(context).toContain("session_id=relevant");
    expect(context).not.toContain("Updated npm packaging");
    expect(context).not.toContain("should not be injected");
  });

  it("uses repository scope for UserPromptSubmit when cwd is absent", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "repo-match",
      sessionCwd: path.join(os.tmpdir(), "different-cwd"),
      target: "codex",
      startedAtMs: baseMs + 1_000,
      firstPrompt: "Prompt context work.",
    });
    insertSummary({
      sessionId: "repo-match",
      sessionCwd: path.join(os.tmpdir(), "different-cwd"),
      repository: "fml-inc/panopticon",
      status: "landed",
      lastIntentTsMs: baseMs + 2_000,
      summaryText: "Added prompt-aware local memory lookup.",
    });

    const context = buildUserPromptSubmitLocalContext({
      session_id: "current",
      repository: "fml-inc/panopticon",
      prompt: "prompt-aware local memory lookup",
    });

    expect(context).toContain("repository: fml-inc/panopticon");
    expect(context).toContain("session_id=repo-match");
    expect(context).toContain("Added prompt-aware local memory lookup.");
  });

  it("excludes known automated sessions from UserPromptSubmit context", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "automated-prompt-context",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 1_000,
      firstPrompt: "UserPromptSubmit local data automation.",
      isAutomated: true,
    });
    insertSummary({
      sessionId: "automated-prompt-context",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: baseMs + 2_000,
      summaryText: "UserPromptSubmit local data automation should not appear.",
    });

    expect(
      buildUserPromptSubmitLocalContext({
        session_id: "current",
        cwd,
        prompt: "userpromptsubmit local data automation",
      }),
    ).toBeNull();
  });

  it("returns null for weak generic UserPromptSubmit terms", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "generic-match",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 1_000,
      firstPrompt: "Add app mode.",
    });
    insertSummary({
      sessionId: "generic-match",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: baseMs + 2_000,
      summaryText: "Added app mode and todo cleanup.",
    });

    expect(
      buildUserPromptSubmitLocalContext({
        session_id: "current",
        cwd,
        prompt: "add dark mode to a todo app",
      }),
    ).toBeNull();
  });

  // First-prompt injection is disabled at the ingest layer
  // (isFirstUserPromptSubmit), not in this builder. The builder always
  // applies mid-session semantics; SessionStart-history duplication on the
  // first prompt is prevented structurally by never reaching this builder.
  it("applies mid-session semantics for every prompt that reaches it", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "recent-sessionstart-context",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 1_000,
      firstPrompt: "UserPromptSubmit local data work.",
    });
    insertSummary({
      sessionId: "recent-sessionstart-context",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: baseMs + 2_000,
      summaryText: "Implemented user_prompt_submit local data context.",
    });

    expect(
      buildSessionStartRecentHistoryContext({ session_id: "current", cwd }),
    ).toContain("session_id=recent-sessionstart-context");
    expect(
      buildUserPromptSubmitLocalContext({
        session_id: "current",
        cwd,
        prompt: "user_prompt_submit local data",
      }),
    ).toContain("session_id=recent-sessionstart-context");
  });

  it("isFirstUserPromptSubmit gates the first prompt only", () => {
    const db = getDb();
    const insertEvent = () =>
      db
        .prepare(
          `INSERT INTO hook_events (session_id, event_type, timestamp_ms, payload)
           VALUES (?, 'UserPromptSubmit', ?, ?)`,
        )
        .run("gate-session", Date.now(), Buffer.from("{}"));

    expect(isFirstUserPromptSubmit("gate-session")).toBe(true);
    insertEvent();
    expect(isFirstUserPromptSubmit("gate-session")).toBe(true);
    insertEvent();
    expect(isFirstUserPromptSubmit("gate-session")).toBe(false);
  });

  it("does not inject prompt context from future activity during replay", () => {
    const baseMs = Date.now() - 20_000;
    insertSession({
      id: "future-match",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 10_000,
      firstPrompt: "Future rare_topic injection work.",
    });
    insertSummary({
      sessionId: "future-match",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: baseMs + 12_000,
      summaryText:
        "Implemented rare_topic injection after the replayed prompt.",
    });

    expect(
      buildUserPromptSubmitLocalContext({
        session_id: "current",
        cwd,
        prompt: "rare_topic injection",
        now_ms: baseMs + 5_000,
      }),
    ).toBeNull();
  });

  it("prioritizes strong prompt terms that appear after generic terms", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "late-term-match",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 1_000,
      firstPrompt: "Raretopic injection work.",
    });
    insertSummary({
      sessionId: "late-term-match",
      sessionCwd: cwd,
      status: "landed",
      lastIntentTsMs: baseMs + 2_000,
      summaryText: "Implemented rare_topic injection for prompt lookup.",
    });

    const context = buildUserPromptSubmitLocalContext({
      session_id: "current",
      cwd,
      prompt:
        "review code worktree workspace repo github local session prompt context build install rare_topic injection",
    });

    expect(context).toContain("session_id=late-term-match");
    expect(context).toContain("Implemented rare_topic injection");
  });

  it("returns null for a hook smoke-test prompt with no related history", () => {
    const context = buildUserPromptSubmitLocalContext({
      session_id: "current",
      cwd,
      prompt: "Reply with exactly: panopticon hook smoke test",
    });

    expect(context).toBeNull();
  });
});

function insertSession(opts: {
  id: string;
  sessionCwd: string;
  target: string;
  startedAtMs: number;
  firstPrompt: string;
  isAutomated?: boolean;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (
       session_id, target, started_at_ms, first_prompt, has_hooks, is_automated
     )
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(
    opts.id,
    opts.target,
    opts.startedAtMs,
    opts.firstPrompt,
    opts.isAutomated ? 1 : 0,
  );
  db.prepare(
    `INSERT INTO session_cwds (session_id, cwd, first_seen_ms)
     VALUES (?, ?, ?)`,
  ).run(opts.id, opts.sessionCwd, opts.startedAtMs);
}

function insertSummary(opts: {
  sessionId: string;
  sessionCwd: string;
  repository?: string | null;
  status: string;
  lastIntentTsMs: number;
  projectedAtMs?: number;
  sourceLastSeenAtMs?: number | null;
  summaryText: string;
}): void {
  const db = getDb();
  const key = `ss:local:${opts.sessionId}`;
  db.prepare(
    `INSERT INTO session_summaries (
       session_summary_key, session_id, repository, cwd, title, status,
       last_intent_ts_ms, intent_count, edit_count, landed_edit_count,
       open_edit_count, summary_text, projection_hash, projected_at_ms,
       source_last_seen_at_ms
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 2, 3, 2, 1, ?, 'hash', ?, ?)`,
  ).run(
    key,
    opts.sessionId,
    opts.repository ?? null,
    opts.sessionCwd,
    `title for ${opts.sessionId}`,
    opts.status,
    opts.lastIntentTsMs,
    opts.summaryText,
    opts.projectedAtMs ?? opts.lastIntentTsMs,
    opts.sourceLastSeenAtMs ?? null,
  );
}
