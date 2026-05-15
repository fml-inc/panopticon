import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const _fs = require("node:fs");
  const _os = require("node:os");
  const _path = require("node:path");
  const tmpDir = _path.join(_os.tmpdir(), "pano-session-classifications-test");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: _path.join(tmpDir, "panopticon.db"),
      port: 4318,
      host: "127.0.0.1",
      serverPidFile: _path.join(tmpDir, "panopticon.pid"),
    },
    ensureDataDir: () => _fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { updateSessionMessageCounts, upsertSession } from "../db/store.js";
import { rebuildSessionClassifications } from "./project.js";

describe("session classifications", () => {
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

  it("writes only deterministic interactive and automated rows", () => {
    insertSession({
      sessionId: "interactive-codex",
      target: "codex",
      firstPrompt: "continue the implementation",
      userMessageCount: 1,
      hasUserPromptSubmit: true,
    });
    insertSession({
      sessionId: "automated-model",
      target: "codex",
      firstPrompt: "review this implementation",
      model: "codex-auto-review",
      userMessageCount: 1,
      hasUserPromptSubmit: true,
    });
    insertSession({
      sessionId: "automated-subagent",
      target: "claude",
      firstPrompt: "inspect the auth module",
      userMessageCount: 1,
      parentSessionId: "parent-session",
      relationshipType: "subagent",
    });
    insertSession({
      sessionId: "automated-headless",
      target: "codex",
      firstPrompt: "summarize this session",
      userMessageCount: 1,
      project: "codex-headless",
      hasUserPromptSubmit: true,
    });
    insertSession({
      sessionId: "unclassified-prompt-template",
      target: "claude",
      firstPrompt: "You are a code reviewer. Review this diff.",
      userMessageCount: 1,
    });
    insertSession({
      sessionId: "unclassified-scanner-only",
      target: "codex",
      firstPrompt: "inspect this project",
      userMessageCount: 1,
    });

    const result = rebuildSessionClassifications({ nowMs: 12_345 });
    const rows = getClassifications();

    expect(result).toMatchObject({
      sessions: 6,
      classified: 4,
      interactive: 1,
      automated: 3,
      unclassified: 2,
    });
    expect(rows).toEqual([
      {
        session_id: "automated-headless",
        classification: "automated",
        reason: "project=codex-headless",
        classifier_version: 1,
        computed_at_ms: 12_345,
      },
      {
        session_id: "automated-model",
        classification: "automated",
        reason: "model=codex-auto-review",
        classifier_version: 1,
        computed_at_ms: 12_345,
      },
      {
        session_id: "automated-subagent",
        classification: "automated",
        reason: "relationship_type=subagent",
        classifier_version: 1,
        computed_at_ms: 12_345,
      },
      {
        session_id: "interactive-codex",
        classification: "interactive",
        reason:
          "top-level codex session with UserPromptSubmit hook and no deterministic automation markers",
        classifier_version: 1,
        computed_at_ms: 12_345,
      },
    ]);
  });

  it("refreshes classification when message counts are updated", () => {
    upsertSession({
      session_id: "live-codex",
      target: "codex",
      first_prompt: "pick up this thread",
    });
    expect(getClassifications()).toEqual([]);

    getDb()
      .prepare(
        `UPDATE sessions
         SET hook_event_type_counts = ?
         WHERE session_id = ?`,
      )
      .run(JSON.stringify({ UserPromptSubmit: 1 }), "live-codex");
    getDb()
      .prepare(
        `INSERT INTO messages
         (session_id, ordinal, role, content, is_system, sync_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("live-codex", 0, "user", "pick up this thread", 0, "msg-1");
    updateSessionMessageCounts("live-codex");

    expect(getClassifications()).toMatchObject([
      {
        session_id: "live-codex",
        classification: "interactive",
      },
    ]);
  });
});

function insertSession(opts: {
  sessionId: string;
  target: string;
  firstPrompt: string;
  userMessageCount: number;
  model?: string;
  project?: string;
  cwd?: string;
  hasUserPromptSubmit?: boolean;
  parentSessionId?: string;
  relationshipType?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (
         session_id, target, first_prompt, model, project, cwd,
         user_message_count, hook_event_type_counts, parent_session_id,
         relationship_type
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.sessionId,
      opts.target,
      opts.firstPrompt,
      opts.model ?? null,
      opts.project ?? null,
      opts.cwd ?? null,
      opts.userMessageCount,
      JSON.stringify(opts.hasUserPromptSubmit ? { UserPromptSubmit: 1 } : {}),
      opts.parentSessionId ?? null,
      opts.relationshipType ?? "",
    );
}

function getClassifications(): Array<{
  session_id: string;
  classification: "interactive" | "automated";
  reason: string;
  classifier_version: number;
  computed_at_ms: number;
}> {
  return getDb()
    .prepare(
      `SELECT session_id, classification, reason, classifier_version,
              computed_at_ms
       FROM session_classifications
       ORDER BY session_id ASC`,
    )
    .all() as Array<{
    session_id: string;
    classification: "interactive" | "automated";
    reason: string;
    classifier_version: number;
    computed_at_ms: number;
  }>;
}
