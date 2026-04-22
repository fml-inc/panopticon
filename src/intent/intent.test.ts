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
import { insertHookEvent } from "../db/store.js";
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
}): number {
  return insertHookEvent({
    session_id: SESSION,
    event_type: opts.event_type,
    timestamp_ms: opts.ts,
    cwd: opts.cwd,
    repository: opts.repository,
    tool_name: opts.tool_name,
    target: "claude-code",
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

    rebuildClaimBackedProjection();

    const result = intentForCode({ file_path: file });
    expect(result).toHaveLength(2);
    expect(result[0].prompt_text).toBe("current state");
    expect(result[0].status).toBe("current");
    expect(result[1].prompt_text).toBe("earlier attempt");
    expect(result[1].status).toBe("reverted");
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
    ingest({
      event_type: "UserPromptSubmit",
      ts: 2000,
      payload: { prompt: "add retry policy updated", session_id: SESSION },
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

    rebuildClaimBackedProjection();

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

    rebuildClaimBackedProjection();

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
