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
  const tmpDir = _path.join(_os.tmpdir(), "pano-query-session-summaries-test");
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
import { rebuildIntentClaimsFromHooks } from "../intent/asserters/from_hooks.js";
import { reconcileLandedClaimsFromDisk } from "../intent/asserters/landed_from_disk.js";
import { rebuildIntentProjection } from "../intent/project.js";
import { listSessions } from "./query.js";
import { closeDb, getDb } from "./schema.js";
import {
  insertHookEvent,
  upsertSession,
  upsertSessionCwd,
  upsertSessionRepository,
} from "./store.js";

const SESSION = "session-summary-db-query";
let scratchDir: string;

beforeAll(() => {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb();
  scratchDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pano-query-session-summaries-"),
  );
});

afterAll(() => {
  closeDb();
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM code_provenance").run();
  db.prepare("DELETE FROM intent_session_summaries").run();
  db.prepare("DELETE FROM session_summaries").run();
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

function ingest(opts: {
  event_type: string;
  ts: number;
  payload: Record<string, unknown>;
  cwd?: string;
  repository?: string;
  tool_name?: string;
}): void {
  insertHookEvent({
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

function rebuildLocalReadModels(): void {
  rebuildIntentClaimsFromHooks({ sessionId: SESSION });
  rebuildActiveClaims();
  reconcileLandedClaimsFromDisk({ sessionId: SESSION });
  rebuildActiveClaims();
  rebuildIntentProjection({ sessionId: SESSION });
}

describe("listSessions session summaries", () => {
  it("replaces the weak summary text with explicit session-derived provenance", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "derived-summary.ts");
    fs.writeFileSync(file, "latest implementation");

    upsertSession({
      session_id: SESSION,
      target: "claude",
      started_at_ms: 1_700_000_000_000,
      first_prompt: "draft implementation",
      turn_count: 4,
      total_input_tokens: 100,
      total_output_tokens: 200,
    });
    getDb()
      .prepare("UPDATE sessions SET summary = ? WHERE session_id = ?")
      .run("legacy weak summary", SESSION);
    upsertSessionRepository(
      SESSION,
      repo,
      900,
      { name: "gus", email: null },
      "main",
    );
    upsertSessionCwd(SESSION, cwd, 900);

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd,
      repository: repo,
      payload: { prompt: "draft implementation", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      cwd,
      repository: repo,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "x",
          new_string: "draft implementation",
        },
      },
    });
    ingest({
      event_type: "UserPromptSubmit",
      ts: 2000,
      cwd,
      repository: repo,
      payload: { prompt: "finish implementation", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 2100,
      cwd,
      repository: repo,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "x",
          new_string: "latest implementation",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 3000,
      cwd,
      repository: repo,
      payload: { session_id: SESSION },
    });

    rebuildLocalReadModels();

    const result = listSessions({ limit: 5 });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionSummary).toMatchObject({
      sessionId: SESSION,
      title: "draft implementation",
      status: "mixed",
      repository: repo,
      branch: "main",
      intentCount: 2,
      editCount: 2,
      landedEditCount: 1,
      openEditCount: 0,
    });
    expect(result.sessions[0].summary).toContain("Status: mixed");
    expect(result.sessions[0].summary).toContain(file);
    expect(result.sessions[0].summary).not.toBe("legacy weak summary");
  });
});
