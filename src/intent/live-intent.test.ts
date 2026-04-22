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
import { buildMessageSyncId, buildToolCallSyncId } from "../db/sync-ids.js";
import {
  rebuildIntentClaimsFromHooks,
  recordIntentClaimsFromHookEvent,
} from "./asserters/from_hooks.js";
import { rebuildIntentClaimsFromScanner } from "./asserters/from_scanner.js";
import { reconcileLandedClaimsFromDisk } from "./asserters/landed_from_disk.js";
import { loadActiveEdits } from "./claimViews.js";
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
  db.prepare("DELETE FROM evidence_ref_paths").run();
  db.prepare("DELETE FROM evidence_refs").run();
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
       (session_id, ordinal, role, content, timestamp_ms, uuid, sync_id)
     VALUES (?, ?, 'user', ?, ?, ?, ?)`,
  ).run(
    args.sessionId,
    args.ordinal,
    args.content,
    args.timestampMs,
    args.uuid ?? null,
    buildMessageSyncId(args.sessionId, args.ordinal, args.uuid),
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
       (session_id, ordinal, role, content, timestamp_ms, sync_id)
     VALUES (?, ?, 'assistant', ?, ?, ?)`,
  ).run(
    args.sessionId,
    args.ordinal,
    args.content ?? "",
    args.timestampMs,
    buildMessageSyncId(args.sessionId, args.ordinal),
  );
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
  const message = getDb()
    .prepare("SELECT sync_id FROM messages WHERE id = ?")
    .get(args.messageId) as { sync_id: string };
  getDb()
    .prepare(
      `INSERT INTO tool_calls
         (message_id, session_id, call_index, tool_name, category, tool_use_id, input_json, sync_id)
       VALUES (?, ?, 0, ?, 'file', ?, ?, ?)`,
    )
    .run(
      args.messageId,
      args.sessionId,
      args.toolName,
      args.toolUseId ?? null,
      JSON.stringify(args.inputJson),
      buildToolCallSyncId(message.sync_id, 0, args.toolUseId),
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

function insertSessionRepository(args: {
  sessionId: string;
  repository: string;
  firstSeenMs?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO session_repositories
         (session_id, repository, first_seen_ms)
       VALUES (?, ?, ?)`,
    )
    .run(args.sessionId, args.repository, args.firstSeenMs ?? Date.now());
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

  it("uses typed hook-event evidence refs for hook-backed edits", () => {
    const sessionId = "hook-typed-evidence";
    const repository = scratchDir;
    insertSession({
      sessionId,
      endedAtMs: 2000,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "make the hook edit",
      timestampMs: 1000,
      uuid: "hook-typed-evidence-user",
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      repository,
      payload: { prompt: "make the hook edit" },
    });
    const _editId = insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1100,
      repository,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "/tmp/hook-typed-evidence.ts",
          old_string: "OLD",
          new_string: "NEW",
        },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "Stop",
      timestamp_ms: 2000,
      payload: { session_id: sessionId },
    });

    rebuildIntentClaimsFromHooks({ sessionId });
    rebuildActiveClaims();

    const [activeEdit] = [...loadActiveEdits({ sessionId }).values()];
    expect(activeEdit?.payloadEvidence).toMatchObject({
      refId: expect.any(Number),
      kind: "hook_event",
      refKey: expect.stringMatching(/^hook_event:/),
    });

    const evidenceRow = getDb()
      .prepare(
        `SELECT DISTINCT er.repository, er.file_path
         FROM claim_evidence ce
         JOIN claims c ON c.id = ce.claim_id
         JOIN evidence_refs er ON er.id = ce.evidence_ref_id
         WHERE c.subject = ?
         LIMIT 1`,
      )
      .get(activeEdit?.editKey) as
      | { repository: string | null; file_path: string | null }
      | undefined;
    expect(evidenceRow).toEqual({
      repository,
      file_path: "/tmp/hook-typed-evidence.ts",
    });
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
  it("keeps scanner-only intents when a session later gains partial hook coverage", () => {
    const sessionId = "partial-hook-coverage";
    const filePath = path.join(scratchDir, "partial-hook-coverage.ts");
    fs.writeFileSync(filePath, "NEW");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 3000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "first prompt",
      timestampMs: 1000,
      uuid: "partial-hook-user-1",
    });
    const firstAssistant = insertAssistantMessage({
      sessionId,
      ordinal: 2,
      timestampMs: 1100,
    });
    insertToolCall({
      messageId: firstAssistant,
      sessionId,
      toolName: "Edit",
      toolUseId: "tool-partial-hook-1",
      inputJson: {
        file_path: "partial-hook-coverage.ts",
        old_string: "OLD",
        new_string: "NEW",
      },
    });
    insertUserMessage({
      sessionId,
      ordinal: 3,
      content: "second prompt",
      timestampMs: 2000,
      uuid: "partial-hook-user-2",
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 2000,
      payload: { prompt: "second prompt" },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "Stop",
      timestamp_ms: 3000,
      payload: { session_id: sessionId },
    });

    rebuildMixedProjection(sessionId);

    const intents = getDb()
      .prepare(
        `SELECT intent_key, prompt_text
         FROM intent_units
         WHERE session_id = ?
         ORDER BY prompt_ts_ms ASC, intent_key ASC`,
      )
      .all(sessionId) as Array<{ intent_key: string; prompt_text: string }>;
    const edits = getDb()
      .prepare(
        `SELECT edit_key, session_id, file_path
         FROM intent_edits
         WHERE session_id = ?
         ORDER BY edit_key ASC`,
      )
      .all(sessionId) as Array<{
      edit_key: string;
      session_id: string;
      file_path: string;
    }>;

    expect(intents).toEqual([
      {
        intent_key: `intent:${sessionId}:user:0`,
        prompt_text: "first prompt",
      },
      {
        intent_key: `intent:${sessionId}:user:1`,
        prompt_text: "second prompt",
      },
    ]);
    expect(edits).toEqual([
      {
        edit_key: expect.stringContaining(`edit:intent:${sessionId}:user:0:`),
        session_id: sessionId,
        file_path: filePath,
      },
    ]);
  });

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

  it("uses typed tool-call evidence refs without legacy payload columns", () => {
    const sessionId = "scanner-typed-tool-evidence";
    const filePath = path.join(scratchDir, "scanner-typed-tool-evidence.ts");
    fs.writeFileSync(filePath, "export const value = 1;\n");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertSessionRepository({
      sessionId,
      repository: scratchDir,
      firstSeenMs: 900,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "patch the file",
      timestampMs: 1000,
      uuid: "scanner-typed-tool-evidence-user",
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
    rebuildActiveClaims();

    const claimEvidenceCols = getDb()
      .prepare("PRAGMA table_info(claim_evidence)")
      .all() as Array<{ name: string }>;
    expect(claimEvidenceCols.map((col) => col.name)).not.toContain(
      "evidence_key",
    );

    const [activeEdit] = [...loadActiveEdits({ sessionId }).values()];
    expect(activeEdit?.payloadEvidence).toMatchObject({
      refId: expect.any(Number),
      kind: "tool_call",
      refKey: expect.stringMatching(/^tc:/),
    });

    const eagerEvidenceRows = getDb()
      .prepare(
        `SELECT kind, repository, file_path
         FROM evidence_refs
         WHERE session_id = ?
           AND kind IN ('message', 'tool_call')
         ORDER BY kind ASC`,
      )
      .all(sessionId) as Array<{
      kind: string;
      repository: string | null;
      file_path: string | null;
    }>;
    expect(eagerEvidenceRows).toEqual([
      {
        kind: "message",
        repository: scratchDir,
        file_path: null,
      },
      {
        kind: "tool_call",
        repository: scratchDir,
        file_path: filePath,
      },
    ]);

    reconcileLandedClaimsFromDisk({ sessionId });
    rebuildIntentProjection({ sessionId });

    const fileSnapshotRef = getDb()
      .prepare(
        `SELECT repository, file_path
         FROM evidence_refs
         WHERE kind = 'file_snapshot' AND file_path = ?`,
      )
      .get(filePath) as
      | { repository: string | null; file_path: string | null }
      | undefined;
    expect(fileSnapshotRef).toEqual({
      repository: scratchDir,
      file_path: filePath,
    });

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

  it("emits normalized repository and file subject claims for scanner-backed edits", () => {
    const sessionId = "scanner-normalized-subjects";
    const filePath = path.join(scratchDir, "scanner-normalized-subjects.ts");
    fs.writeFileSync(filePath, "export const value = 1;\n");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertSessionRepository({
      sessionId,
      repository: scratchDir,
      firstSeenMs: 900,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "patch the file",
      timestampMs: 1000,
      uuid: "scanner-normalized-subjects-user",
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
        file_path: filePath,
        old_string: "export const value = 0;\n",
        new_string: "export const value = 1;\n",
      },
    });

    rebuildIntentClaimsFromScanner({ sessionId });
    rebuildActiveClaims();

    const rows = getDb()
      .prepare(
        `SELECT c.predicate, c.subject_kind, c.value_text
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.predicate IN (
           'repository/name',
           'file/path',
           'file/in-repository',
           'intent/in-repository',
           'edit/touches-file'
         )
         ORDER BY c.predicate ASC, c.subject_kind ASC, c.value_text ASC`,
      )
      .all() as Array<{
      predicate: string;
      subject_kind: string;
      value_text: string | null;
    }>;

    expect(rows).toEqual([
      {
        predicate: "edit/touches-file",
        subject_kind: "edit",
        value_text: `file:${scratchDir}:${filePath}`,
      },
      {
        predicate: "file/in-repository",
        subject_kind: "file",
        value_text: `repository:${scratchDir}`,
      },
      {
        predicate: "file/path",
        subject_kind: "file",
        value_text: filePath,
      },
      {
        predicate: "intent/in-repository",
        subject_kind: "intent",
        value_text: `repository:${scratchDir}`,
      },
      {
        predicate: "repository/name",
        subject_kind: "repository",
        value_text: scratchDir,
      },
    ]);
  });

  it("preserves per-session normalized repo/file observations in full scanner rebuilds", () => {
    const filePath = path.join(scratchDir, "scanner-shared-normalized-file.ts");
    fs.writeFileSync(filePath, "export const shared = 1;\n");

    for (const sessionId of ["scanner-shared-1", "scanner-shared-2"]) {
      insertSession({
        sessionId,
        cwd: scratchDir,
        endedAtMs: 2000,
        hasScanner: true,
      });
      insertSessionRepository({
        sessionId,
        repository: scratchDir,
        firstSeenMs: 900,
      });
      insertUserMessage({
        sessionId,
        ordinal: 1,
        content: `patch ${sessionId}`,
        timestampMs: 1000,
        uuid: `${sessionId}-user`,
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
          file_path: filePath,
          old_string: "export const shared = 0;\n",
          new_string: "export const shared = 1;\n",
        },
      });
    }

    rebuildIntentClaimsFromScanner();

    const rows = getDb()
      .prepare(
        `SELECT predicate, COUNT(*) AS count
         FROM claims
         WHERE predicate IN ('repository/name', 'file/path')
         GROUP BY predicate
         ORDER BY predicate ASC`,
      )
      .all() as Array<{ predicate: string; count: number }>;

    expect(rows).toEqual([
      { predicate: "file/path", count: 2 },
      { predicate: "repository/name", count: 2 },
    ]);
  });

  it("preserves per-event normalized repo/file observations in full hook rebuilds", () => {
    const sessionId = "hook-shared-normalized";
    const filePath = path.join(scratchDir, "hook-shared-normalized-file.ts");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 3000,
    });
    insertSessionRepository({
      sessionId,
      repository: scratchDir,
      firstSeenMs: 900,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "first hook prompt",
      timestampMs: 1000,
      uuid: "hook-shared-1",
    });
    insertUserMessage({
      sessionId,
      ordinal: 2,
      content: "second hook prompt",
      timestampMs: 2000,
      uuid: "hook-shared-2",
    });

    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { prompt: "first hook prompt" },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: filePath,
          old_string: "before",
          new_string: "after one",
        },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 2000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { prompt: "second hook prompt" },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 2100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: filePath,
          old_string: "after one",
          new_string: "after two",
        },
      },
    });

    rebuildIntentClaimsFromHooks();

    const rows = getDb()
      .prepare(
        `SELECT predicate, COUNT(*) AS count
         FROM claims
         WHERE predicate IN ('repository/name', 'file/path')
         GROUP BY predicate
         ORDER BY predicate ASC`,
      )
      .all() as Array<{ predicate: string; count: number }>;

    expect(rows).toEqual([
      { predicate: "file/path", count: 2 },
      { predicate: "repository/name", count: 4 },
    ]);
  });

  it("falls back to session repository for hook prompt claims during rebuild", () => {
    const sessionId = "hook-prompt-repo-fallback-rebuild";

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
    });
    insertSessionRepository({
      sessionId,
      repository: scratchDir,
      firstSeenMs: 900,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "use session repo fallback",
      timestampMs: 1000,
      uuid: "hook-prompt-repo-fallback-rebuild-user",
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      cwd: scratchDir,
      payload: { prompt: "use session repo fallback" },
    });

    rebuildIntentClaimsFromHooks({ sessionId });

    const rows = getDb()
      .prepare(
        `SELECT predicate, value_text
         FROM claims
         WHERE predicate IN ('intent/repository', 'intent/in-repository', 'repository/name')
         ORDER BY predicate ASC, value_text ASC`,
      )
      .all() as Array<{ predicate: string; value_text: string | null }>;

    expect(rows).toEqual([
      {
        predicate: "intent/in-repository",
        value_text: `repository:${scratchDir}`,
      },
      {
        predicate: "intent/repository",
        value_text: scratchDir,
      },
      {
        predicate: "repository/name",
        value_text: scratchDir,
      },
    ]);
  });

  it("falls back to session repository for live hook prompt claims", () => {
    const sessionId = "hook-prompt-repo-fallback-live";

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
    });
    insertSessionRepository({
      sessionId,
      repository: scratchDir,
      firstSeenMs: 900,
    });
    const promptId = insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1000,
      cwd: scratchDir,
      payload: { prompt: "live session repo fallback" },
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "live session repo fallback",
      timestampMs: 1000,
      uuid: "hook-prompt-repo-fallback-live-user",
    });

    recordIntentClaimsFromHookEvent({
      sessionId,
      eventType: "UserPromptSubmit",
      hookEventId: promptId,
      timestampMs: 1000,
      cwd: scratchDir,
      payload: { prompt: "live session repo fallback" },
    });

    const rows = getDb()
      .prepare(
        `SELECT predicate, value_text
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE predicate IN ('intent/repository', 'intent/in-repository', 'repository/name')
         ORDER BY predicate ASC, value_text ASC`,
      )
      .all() as Array<{ predicate: string; value_text: string | null }>;

    expect(rows).toEqual([
      {
        predicate: "intent/in-repository",
        value_text: `repository:${scratchDir}`,
      },
      {
        predicate: "intent/repository",
        value_text: scratchDir,
      },
      {
        predicate: "repository/name",
        value_text: scratchDir,
      },
    ]);
  });

  it("stores normalized path rows for multi-file apply_patch evidence", () => {
    const sessionId = "scanner-multi-file-tool-evidence";
    const fileA = path.join(scratchDir, "scanner-multi-file-a.ts");
    const fileB = path.join(scratchDir, "scanner-multi-file-b.ts");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertSessionRepository({
      sessionId,
      repository: scratchDir,
      firstSeenMs: 900,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "patch both files",
      timestampMs: 1000,
      uuid: "scanner-multi-file-tool-evidence-user",
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
          `*** Update File: ${fileA}`,
          "@@",
          "-export const a = 0;",
          "+export const a = 1;",
          `*** Update File: ${fileB}`,
          "@@",
          "-export const b = 0;",
          "+export const b = 1;",
          "*** End Patch",
        ].join("\n"),
      },
    });

    rebuildIntentClaimsFromScanner({ sessionId });
    rebuildActiveClaims();

    const toolCallRef = getDb()
      .prepare(
        `SELECT id, file_path
         FROM evidence_refs
         WHERE session_id = ?
           AND kind = 'tool_call'`,
      )
      .get(sessionId) as { id: number; file_path: string | null } | undefined;
    const pathRows = getDb()
      .prepare(
        `SELECT file_path
         FROM evidence_ref_paths
         WHERE evidence_ref_id = ?
         ORDER BY file_path ASC`,
      )
      .all(toolCallRef?.id ?? -1) as Array<{ file_path: string }>;

    expect(toolCallRef).toEqual({
      id: expect.any(Number),
      file_path: null,
    });
    expect(pathRows).toEqual([{ file_path: fileA }, { file_path: fileB }]);
  });

  it("marks deletion-only apply_patch hunks as landed when the removed text stays gone", () => {
    const sessionId = "scanner-delete-only-apply-patch";
    const filePath = path.join(
      scratchDir,
      "scanner-delete-only-apply-patch.ts",
    );
    fs.writeFileSync(filePath, "export const keep = 1;\n");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "remove the old export",
      timestampMs: 1000,
      uuid: "scanner-delete-only-apply-patch-user",
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
          "-export const removed = 1;",
          "*** End Patch",
        ].join("\n"),
      },
    });

    rebuildIntentClaimsFromScanner({ sessionId });
    reconcileLandedClaimsFromDisk({ sessionId });
    rebuildIntentProjection({ sessionId });

    const row = getDb()
      .prepare(
        `SELECT file_path, tool_name, landed, landed_reason
         FROM intent_edits
         WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          file_path: string;
          tool_name: string;
          landed: number | null;
          landed_reason: string | null;
        }
      | undefined;

    expect(row).toEqual({
      file_path: filePath,
      tool_name: "apply_patch",
      landed: 1,
      landed_reason: "present_in_file",
    });
  });

  it("projects rename-only apply_patch operations into intent_edits", () => {
    const sessionId = "scanner-rename-only-apply-patch";
    const oldPath = path.join(scratchDir, "scanner-rename-before.ts");
    const newPath = path.join(scratchDir, "scanner-rename-after.ts");
    fs.rmSync(oldPath, { force: true });
    fs.writeFileSync(newPath, "export const renamed = true;\n");

    insertSession({
      sessionId,
      cwd: scratchDir,
      endedAtMs: 2000,
      hasScanner: true,
    });
    insertUserMessage({
      sessionId,
      ordinal: 1,
      content: "rename the file",
      timestampMs: 1000,
      uuid: "scanner-rename-only-apply-patch-user",
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
          `*** Update File: ${oldPath}`,
          `*** Move to: ${newPath}`,
          "*** End Patch",
        ].join("\n"),
      },
    });

    rebuildIntentClaimsFromScanner({ sessionId });
    reconcileLandedClaimsFromDisk({ sessionId });
    rebuildIntentProjection({ sessionId });

    const rows = getDb()
      .prepare(
        `SELECT file_path, tool_name, landed
         FROM intent_edits
         WHERE session_id = ?
         ORDER BY file_path ASC`,
      )
      .all(sessionId) as Array<{
      file_path: string;
      tool_name: string;
      landed: number | null;
    }>;

    expect(rows).toEqual([
      {
        file_path: newPath,
        tool_name: "apply_patch",
        landed: 1,
      },
      {
        file_path: oldPath,
        tool_name: "apply_patch",
        landed: 1,
      },
    ]);
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
