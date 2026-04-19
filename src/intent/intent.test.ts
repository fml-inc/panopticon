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

// Mock config to use a temp directory (matches sessions.test.ts pattern)
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

import { closeDb, getDb } from "../db/schema.js";
import { insertHookEvent } from "../db/store.js";
import { recordIntent } from "./ingest.js";
import { intentForCode, outcomesForIntent, searchIntent } from "./query.js";
import { reconcileSessionIntents } from "./reconcile.js";

const SESSION = "test-session-intent";
let scratchDir: string;

beforeAll(() => {
  getDb(); // run schema + migrations
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-intent-scratch-"));
});

afterAll(() => {
  closeDb();
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM intent_edits").run();
  db.prepare("DELETE FROM intent_units").run();
  db.prepare("DELETE FROM intent_units_fts").run();
  db.prepare("DELETE FROM hook_events").run();
});

// Helper: insert a hook_event AND fire recordIntent on it (mimics
// processHookEvent's wiring without going through the HTTP server).
function ingest(opts: {
  event_type: string;
  ts: number;
  payload: Record<string, unknown>;
  cwd?: string;
  repository?: string;
  tool_name?: string;
}): number {
  const id = insertHookEvent({
    session_id: SESSION,
    event_type: opts.event_type,
    timestamp_ms: opts.ts,
    cwd: opts.cwd,
    repository: opts.repository,
    tool_name: opts.tool_name,
    target: "claude-code",
    payload: opts.payload,
  });
  recordIntent({
    session_id: SESSION,
    event_type: opts.event_type,
    hook_event_id: id,
    timestamp_ms: opts.ts,
    cwd: opts.cwd ?? null,
    repository: opts.repository ?? null,
    payload: opts.payload,
  });
  return id;
}

describe("intent ingest", () => {
  it("opens an intent_unit on UserPromptSubmit", () => {
    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "add a retry policy", session_id: SESSION },
    });
    const db = getDb();
    const units = db.prepare("SELECT * FROM intent_units").all() as Array<{
      prompt_text: string;
      next_prompt_ts_ms: number | null;
    }>;
    expect(units).toHaveLength(1);
    expect(units[0].prompt_text).toBe("add a retry policy");
    expect(units[0].next_prompt_ts_ms).toBeNull();
  });

  it("closes the prior open unit when a new prompt arrives", () => {
    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "first", session_id: SESSION },
    });
    ingest({
      event_type: "UserPromptSubmit",
      ts: 2000,
      payload: { prompt: "second", session_id: SESSION },
    });
    const db = getDb();
    const units = db
      .prepare(
        "SELECT prompt_text, next_prompt_ts_ms FROM intent_units ORDER BY prompt_ts_ms",
      )
      .all() as Array<{
      prompt_text: string;
      next_prompt_ts_ms: number | null;
    }>;
    expect(units).toHaveLength(2);
    expect(units[0].next_prompt_ts_ms).toBe(2000);
    expect(units[1].next_prompt_ts_ms).toBeNull();
  });

  it("appends intent_edits for Edit/Write within the open unit", () => {
    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "edit something", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "/tmp/foo.ts",
          old_string: "OLD",
          new_string: "NEW",
        },
      },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1200,
      tool_name: "Write",
      payload: {
        tool_name: "Write",
        tool_input: { file_path: "/tmp/bar.ts", content: "WHOLE FILE" },
      },
    });
    const db = getDb();
    const edits = db
      .prepare(
        "SELECT file_path, tool_name, new_string_snippet FROM intent_edits ORDER BY timestamp_ms",
      )
      .all() as Array<{
      file_path: string;
      tool_name: string;
      new_string_snippet: string;
    }>;
    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual({
      file_path: "/tmp/foo.ts",
      tool_name: "Edit",
      new_string_snippet: "NEW",
    });
    expect(edits[1].tool_name).toBe("Write");
    expect(edits[1].new_string_snippet).toBe("WHOLE FILE");
  });

  it("fans out MultiEdit into one intent_edit per sub-edit", () => {
    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "multi", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "MultiEdit",
      payload: {
        tool_name: "MultiEdit",
        tool_input: {
          file_path: "/tmp/multi.ts",
          edits: [
            { old_string: "A", new_string: "AA" },
            { old_string: "B", new_string: "BB" },
            { old_string: "C", new_string: "CC" },
          ],
        },
      },
    });
    const db = getDb();
    const edits = db
      .prepare(
        "SELECT multi_edit_index, new_string_snippet FROM intent_edits ORDER BY multi_edit_index",
      )
      .all();
    expect(edits).toEqual([
      { multi_edit_index: 0, new_string_snippet: "AA" },
      { multi_edit_index: 1, new_string_snippet: "BB" },
      { multi_edit_index: 2, new_string_snippet: "CC" },
    ]);
  });

  it("ignores edits with no preceding prompt", () => {
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "/tmp/foo.ts",
          old_string: "OLD",
          new_string: "NEW",
        },
      },
    });
    const db = getDb();
    expect(db.prepare("SELECT COUNT(*) as c FROM intent_edits").get()).toEqual({
      c: 0,
    });
  });

  it("Stop closes any open unit", () => {
    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "p", session_id: SESSION },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      payload: { session_id: SESSION },
    });
    const db = getDb();
    const u = db
      .prepare("SELECT next_prompt_ts_ms FROM intent_units")
      .get() as { next_prompt_ts_ms: number };
    expect(u.next_prompt_ts_ms).toBe(2000);
  });
});

describe("intent reconciliation", () => {
  it("marks present_in_file when snippet survives on disk", () => {
    const file = path.join(scratchDir, "kept.ts");
    fs.writeFileSync(file, "before\nNEW_CONTENT\nafter\n");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "keep this", session_id: SESSION },
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
          new_string: "NEW_CONTENT",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      payload: { session_id: SESSION },
    });
    reconcileSessionIntents(SESSION);

    const db = getDb();
    const e = db
      .prepare("SELECT landed, landed_reason FROM intent_edits")
      .get();
    expect(e).toEqual({ landed: 1, landed_reason: "present_in_file" });

    const u = db
      .prepare("SELECT landed_count, edit_count FROM intent_units")
      .get();
    expect(u).toEqual({ landed_count: 1, edit_count: 1 });
  });

  it("marks reverted_post_session when snippet is gone from disk", () => {
    const file = path.join(scratchDir, "gone.ts");
    fs.writeFileSync(file, "this file does not contain the magic string");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "p", session_id: SESSION },
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
          new_string: "MAGIC_STRING_NOT_THERE",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      payload: { session_id: SESSION },
    });
    reconcileSessionIntents(SESSION);

    const db = getDb();
    const e = db
      .prepare("SELECT landed, landed_reason FROM intent_edits")
      .get();
    expect(e).toEqual({ landed: 0, landed_reason: "reverted_post_session" });
  });

  it("marks file_deleted when the file is missing", () => {
    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "p", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: path.join(scratchDir, "nonexistent.ts"),
          old_string: "X",
          new_string: "NEW",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      payload: { session_id: SESSION },
    });
    reconcileSessionIntents(SESSION);

    const db = getDb();
    const e = db
      .prepare("SELECT landed, landed_reason FROM intent_edits")
      .get();
    expect(e).toEqual({ landed: 0, landed_reason: "file_deleted" });
  });

  it("marks overwritten_in_session when later Edit's old_string contains the new_string", () => {
    const file = path.join(scratchDir, "overwritten.ts");
    fs.writeFileSync(file, "FINAL");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "first attempt", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "ORIGINAL",
          new_string: "INTERMEDIATE_VALUE",
        },
      },
    });
    // Same prompt, then a follow-up edit that overwrites the intermediate
    ingest({
      event_type: "PostToolUse",
      ts: 1200,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "INTERMEDIATE_VALUE",
          new_string: "FINAL",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      payload: { session_id: SESSION },
    });
    reconcileSessionIntents(SESSION);

    const db = getDb();
    const edits = db
      .prepare(
        "SELECT new_string_snippet, landed, landed_reason FROM intent_edits ORDER BY timestamp_ms",
      )
      .all();
    expect(edits[0]).toEqual({
      new_string_snippet: "INTERMEDIATE_VALUE",
      landed: 0,
      landed_reason: "overwritten_in_session",
    });
    expect(edits[1]).toEqual({
      new_string_snippet: "FINAL",
      landed: 1,
      landed_reason: "present_in_file",
    });
  });

  it("marks write_replaced when later Write doesn't contain the snippet", () => {
    const file = path.join(scratchDir, "rewritten.ts");
    fs.writeFileSync(file, "ENTIRELY DIFFERENT");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "p", session_id: SESSION },
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
          new_string: "EARLIER_CONTENT",
        },
      },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1200,
      tool_name: "Write",
      payload: {
        tool_name: "Write",
        tool_input: { file_path: file, content: "ENTIRELY DIFFERENT" },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      payload: { session_id: SESSION },
    });
    reconcileSessionIntents(SESSION);

    const db = getDb();
    const edits = db
      .prepare(
        "SELECT new_string_snippet, landed, landed_reason FROM intent_edits ORDER BY timestamp_ms",
      )
      .all();
    expect(edits[0]).toEqual({
      new_string_snippet: "EARLIER_CONTENT",
      landed: 0,
      landed_reason: "write_replaced",
    });
    // The Write itself should be present_in_file
    expect(edits[1]).toEqual({
      new_string_snippet: "ENTIRELY DIFFERENT",
      landed: 1,
      landed_reason: "present_in_file",
    });
  });

  it("does not reconcile units that are still open", () => {
    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "p", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: path.join(scratchDir, "open.ts"),
          old_string: "X",
          new_string: "Y",
        },
      },
    });
    // No Stop or follow-up prompt — unit is still open
    reconcileSessionIntents(SESSION);

    const db = getDb();
    const e = db.prepare("SELECT landed FROM intent_edits").get() as {
      landed: number | null;
    };
    expect(e.landed).toBeNull();
  });
});

describe("query: intent_for_code", () => {
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
    reconcileSessionIntents(SESSION);

    const result = intentForCode({ file_path: file });
    expect(result).toHaveLength(2);
    // Most recent first
    expect(result[0].prompt_text).toBe("current state");
    expect(result[0].status).toBe("current");
    expect(result[1].prompt_text).toBe("earlier attempt");
    expect(result[1].status).toBe("reverted");
  });
});

describe("query: search_intent", () => {
  it("FTS5 search defaults to only_landed=true", () => {
    const fileLanded = path.join(scratchDir, "landed.ts");
    fs.writeFileSync(fileLanded, "retry policy code");
    const fileChurned = path.join(scratchDir, "churned.ts");
    fs.writeFileSync(fileChurned, "different code");

    // Landed intent
    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "add retry policy", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
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
    // Churned intent (same query terms)
    ingest({
      event_type: "UserPromptSubmit",
      ts: 2000,
      payload: { prompt: "add retry policy v2", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 2100,
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
      payload: { session_id: SESSION },
    });
    reconcileSessionIntents(SESSION);

    const landed = searchIntent({ query: "retry policy" });
    expect(landed).toHaveLength(1);
    expect(landed[0].prompt_text).toBe("add retry policy");

    const all = searchIntent({ query: "retry policy", only_landed: false });
    expect(all).toHaveLength(2);
  });
});

describe("query: outcomes_for_intent", () => {
  it("buckets edits into survived / churned / unknown", () => {
    const fileSurvived = path.join(scratchDir, "outcome-survived.ts");
    fs.writeFileSync(fileSurvived, "SURVIVED CONTENT");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      payload: { prompt: "do stuff", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
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
      payload: { session_id: SESSION },
    });
    reconcileSessionIntents(SESSION);

    const db = getDb();
    const { id } = db.prepare("SELECT id FROM intent_units").get() as {
      id: number;
    };
    const out = outcomesForIntent({ intent_unit_id: id });
    expect(out).not.toBeNull();
    expect(out!.edit_count).toBe(2);
    expect(out!.landed_count).toBe(1);
    expect(out!.t0_session_end.edits_survived).toHaveLength(1);
    expect(out!.t0_session_end.edits_churned).toHaveLength(1);
    expect(out!.t0_session_end.edits_unknown).toHaveLength(0);
  });
});
