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
import { refreshSessionClassification } from "../session_classifications/project.js";
import { buildSessionStartRecentHistoryContext } from "./session-context.js";

const cwd = path.join(os.tmpdir(), "panopticon-session-context-cwd");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("buildSessionStartRecentHistoryContext", () => {
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

  it("excludes sessions without an interactive classification", () => {
    const baseMs = Date.now() - 10_000;
    insertSession({
      id: "automated",
      sessionCwd: cwd,
      target: "codex",
      startedAtMs: baseMs + 7_000,
      firstPrompt: "You are a code reviewer.",
    });
    insertSummary({
      sessionId: "automated",
      sessionCwd: cwd,
      status: "read-only",
      lastIntentTsMs: baseMs + 7_500,
      summaryText: "Automated review should not be injected.",
    });

    expect(
      buildSessionStartRecentHistoryContext({ session_id: "current", cwd }),
    ).toBeNull();
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
});

function insertSession(opts: {
  id: string;
  sessionCwd: string;
  target: string;
  startedAtMs: number;
  firstPrompt: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (
       session_id, target, started_at_ms, first_prompt, user_message_count, has_hooks
     )
     VALUES (?, ?, ?, ?, 1, 1)`,
  ).run(opts.id, opts.target, opts.startedAtMs, opts.firstPrompt);
  db.prepare(
    `INSERT INTO session_cwds (session_id, cwd, first_seen_ms)
     VALUES (?, ?, ?)`,
  ).run(opts.id, opts.sessionCwd, opts.startedAtMs);
  refreshSessionClassification(opts.id, opts.startedAtMs);
}

function insertSummary(opts: {
  sessionId: string;
  sessionCwd: string;
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
       session_summary_key, session_id, cwd, title, status,
       last_intent_ts_ms, intent_count, edit_count, landed_edit_count,
       open_edit_count, summary_text, projection_hash, projected_at_ms,
       source_last_seen_at_ms
     )
     VALUES (?, ?, ?, ?, ?, ?, 2, 3, 2, 1, ?, 'hash', ?, ?)`,
  ).run(
    key,
    opts.sessionId,
    opts.sessionCwd,
    `title for ${opts.sessionId}`,
    opts.status,
    opts.lastIntentTsMs,
    opts.summaryText,
    opts.projectedAtMs ?? opts.lastIntentTsMs,
    opts.sourceLastSeenAtMs ?? null,
  );
}
