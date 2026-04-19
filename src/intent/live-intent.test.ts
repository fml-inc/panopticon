import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const tmpDir = _path.join(_os.tmpdir(), "pano-intent-live-test");
  _fs.mkdirSync(tmpDir, { recursive: true });
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

import { rebuildActiveClaims } from "../claims/canonicalize.js";
import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { insertHookEvent } from "../db/store.js";
import {
  rebuildIntentClaimsFromHooks,
  recordIntentClaimsFromHookEvent,
} from "./asserters/from_hooks.js";
import { rebuildIntentClaimsFromScanner } from "./asserters/from_scanner.js";
import { reconcileLandedClaimsFromDisk } from "./asserters/landed_from_disk.js";
import { rebuildIntentProjection } from "./project.js";

const SESSION = "live-hook-session";
let scratchDir: string;

beforeAll(() => {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb();
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-intent-live-"));
});

afterAll(() => {
  closeDb();
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM claim_evidence").run();
  db.prepare("DELETE FROM active_claims").run();
  db.prepare("DELETE FROM claims").run();
  db.prepare("DELETE FROM intent_edits").run();
  db.prepare("DELETE FROM intent_units_fts").run();
  db.prepare("DELETE FROM intent_units").run();
  db.prepare("DELETE FROM hook_events").run();
  db.prepare("DELETE FROM tool_calls").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM session_repositories").run();
  db.prepare("DELETE FROM session_cwds").run();
  db.prepare("DELETE FROM sessions").run();
});

function insertUserMessage(args: {
  sessionId: string;
  ordinal: number;
  content: string;
  timestampMs: number;
  uuid?: string | null;
}): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO messages
       (session_id, ordinal, role, content, timestamp_ms, uuid)
     VALUES (?, ?, 'user', ?, ?, ?)`,
  ).run(
    args.sessionId,
    args.ordinal,
    args.content,
    args.timestampMs,
    args.uuid ?? null,
  );
  return (
    db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
}

function insertAssistantMessage(args: {
  sessionId: string;
  ordinal: number;
  content?: string;
  timestampMs: number;
}): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO messages
       (session_id, ordinal, role, content, timestamp_ms)
     VALUES (?, ?, 'assistant', ?, ?)`,
  ).run(args.sessionId, args.ordinal, args.content ?? "", args.timestampMs);
  return (
    db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
}

function insertToolCall(args: {
  messageId: number;
  sessionId: string;
  toolName: string;
  inputJson: Record<string, unknown>;
  toolUseId?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO tool_calls
         (message_id, session_id, tool_name, category, tool_use_id, input_json)
       VALUES (?, ?, ?, 'file', ?, ?)`,
    )
    .run(
      args.messageId,
      args.sessionId,
      args.toolName,
      args.toolUseId ?? null,
      JSON.stringify(args.inputJson),
    );
}

function insertSession(args: {
  sessionId: string;
  cwd?: string | null;
  endedAtMs?: number | null;
  hasScanner?: boolean;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions
         (session_id, cwd, ended_at_ms, has_scanner, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      args.sessionId,
      args.cwd ?? null,
      args.endedAtMs ?? null,
      args.hasScanner ? 1 : 0,
      Date.now(),
    );
}

describe("live hook claims", () => {
  it("keeps the same intent subject when scanner messages arrive later", () => {
    const promptId = insertHookEvent({
      session_id: SESSION,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "add retries" },
    });
    recordIntentClaimsFromHookEvent({
      sessionId: SESSION,
      eventType: "UserPromptSubmit",
      hookEventId: promptId,
      timestampMs: 1000,
      payload: { prompt: "add retries" },
    });

    insertUserMessage({
      sessionId: SESSION,
      ordinal: 1,
      content: "add retries",
      timestampMs: 1000,
      uuid: "msg-late",
    });

    const editId = insertHookEvent({
      session_id: SESSION,
      event_type: "PostToolUse",
      timestamp_ms: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "/tmp/retries.ts",
          old_string: "old",
          new_string: "new",
        },
      },
    });
    recordIntentClaimsFromHookEvent({
      sessionId: SESSION,
      eventType: "PostToolUse",
      hookEventId: editId,
      timestampMs: 1100,
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "/tmp/retries.ts",
          old_string: "old",
          new_string: "new",
        },
      },
    });

    const db = getDb();
    const intentSubjects = (
      db
        .prepare(
          `SELECT DISTINCT subject
           FROM claims
           WHERE predicate = 'intent/session' AND value_text = ?`,
        )
        .all(SESSION) as Array<{ subject: string }>
    ).map((row) => row.subject);
    const editIntentRefs = (
      db
        .prepare(
          `SELECT DISTINCT value_text
           FROM claims
           WHERE predicate = 'edit/part-of-intent'`,
        )
        .all() as Array<{ value_text: string }>
    ).map((row) => row.value_text);

    expect(intentSubjects).toEqual(["intent:live-hook-session:user:0"]);
    expect(editIntentRefs).toEqual(["intent:live-hook-session:user:0"]);
  });

  it("keeps the first close boundary instead of stretching across later stops", () => {
    const promptId = insertHookEvent({
      session_id: SESSION,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "ship it" },
    });
    recordIntentClaimsFromHookEvent({
      sessionId: SESSION,
      eventType: "UserPromptSubmit",
      hookEventId: promptId,
      timestampMs: 1000,
      payload: { prompt: "ship it" },
    });

    for (const [ts, type] of [
      [1100, "Stop"],
      [1200, "Stop"],
      [1300, "SessionEnd"],
    ] as const) {
      const hookId = insertHookEvent({
        session_id: SESSION,
        event_type: type,
        timestamp_ms: ts,
        payload: { session_id: SESSION },
      });
      recordIntentClaimsFromHookEvent({
        sessionId: SESSION,
        eventType: type,
        hookEventId: hookId,
        timestampMs: ts,
        payload: { session_id: SESSION },
      });
    }

    const active = getDb()
      .prepare(
        `SELECT c.value_num
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.predicate = 'intent/closed-at-ms'`,
      )
      .get() as { value_num: number };

    expect(active.value_num).toBe(1100);
  });
});

describe("session-scoped rebuilds", () => {
  it("do not wipe claims for other sessions", () => {
    for (const sessionId of ["session-a", "session-b"]) {
      insertHookEvent({
        session_id: sessionId,
        event_type: "UserPromptSubmit",
        timestamp_ms: 1000,
        payload: { prompt: `prompt ${sessionId}` },
      });
    }

    rebuildIntentClaimsFromHooks();
    rebuildActiveClaims();
    rebuildIntentClaimsFromHooks({ sessionId: "session-a" });
    rebuildActiveClaims();

    const remaining = (
      getDb()
        .prepare(
          `SELECT value_text
           FROM claims
           WHERE predicate = 'intent/session'
           ORDER BY value_text ASC`,
        )
        .all() as Array<{ value_text: string }>
    ).map((row) => row.value_text);

    expect(remaining).toEqual(["session-a", "session-b"]);
  });
});

describe("scanner-only landed reconciliation", () => {
  it("classifies in-session overwrite as superseded without hook evidence", () => {
    const sessionId = "scanner-only";
    const file = path.join(scratchDir, "scanner-overwrite.ts");
    fs.writeFileSync(file, "FINAL");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "refine file",
      timestampMs: 1000,
      uuid: "msg-1",
    });
    const assistant1 = insertAssistantMessage({
      sessionId,
      ordinal: 2,
      timestampMs: 1100,
    });
    insertToolCall({
      messageId: assistant1,
      sessionId,
      toolName: "Edit",
      inputJson: {
        file_path: file,
        old_string: "ORIGINAL",
        new_string: "INTERMEDIATE",
      },
    });
    const assistant2 = insertAssistantMessage({
      sessionId,
      ordinal: 3,
      timestampMs: 1200,
    });
    insertToolCall({
      messageId: assistant2,
      sessionId,
      toolName: "Edit",
      inputJson: {
        file_path: file,
        old_string: "INTERMEDIATE",
        new_string: "FINAL",
      },
    });

    rebuildIntentClaimsFromScanner({ sessionId });
    rebuildActiveClaims();
    reconcileLandedClaimsFromDisk({ sessionId });
    rebuildIntentProjection({ sessionId });

    const edits = getDb()
      .prepare(
        `SELECT landed, landed_reason
         FROM intent_edits
         ORDER BY timestamp_ms ASC, id ASC`,
      )
      .all() as Array<{ landed: number | null; landed_reason: string | null }>;

    expect(edits).toEqual([
      { landed: 0, landed_reason: "overwritten_in_session" },
      { landed: 1, landed_reason: "present_in_file" },
    ]);
  });

  it("leaves foreign absolute paths unresolved instead of marking them deleted", () => {
    const sessionId = "scanner-only-foreign";
    const foreignFilePath =
      process.platform === "win32"
        ? "/workspace/panopticon/src/foreign.ts"
        : "C:\\repo\\foreign.ts";

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "edit foreign file",
      timestampMs: 1000,
      uuid: "msg-foreign",
    });
    const assistant = insertAssistantMessage({
      sessionId,
      ordinal: 2,
      timestampMs: 1100,
    });
    insertToolCall({
      messageId: assistant,
      sessionId,
      toolName: "Edit",
      inputJson: {
        file_path: foreignFilePath,
        old_string: "OLD",
        new_string: "NEW",
      },
    });

    rebuildIntentClaimsFromScanner({ sessionId });
    rebuildActiveClaims();
    reconcileLandedClaimsFromDisk({ sessionId });
    rebuildIntentProjection({ sessionId });

    const edits = getDb()
      .prepare(
        `SELECT landed, landed_reason
         FROM intent_edits
         WHERE session_id = ?`,
      )
      .all(sessionId) as Array<{ landed: number | null; landed_reason: string | null }>;

    expect(edits).toEqual([{ landed: null, landed_reason: null }]);
  });
});
