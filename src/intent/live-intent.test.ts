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

function rebuildMixedProjection(sessionId: string): void {
  rebuildIntentClaimsFromHooks({ sessionId });
  rebuildIntentClaimsFromScanner({ sessionId });
  rebuildActiveClaims();
  reconcileLandedClaimsFromDisk({ sessionId });
  rebuildActiveClaims();
  rebuildIntentProjection({ sessionId });
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

describe("mixed hook/scanner edit convergence", () => {
  it("projects one intent edit when hook and scanner see the same structured edit", () => {
    const sessionId = "mixed-shared-edit";
    const filePath = path.join(scratchDir, "mixed-shared-edit.ts");
    fs.writeFileSync(filePath, "NEXT");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "make the shared edit",
      timestampMs: 1000,
      uuid: "mixed-shared-user",
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
      toolUseId: "tool-shared-edit",
      inputJson: {
        file_path: "mixed-shared-edit.ts",
        old_string: "PREV",
        new_string: "NEXT",
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "make the shared edit" },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "mixed-shared-edit.ts",
          old_string: "PREV",
          new_string: "NEXT",
        },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "Stop",
      timestamp_ms: 2000,
      payload: { session_id: sessionId },
    });

    rebuildMixedProjection(sessionId);

    const distinctSubjects = (
      getDb()
        .prepare(
          `SELECT COUNT(DISTINCT subject) AS c
           FROM claims
           WHERE subject_kind = 'edit'
             AND predicate = 'edit/part-of-intent'
             AND value_text = ?`,
        )
        .get(`intent:${sessionId}:user:0`) as { c: number }
    ).c;
    const projected = getDb()
      .prepare(
        `SELECT file_path, tool_name
         FROM intent_edits
         WHERE session_id = ?`,
      )
      .all(sessionId) as Array<{ file_path: string; tool_name: string }>;

    expect(distinctSubjects).toBe(1);
    expect(projected).toEqual([{ file_path: filePath, tool_name: "Edit" }]);
  });

  it("keeps a later shared edit distinct from an earlier scanner-only apply_patch edit", () => {
    const sessionId = "mixed-scanner-first";
    const patchFilePath = path.join(scratchDir, "mixed-scanner-first-patch.ts");
    const sharedFilePath = path.join(
      scratchDir,
      "mixed-scanner-first-shared.ts",
    );
    fs.writeFileSync(patchFilePath, "export const patchValue = 1;\n");
    fs.writeFileSync(sharedFilePath, "SHARED");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "apply a patch and then a shared edit",
      timestampMs: 1000,
      uuid: "mixed-scanner-first-user",
    });
    const assistant1 = insertAssistantMessage({
      sessionId,
      ordinal: 2,
      timestampMs: 1100,
    });
    insertToolCall({
      messageId: assistant1,
      sessionId,
      toolName: "apply_patch",
      toolUseId: "tool-scanner-only-patch",
      inputJson: {
        input: [
          "*** Begin Patch",
          "*** Update File: mixed-scanner-first-patch.ts",
          "@@",
          "-export const patchValue = 0;",
          "+export const patchValue = 1;",
          "*** End Patch",
        ].join("\n"),
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
      toolUseId: "tool-shared-later-edit",
      inputJson: {
        file_path: "mixed-scanner-first-shared.ts",
        old_string: "PREV",
        new_string: "SHARED",
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "apply a patch and then a shared edit" },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1150,
      tool_name: "Bash",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "apply_patch ..." },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1200,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "mixed-scanner-first-shared.ts",
          old_string: "PREV",
          new_string: "SHARED",
        },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "Stop",
      timestamp_ms: 2000,
      payload: { session_id: sessionId },
    });

    rebuildMixedProjection(sessionId);

    const projected = getDb()
      .prepare(
        `SELECT file_path, tool_name
         FROM intent_edits
         WHERE session_id = ?
         ORDER BY file_path ASC, id ASC`,
      )
      .all(sessionId) as Array<{ file_path: string; tool_name: string }>;

    expect(projected).toEqual([
      { file_path: patchFilePath, tool_name: "apply_patch" },
      { file_path: sharedFilePath, tool_name: "Edit" },
    ]);
  });

  it("keeps multiple mixed-visibility edits in one intent without collisions or duplicates", () => {
    const sessionId = "mixed-multi-step";
    const firstFilePath = path.join(scratchDir, "mixed-multi-step-first.ts");
    const patchFilePath = path.join(scratchDir, "mixed-multi-step-patch.ts");
    const lastFilePath = path.join(scratchDir, "mixed-multi-step-last.ts");
    fs.writeFileSync(firstFilePath, "FIRST");
    fs.writeFileSync(patchFilePath, "export const patchValue = 1;\n");
    fs.writeFileSync(lastFilePath, "LAST");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "do several edits",
      timestampMs: 1000,
      uuid: "mixed-multi-step-user",
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
      toolUseId: "tool-first-shared-edit",
      inputJson: {
        file_path: "mixed-multi-step-first.ts",
        old_string: "PREV",
        new_string: "FIRST",
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
      toolName: "apply_patch",
      toolUseId: "tool-middle-scanner-patch",
      inputJson: {
        input: [
          "*** Begin Patch",
          "*** Update File: mixed-multi-step-patch.ts",
          "@@",
          "-export const patchValue = 0;",
          "+export const patchValue = 1;",
          "*** End Patch",
        ].join("\n"),
      },
    });
    const assistant3 = insertAssistantMessage({
      sessionId,
      ordinal: 4,
      timestampMs: 1300,
    });
    insertToolCall({
      messageId: assistant3,
      sessionId,
      toolName: "Edit",
      toolUseId: "tool-last-shared-edit",
      inputJson: {
        file_path: "mixed-multi-step-last.ts",
        old_string: "PREV",
        new_string: "LAST",
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "do several edits" },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "mixed-multi-step-first.ts",
          old_string: "PREV",
          new_string: "FIRST",
        },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1250,
      tool_name: "Bash",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "apply_patch ..." },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1300,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "mixed-multi-step-last.ts",
          old_string: "PREV",
          new_string: "LAST",
        },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "Stop",
      timestamp_ms: 2000,
      payload: { session_id: sessionId },
    });

    rebuildMixedProjection(sessionId);

    const distinctSubjects = (
      getDb()
        .prepare(
          `SELECT COUNT(DISTINCT subject) AS c
           FROM claims
           WHERE subject_kind = 'edit'
             AND predicate = 'edit/part-of-intent'
             AND value_text = ?`,
        )
        .get(`intent:${sessionId}:user:0`) as { c: number }
    ).c;
    const projected = getDb()
      .prepare(
        `SELECT file_path, tool_name
         FROM intent_edits
         WHERE session_id = ?
         ORDER BY timestamp_ms ASC, id ASC`,
      )
      .all(sessionId) as Array<{ file_path: string; tool_name: string }>;

    expect(distinctSubjects).toBe(3);
    expect(projected).toEqual([
      { file_path: firstFilePath, tool_name: "Edit" },
      { file_path: patchFilePath, tool_name: "apply_patch" },
      { file_path: lastFilePath, tool_name: "Edit" },
    ]);
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
    const activePrompt = getDb()
      .prepare(
        `SELECT c.value_text
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.predicate = 'intent/prompt-text' AND c.subject = ?`,
      )
      .get("intent:scanner-only:user:0") as { value_text: string };
    expect(activePrompt.value_text).toBe("refine file");
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
    reconcileLandedClaimsFromDisk({ sessionId });
    rebuildIntentProjection({ sessionId });

    const edits = getDb()
      .prepare(
        `SELECT landed, landed_reason
         FROM intent_edits
         WHERE session_id = ?`,
      )
      .all(sessionId) as Array<{
      landed: number | null;
      landed_reason: string | null;
    }>;

    expect(edits).toEqual([{ landed: null, landed_reason: null }]);
  });

  it("loads only the touched session active set when rebuilding one session", () => {
    const sessionCount = 24;
    const targetSessionId = "session-00";

    for (let i = 0; i < sessionCount; i += 1) {
      const sessionId = `session-${String(i).padStart(2, "0")}`;
      const filePath = path.join(scratchDir, `${sessionId}.ts`);
      fs.writeFileSync(filePath, `value-${i}`);

      insertSession({
        sessionId,
        cwd: scratchDir,
        endedAtMs: 2000 + i,
        hasScanner: true,
      });
      insertUserMessage({
        sessionId,
        ordinal: 1,
        content: `prompt ${i}`,
        timestampMs: 1000 + i,
        uuid: `msg-${i}`,
      });
      const assistant = insertAssistantMessage({
        sessionId,
        ordinal: 2,
        timestampMs: 1100 + i,
      });
      insertToolCall({
        messageId: assistant,
        sessionId,
        toolName: "Edit",
        inputJson: {
          file_path: filePath,
          old_string: "OLD",
          new_string: `value-${i}`,
        },
      });
    }

    rebuildIntentClaimsFromScanner();

    const landed = reconcileLandedClaimsFromDisk({
      sessionId: targetSessionId,
    });
    const projection = rebuildIntentProjection({ sessionId: targetSessionId });

    expect(landed.checked).toBe(1);
    expect(landed.activeIntentsLoaded).toBe(1);
    expect(landed.activeEditsLoaded).toBe(1);

    expect(projection.intents).toBe(1);
    expect(projection.edits).toBe(1);
    expect(projection.activeIntentsLoaded).toBe(1);
    expect(projection.activeEditsLoaded).toBe(1);
  });

  it("projects scanner-backed apply_patch edits into intent_edits", () => {
    const sessionId = "scanner-apply-patch";
    const filePath = path.join(scratchDir, "scanner-apply-patch.ts");
    fs.writeFileSync(filePath, "export const value = 1;\n");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "patch the file",
      timestampMs: 1000,
      uuid: "scanner-apply-patch-user",
    });
    const assistant = insertAssistantMessage({
      sessionId,
      ordinal: 2,
      timestampMs: 1100,
    });
    insertToolCall({
      messageId: assistant,
      sessionId,
      toolName: "apply_patch",
      inputJson: {
        input: [
          "*** Begin Patch",
          `*** Update File: ${filePath}`,
          "@@",
          "-export const value = 0;",
          "+export const value = 1;",
          "*** End Patch",
        ].join("\n"),
      },
    });

    rebuildIntentClaimsFromScanner({ sessionId });
    reconcileLandedClaimsFromDisk({ sessionId });
    rebuildIntentProjection({ sessionId });

    const row = getDb()
      .prepare(
        `SELECT file_path, tool_name, landed
         FROM intent_edits
         WHERE session_id = ?`,
      )
      .get(sessionId) as
      | { file_path: string; tool_name: string; landed: number | null }
      | undefined;

    expect(row).toEqual({
      file_path: filePath,
      tool_name: "apply_patch",
      landed: 1,
    });
  });

  it("keeps scanner-backed apply_patch edits for hook-backed sessions", () => {
    const sessionId = "hook-backed-scanner-apply-patch";
    const filePath = path.join(
      scratchDir,
      "hook-backed-scanner-apply-patch.ts",
    );
    fs.writeFileSync(filePath, "export const value = 1;\n");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "patch the file",
      timestampMs: 1000,
      uuid: "hook-backed-scanner-apply-patch-user",
    });
    const assistant = insertAssistantMessage({
      sessionId,
      ordinal: 2,
      timestampMs: 1100,
    });
    insertToolCall({
      messageId: assistant,
      sessionId,
      toolName: "apply_patch",
      inputJson: {
        input: [
          "*** Begin Patch",
          `*** Update File: ${filePath}`,
          "@@",
          "-export const value = 0;",
          "+export const value = 1;",
          "*** End Patch",
        ].join("\n"),
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      payload: { prompt: "patch the file" },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1150,
      tool_name: "Bash",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "apply_patch ..." },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "Stop",
      timestamp_ms: 2000,
      payload: { session_id: sessionId },
    });

    rebuildIntentClaimsFromHooks({ sessionId });
    rebuildIntentClaimsFromScanner({ sessionId });
    rebuildActiveClaims();
    reconcileLandedClaimsFromDisk({ sessionId });
    rebuildActiveClaims();
    rebuildIntentProjection({ sessionId });

    const row = getDb()
      .prepare(
        `SELECT file_path, tool_name, landed
         FROM intent_edits
         WHERE session_id = ?`,
      )
      .get(sessionId) as
      | { file_path: string; tool_name: string; landed: number | null }
      | undefined;

    expect(row).toEqual({
      file_path: filePath,
      tool_name: "apply_patch",
      landed: 1,
    });
  });
});
