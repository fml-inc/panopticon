import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const dir = _fs.mkdtempSync(
    _path.join(_os.tmpdir(), "pano-reparse-derived-test-"),
  );
  return {
    config: {
      dataDir: dir,
      dbPath: _path.join(dir, "panopticon.db"),
      port: 14318,
      host: "127.0.0.1",
      serverPidFile: "",
      enableSessionSummaryProjections: false,
    },
    ensureDataDir: () => _fs.mkdirSync(dir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { insertHookEvent, upsertSession } from "../db/store.js";
import { rebuildDerivedStateFromRaw } from "./reparse.js";

beforeEach(() => {
  closeDb();
  try {
    fs.unlinkSync(config.dbPath);
  } catch {}
  try {
    fs.unlinkSync(`${config.dbPath}-wal`);
  } catch {}
  try {
    fs.unlinkSync(`${config.dbPath}-shm`);
  } catch {}
});

afterEach(() => {
  closeDb();
});

describe("rebuildDerivedStateFromRaw", () => {
  it("rebuilds hook-derived intents and edits idempotently", () => {
    const db = getDb();
    const sessionId = "hook-reparse-session";
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pano-reparse-derived-scratch-"),
    );
    const filePath = path.join(scratchDir, "hook-edit.ts");
    fs.writeFileSync(filePath, "new text");

    upsertSession({
      session_id: sessionId,
      target: "claude",
      started_at_ms: 1_700_000_000_000,
      first_prompt: "change file",
      has_hooks: 1,
    });

    db.prepare(
      `INSERT INTO messages (session_id, ordinal, role, content, timestamp_ms, is_system)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, 0, "user", "change file", 1_700_000_000_000, 0);

    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1_700_000_000_000,
      cwd: scratchDir,
      repository: scratchDir,
      target: "claude-code",
      payload: { prompt: "change file", session_id: sessionId },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1_700_000_000_100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      target: "claude-code",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: filePath,
          old_string: "old text",
          new_string: "new text",
        },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "Stop",
      timestamp_ms: 1_700_000_000_200,
      cwd: scratchDir,
      repository: scratchDir,
      target: "claude-code",
      payload: { session_id: sessionId },
    });

    const first = rebuildDerivedStateFromRaw();
    const countsAfterFirst = db
      .prepare(
        `SELECT COUNT(DISTINCT iu.id) AS intents,
                COUNT(ie.id) AS edits,
                SUM(CASE WHEN ie.landed = 1 THEN 1 ELSE 0 END) AS landed_edits
         FROM intent_units iu
         LEFT JOIN intent_edits ie ON ie.intent_unit_id = iu.id
         WHERE iu.session_id = ?`,
      )
      .get(sessionId) as {
      intents: number;
      edits: number;
      landed_edits: number | null;
    };

    expect(first.hookPrompts).toBe(1);
    expect(first.hookEdits).toBe(1);
    expect(first.projectedIntents).toBe(1);
    expect(first.projectedEdits).toBe(1);
    expect(countsAfterFirst).toEqual({
      intents: 1,
      edits: 1,
      landed_edits: 1,
    });

    const second = rebuildDerivedStateFromRaw();
    const countsAfterSecond = db
      .prepare(
        `SELECT COUNT(DISTINCT iu.id) AS intents,
                COUNT(ie.id) AS edits,
                SUM(CASE WHEN ie.landed = 1 THEN 1 ELSE 0 END) AS landed_edits
         FROM intent_units iu
         LEFT JOIN intent_edits ie ON ie.intent_unit_id = iu.id
         WHERE iu.session_id = ?`,
      )
      .get(sessionId) as {
      intents: number;
      edits: number;
      landed_edits: number | null;
    };

    expect(second.projectedIntents).toBe(1);
    expect(second.projectedEdits).toBe(1);
    expect(countsAfterSecond).toEqual(countsAfterFirst);

    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
});
