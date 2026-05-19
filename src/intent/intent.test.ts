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
  const tmpDir = _path.join(_os.tmpdir(), "pano-intent-test");
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
import {
  insertHookEvent,
  insertPiHookMessageFromEvent,
  insertPiHookToolCallFromPostEvent,
  upsertSession,
} from "../db/store.js";
import { rebuildIntentClaimsFromHooks } from "./asserters/from_hooks.js";
import { reconcileLandedClaimsFromDisk } from "./asserters/landed_from_disk.js";
import { rebuildIntentProjection } from "./project.js";
import { intentForCode, outcomesForIntent, searchIntent } from "./query.js";

const SESSION = "test-session-intent";
let scratchDir: string;

beforeAll(() => {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb();
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-intent-scratch-"));
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

function ingest(opts: {
  event_type: string;
  ts: number;
  payload: Record<string, unknown>;
  cwd?: string;
  repository?: string;
  tool_name?: string;
  target?: string;
}): number {
  return insertHookEvent({
    session_id: SESSION,
    event_type: opts.event_type,
    timestamp_ms: opts.ts,
    cwd: opts.cwd,
    repository: opts.repository,
    tool_name: opts.tool_name,
    target: opts.target ?? "claude-code",
    payload: opts.payload,
  });
}

function rebuildClaimBackedProjection(): void {
  rebuildIntentClaimsFromHooks({ sessionId: SESSION });
  rebuildActiveClaims();
  reconcileLandedClaimsFromDisk({ sessionId: SESSION });
  rebuildActiveClaims();
  rebuildIntentProjection({ sessionId: SESSION });
}

describe("rebuildIntentProjection", () => {
  it("clears large session FTS sets without variadic rowid deletes", () => {
    const db = getDb();
    const count = 35_000;
    const insertUnit = db.prepare(
      `INSERT INTO intent_units
       (intent_key, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms,
        edit_count, landed_count, reconciled_at_ms, cwd, repository)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO intent_units_fts (rowid, prompt_text) VALUES (?, ?)`,
    );
    const seed = db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const result = insertUnit.run(
          `intent:${i}`,
          SESSION,
          `prompt ${i}`,
          1_000 + i,
          null,
          0,
          null,
          null,
          null,
          null,
        );
        insertFts.run(Number(result.lastInsertRowid), `prompt ${i}`);
      }
      const other = insertUnit.run(
        "intent:other",
        "other-session",
        "other prompt",
        99_999,
        null,
        0,
        null,
        null,
        null,
        null,
      );
      insertFts.run(Number(other.lastInsertRowid), "other prompt");
    });
    seed();

    const projection = rebuildIntentProjection({ sessionId: SESSION });
    const sessionUnits = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM intent_units WHERE session_id = ?`)
        .get(SESSION) as { c: number }
    ).c;
    const otherUnits = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM intent_units WHERE session_id = ?`)
        .get("other-session") as { c: number }
    ).c;
    const ftsRows = (
      db.prepare(`SELECT COUNT(*) AS c FROM intent_units_fts`).get() as {
        c: number;
      }
    ).c;

    expect(projection.intents).toBe(0);
    expect(projection.edits).toBe(0);
    expect(sessionUnits).toBe(0);
    expect(otherUnits).toBe(1);
    expect(ftsRows).toBe(1);
  });
});

describe("query: intent_for_code", () => {
  it("normalizes Pi prompt and tool hooks into messages", () => {
    const promptId = ingest({
      event_type: "UserPromptSubmit",
      target: "pi",
      ts: 1000,
      payload: { prompt: "write a file", session_id: SESSION },
    });
    const toolId = ingest({
      event_type: "PreToolUse",
      target: "pi",
      ts: 1100,
      tool_name: "write",
      payload: {
        tool_name: "write",
        tool_input: { path: "pi-message.md", content: "hello" },
      },
    });

    upsertSession({ session_id: SESSION, target: "pi", has_hooks: 1 });
    expect(insertPiHookMessageFromEvent(promptId)).toBe(true);
    expect(insertPiHookMessageFromEvent(toolId)).toBe(true);

    const rows = getDb()
      .prepare(
        `SELECT ordinal, role, content, has_tool_use, sync_id
         FROM messages
         WHERE session_id = ?
         ORDER BY ordinal`,
      )
      .all(SESSION) as Array<{
      ordinal: number;
      role: string;
      content: string;
      has_tool_use: number;
      sync_id: string;
    }>;

    expect(rows).toEqual([
      {
        ordinal: 0,
        role: "user",
        content: "write a file",
        has_tool_use: 0,
        sync_id: expect.stringMatching(/^hook:/),
      },
      {
        ordinal: 1,
        role: "assistant",
        content: "[write: pi-message.md]",
        has_tool_use: 1,
        sync_id: expect.stringMatching(/^hook:/),
      },
    ]);

    const session = getDb()
      .prepare(
        `SELECT message_count, user_message_count
         FROM sessions
         WHERE session_id = ?`,
      )
      .get(SESSION) as
      | { message_count: number; user_message_count: number }
      | undefined;
    expect(session).toEqual({ message_count: 2, user_message_count: 1 });
  });

  it("normalizes Pi lowercase hook tool events into tool_calls", () => {
    upsertSession({ session_id: SESSION, target: "pi", has_hooks: 1 });
    ingest({
      event_type: "PreToolUse",
      target: "pi",
      ts: 1000,
      tool_name: "write",
      payload: {
        tool_name: "write",
        tool_call_id: "pi-call-1",
        tool_input: { path: "pi-write.md", content: "hello" },
      },
    });
    const messageId = getDb()
      .prepare(`SELECT id FROM hook_events WHERE session_id = ?`)
      .get(SESSION) as { id: number };
    insertPiHookMessageFromEvent(messageId.id);

    const postId = ingest({
      event_type: "PostToolUse",
      target: "pi",
      ts: 1250,
      tool_name: "write",
      payload: {
        tool_name: "write",
        tool_call_id: "pi-call-1",
        tool_input: { path: "pi-write.md", content: "hello" },
        tool_result: { content: "ok" },
      },
    });

    insertPiHookToolCallFromPostEvent(postId);

    const row = getDb()
      .prepare(
        `SELECT tc.message_id, m.role, m.has_tool_use, tc.session_id,
                tc.call_index, tc.tool_name, tc.category, tc.tool_use_id,
                tc.input_json, tc.result_content, tc.duration_ms
         FROM tool_calls tc
         JOIN messages m ON m.id = tc.message_id
         WHERE tc.session_id = ?`,
      )
      .get(SESSION) as
      | {
          message_id: number;
          role: string;
          has_tool_use: number;
          session_id: string;
          call_index: number;
          tool_name: string;
          category: string;
          tool_use_id: string;
          input_json: string;
          result_content: string;
          duration_ms: number;
        }
      | undefined;

    expect(row).toMatchObject({
      role: "assistant",
      has_tool_use: 1,
      session_id: SESSION,
      call_index: 0,
      tool_name: "write",
      category: "hook",
      tool_use_id: "pi-call-1",
      duration_ms: 250,
    });
    expect(row?.message_id).toBeGreaterThan(0);
    expect(JSON.parse(row?.input_json ?? "{}")).toEqual({
      path: "pi-write.md",
      content: "hello",
    });
    expect(JSON.parse(row?.result_content ?? "{}")).toEqual({ content: "ok" });
  });

  it("matches Pi hook tool events with camelCase toolCallId", () => {
    upsertSession({ session_id: SESSION, target: "pi", has_hooks: 1 });
    const preId = ingest({
      event_type: "PreToolUse",
      target: "pi",
      ts: 1000,
      tool_name: "write",
      payload: {
        tool_name: "write",
        toolCallId: "pi-call-camel",
        tool_input: { path: "pi-write.md", content: "hello" },
      },
    });
    insertPiHookMessageFromEvent(preId);

    const postId = ingest({
      event_type: "PostToolUse",
      target: "pi",
      ts: 1250,
      tool_name: "write",
      payload: {
        tool_name: "write",
        toolCallId: "pi-call-camel",
        tool_input: { path: "pi-write.md", content: "hello" },
        tool_result: { content: "ok" },
      },
    });

    insertPiHookToolCallFromPostEvent(postId);

    const row = getDb()
      .prepare(
        `SELECT tool_use_id, duration_ms
         FROM tool_calls
         WHERE session_id = ?`,
      )
      .get(SESSION) as { tool_use_id: string; duration_ms: number } | undefined;

    expect(row).toEqual({ tool_use_id: "pi-call-camel", duration_ms: 250 });
  });

  it("does not fall back to a different Pi pre-tool event when post has an unmatched call id", () => {
    upsertSession({ session_id: SESSION, target: "pi", has_hooks: 1 });
    const preId = ingest({
      event_type: "PreToolUse",
      target: "pi",
      ts: 1000,
      tool_name: "write",
      payload: {
        tool_name: "write",
        tool_call_id: "pi-call-1",
        tool_input: { path: "pi-write.md", content: "hello" },
      },
    });
    insertPiHookMessageFromEvent(preId);

    const postId = ingest({
      event_type: "PostToolUse",
      target: "pi",
      ts: 1250,
      tool_name: "write",
      payload: {
        tool_name: "write",
        tool_call_id: "pi-call-2",
        tool_input: { path: "pi-write.md", content: "hello" },
        tool_result: { content: "ok" },
      },
    });

    insertPiHookToolCallFromPostEvent(postId);

    const count = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS c
           FROM tool_calls
           WHERE session_id = ?`,
        )
        .get(SESSION) as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("projects Pi lowercase edit hook events into intent edits", () => {
    const file = path.join(scratchDir, "pi-edit.ts");
    fs.writeFileSync(file, "old value");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "update from pi", session_id: SESSION },
      repository: scratchDir,
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "edit",
      repository: scratchDir,
      payload: {
        tool_name: "edit",
        tool_input: {
          path: file,
          edits: [{ oldText: "old value", newText: "new value" }],
        },
      },
    });

    const hookRow = getDb()
      .prepare(
        `SELECT file_path
         FROM hook_events
         WHERE tool_name = 'edit'`,
      )
      .get() as { file_path: string } | undefined;
    expect(hookRow?.file_path).toBe(file);

    rebuildClaimBackedProjection();

    const row = getDb()
      .prepare(
        `SELECT file_path, tool_name
         FROM intent_edits
         WHERE session_id = ?`,
      )
      .get(SESSION) as { file_path: string; tool_name: string } | undefined;

    expect(row).toEqual({ file_path: "pi-edit.ts", tool_name: "edit" });
  });

  it("returns chronological intents touching a file with status", () => {
    const file = path.join(scratchDir, "history.ts");
    fs.writeFileSync(file, "current content here");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "earlier attempt", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "X",
          new_string: "earlier attempt content",
        },
      },
    });
    ingest({
      event_type: "UserPromptSubmit",
      ts: 2000,
      payload: { prompt: "current state", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 2100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "X",
          new_string: "current content here",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 3000,
      payload: { session_id: SESSION },
    });

    rebuildClaimBackedProjection();

    const result = intentForCode({ file_path: file });
    expect(result).toHaveLength(2);
    expect(result[0].prompt_text).toBe("current state");
    expect(result[0].status).toBe("current");
    expect(result[1].prompt_text).toBe("earlier attempt");
    expect(result[1].status).toBe("reverted");
  });

  it("collapses repeated edit rows from one apply_patch event", () => {
    const file = path.join(scratchDir, "batched-intent.ts");
    fs.writeFileSync(
      file,
      ["export const a = 0;", "export const b = 0;", ""].join("\n"),
    );

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "batch updates", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "apply_patch",
      payload: {
        tool_name: "apply_patch",
        tool_input: {
          input: [
            "*** Begin Patch",
            `*** Update File: ${file}`,
            "@@",
            "-export const a = 0;",
            "+export const a = 1;",
            "@@",
            "-export const b = 0;",
            "+export const b = 1;",
            "*** End Patch",
          ].join("\n"),
        },
      },
    });
    fs.writeFileSync(
      file,
      ["export const a = 1;", "export const b = 1;", ""].join("\n"),
    );
    ingest({
      event_type: "Stop",
      ts: 2000,
      payload: { session_id: SESSION },
    });

    rebuildClaimBackedProjection();

    const result = intentForCode({ file_path: file });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      prompt_text: "batch updates",
      status: "current",
      edit: {
        edit_count: 2,
        current_edit_count: 2,
        superseded_edit_count: 0,
        reverted_edit_count: 0,
        unknown_edit_count: 0,
        tool_name: "apply_patch",
        timestamp_ms: 1100,
      },
    });
  });

  it("collapses multiple edits from one intent into one mixed row", () => {
    const file = path.join(scratchDir, "mixed-intent.ts");
    fs.writeFileSync(file, "final content here");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "iterate on same file", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "X",
          new_string: "temporary content",
        },
      },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1200,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "X",
          new_string: "final content here",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      payload: { session_id: SESSION },
    });

    rebuildClaimBackedProjection();

    const result = intentForCode({ file_path: file });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      prompt_text: "iterate on same file",
      status: "mixed",
      edit: {
        edit_count: 2,
        current_edit_count: 1,
        timestamp_ms: 1200,
      },
    });
    expect(
      result[0].edit.superseded_edit_count + result[0].edit.reverted_edit_count,
    ).toBe(1);
  });

  it("prefers normalized file-subject links over legacy intent_edits.file_path", () => {
    const file = path.join(scratchDir, "normalized-file-subject.ts");
    const mismatched = path.join(scratchDir, "mismatched.ts");
    fs.writeFileSync(file, "normalized subject content");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { prompt: "normalized lookup", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "X",
          new_string: "normalized subject content",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 1200,
      payload: { session_id: SESSION },
    });

    rebuildClaimBackedProjection();

    getDb()
      .prepare(`UPDATE intent_edits SET file_path = ? WHERE file_path = ?`)
      .run(mismatched, file);

    const result = intentForCode({ file_path: file });
    expect(result).toHaveLength(1);
    expect(result[0].prompt_text).toBe("normalized lookup");
    expect(result[0].status).toBe("current");
  });
});

describe("query: search_intent", () => {
  it("FTS5 search defaults to only_landed=true", () => {
    const fileLanded = path.join(scratchDir, "landed.ts");
    fs.writeFileSync(fileLanded, "retry policy code");
    const fileChurned = path.join(scratchDir, "churned.ts");
    fs.writeFileSync(fileChurned, "different code");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { prompt: "add retry policy", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: fileLanded,
          old_string: "X",
          new_string: "retry policy code",
        },
      },
    });
    ingest({
      event_type: "UserPromptSubmit",
      ts: 2000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { prompt: "add retry policy updated", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 2100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: fileChurned,
          old_string: "X",
          new_string: "MISSING_FROM_FILE",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 3000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { session_id: SESSION },
    });

    rebuildClaimBackedProjection();

    const landed = searchIntent({ query: "retry policy" });
    expect(landed).toHaveLength(1);
    expect(landed[0].prompt_text).toBe("add retry policy");
    expect(landed[0].files).toEqual([
      expect.objectContaining({
        file_path: fileLanded,
        landed: 1,
      }),
    ]);

    const all = searchIntent({ query: "retry policy", only_landed: false });
    expect(all).toHaveLength(2);
    const churned = all.find(
      (row) => row.prompt_text === "add retry policy updated",
    );
    expect(churned?.files).toEqual([
      expect.objectContaining({
        file_path: fileChurned,
        landed: 0,
      }),
    ]);
  });

  it("sanitizes punctuation before passing queries to FTS5", () => {
    const file = path.join(scratchDir, "follow-up.ts");
    fs.writeFileSync(file, "follow up change");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { prompt: "finish follow-up cleanup", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "X",
          new_string: "follow up change",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { session_id: SESSION },
    });

    rebuildClaimBackedProjection();

    expect(() => searchIntent({ query: "follow-up" })).not.toThrow();
    expect(searchIntent({ query: "follow-up" })).toMatchObject([
      { prompt_text: "finish follow-up cleanup" },
    ]);
  });

  it("falls back to LIKE matching when FTS terms are too short", () => {
    const file = path.join(scratchDir, "pr-88.ts");
    fs.writeFileSync(file, "pr 88 change");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { prompt: "review PR #88 todo list", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "X",
          new_string: "pr 88 change",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { session_id: SESSION },
    });

    rebuildClaimBackedProjection();

    expect(searchIntent({ query: "pr 88" })).toMatchObject([
      { prompt_text: "review PR #88 todo list" },
    ]);
  });
});

describe("query: outcomes_for_intent", () => {
  it("buckets edits into survived / churned / unknown", () => {
    const fileSurvived = path.join(scratchDir, "outcome-survived.ts");
    fs.writeFileSync(fileSurvived, "SURVIVED CONTENT");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { prompt: "do stuff", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: fileSurvived,
          old_string: "X",
          new_string: "SURVIVED CONTENT",
        },
      },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1200,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: path.join(scratchDir, "outcome-missing.ts"),
          old_string: "X",
          new_string: "MISSING",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      cwd: scratchDir,
      repository: scratchDir,
      payload: { session_id: SESSION },
    });

    rebuildClaimBackedProjection();

    const db = getDb();
    const { id } = db.prepare("SELECT id FROM intent_units").get() as {
      id: number;
    };
    const out = outcomesForIntent({ intent_unit_id: id });
    expect(out).not.toBeNull();
    expect(out!.edit_count).toBe(2);
    expect(out!.landed_count).toBe(1);
    expect(out!.t0_session_end.edits_survived).toEqual([
      expect.objectContaining({
        file_path: fileSurvived,
      }),
    ]);
    expect(out!.t0_session_end.edits_churned).toEqual([
      expect.objectContaining({
        file_path: path.join(scratchDir, "outcome-missing.ts"),
      }),
    ]);
    expect(out!.t0_session_end.edits_unknown).toHaveLength(0);
  });
});

describe("claim-backed projection rebuild", () => {
  it("is idempotent for hook-backed intent sessions", () => {
    const file = path.join(scratchDir, "idempotent.ts");
    fs.writeFileSync(file, "IDEMPOTENT");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "idempotent rebuild", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "X",
          new_string: "IDEMPOTENT",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 1200,
      payload: { session_id: SESSION },
    });

    rebuildClaimBackedProjection();
    const db = getDb();
    const firstUnits = db
      .prepare(
        `SELECT intent_key, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms,
                edit_count, landed_count, reconciled_at_ms, cwd, repository
         FROM intent_units
         ORDER BY id ASC`,
      )
      .all();
    const firstEdits = db
      .prepare(
        `SELECT e.edit_key, u.intent_key, e.session_id, e.timestamp_ms, e.file_path, e.tool_name,
                multi_edit_index, new_string_hash, new_string_snippet, landed, landed_reason
         FROM intent_edits e
         JOIN intent_units u ON u.id = e.intent_unit_id
         ORDER BY e.id ASC`,
      )
      .all();

    rebuildClaimBackedProjection();
    const secondUnits = db
      .prepare(
        `SELECT intent_key, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms,
                edit_count, landed_count, reconciled_at_ms, cwd, repository
         FROM intent_units
         ORDER BY id ASC`,
      )
      .all();
    const secondEdits = db
      .prepare(
        `SELECT e.edit_key, u.intent_key, e.session_id, e.timestamp_ms, e.file_path, e.tool_name,
                multi_edit_index, new_string_hash, new_string_snippet, landed, landed_reason
         FROM intent_edits e
         JOIN intent_units u ON u.id = e.intent_unit_id
         ORDER BY e.id ASC`,
      )
      .all();

    expect(secondUnits).toEqual(firstUnits);
    expect(secondEdits).toEqual(firstEdits);
  });
});
