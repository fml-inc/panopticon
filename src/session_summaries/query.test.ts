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
  const tmpDir = _path.join(_os.tmpdir(), "pano-session_summaries-test");
  _fs.mkdirSync(tmpDir, { recursive: true });
  return {
    config: {
      dataDir: tmpDir,
      dbPath: _path.join(tmpDir, "panopticon.db"),
      port: 4318,
      host: "127.0.0.1",
      serverPidFile: _path.join(tmpDir, "panopticon.pid"),
      enableSessionSummaryProjections: true,
    },
    ensureDataDir: () => _fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { rebuildActiveClaims } from "../claims/canonicalize.js";
import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import {
  insertHookEvent,
  upsertSessionCwd,
  upsertSessionRepository,
} from "../db/store.js";
import { rebuildIntentClaimsFromHooks } from "../intent/asserters/from_hooks.js";
import { reconcileLandedClaimsFromDisk } from "../intent/asserters/landed_from_disk.js";
import { rebuildIntentProjection } from "../intent/project.js";
import { getSessionSummaryRunnerPolicy } from "./policy.js";
import {
  listSessionSummaries,
  recentWorkOnPath,
  sessionSummaryDetail,
  sessionSummaryKeyForSession,
  whyCode,
} from "./query.js";

const SESSION = "test-session-summary";
let scratchDir: string;

beforeAll(() => {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb();
  scratchDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pano-session_summaries-"),
  );
});

afterAll(() => {
  closeDb();
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

beforeEach(() => {
  (
    config as { enableSessionSummaryProjections: boolean }
  ).enableSessionSummaryProjections = true;
  const db = getDb();
  db.prepare("DELETE FROM code_provenance").run();
  db.prepare("DELETE FROM intent_session_summaries").run();
  db.prepare("DELETE FROM session_summary_enrichments").run();
  db.prepare("DELETE FROM session_summaries").run();
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

describe("session_summaries", () => {
  it("groups intents from one session into a single session summary", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "session-summary.ts");
    fs.writeFileSync(file, "latest implementation");

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
          new_string: "old implementation",
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

    const rows = listSessionSummaries({ repository: repo });
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(SESSION);
    expect(rows[0].title).toContain("draft implementation");
    expect(rows[0].intent_count).toBe(2);
    expect(rows[0].status).toBe("mixed");

    const detail = sessionSummaryDetail({ session_id: SESSION });
    expect(detail?.intents).toHaveLength(2);
    expect(detail?.files).toEqual([
      { file_path: file, edit_count: 2, landed_count: 1 },
    ]);
  });

  it("deduplicates path-filtered session summary results", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "dedupe.ts");
    fs.writeFileSync(file, "final state");

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
      payload: { prompt: "first pass", session_id: SESSION },
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
          new_string: "first pass",
        },
      },
    });
    ingest({
      event_type: "UserPromptSubmit",
      ts: 2000,
      cwd,
      repository: repo,
      payload: { prompt: "final state", session_id: SESSION },
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
          new_string: "final state",
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

    const rows = listSessionSummaries({ path: file });
    expect(rows).toHaveLength(1);
    expect(rows[0].repository).toBe(repo);
  });

  it("does not rebuild projections repeatedly when a valid session has no provenance rows", () => {
    const repo = scratchDir;
    const cwd = scratchDir;

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
      payload: { prompt: "investigate only", session_id: SESSION },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      cwd,
      repository: repo,
      payload: { session_id: SESSION },
    });

    rebuildLocalReadModels();

    const db = getDb();
    const key = sessionSummaryKeyForSession(SESSION);
    const before = db
      .prepare(`SELECT id FROM session_summaries WHERE session_summary_key = ?`)
      .get(key) as { id: number } | undefined;
    expect(before).toBeDefined();
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS c FROM code_provenance`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);

    const first = listSessionSummaries({ repository: repo });
    const afterFirst = db
      .prepare(`SELECT id FROM session_summaries WHERE session_summary_key = ?`)
      .get(key) as { id: number } | undefined;
    const second = listSessionSummaries({ repository: repo });
    const afterSecond = db
      .prepare(`SELECT id FROM session_summaries WHERE session_summary_key = ?`)
      .get(key) as { id: number } | undefined;

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(afterFirst?.id).toBe(before?.id);
    expect(afterSecond?.id).toBe(before?.id);
  });

  it("exposes explicit session summary detail by session id", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "session-summary.ts");
    fs.writeFileSync(file, "final implementation");

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
          new_string: "final implementation",
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

    const summaries = listSessionSummaries({ repository: repo });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].session_id).toBe(SESSION);
    expect(summaries[0].title).toContain("draft implementation");

    const detail = sessionSummaryDetail({ session_id: SESSION });
    expect(detail?.session_summary?.session_id).toBe(SESSION);
    expect(detail?.files).toEqual([
      { file_path: file, edit_count: 2, landed_count: 1 },
    ]);
  });

  it("preserves llm enrichment across rebuilds when summary inputs are unchanged", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "enriched-summary.ts");
    fs.writeFileSync(file, "final implementation");

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
          new_string: "final implementation",
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

    const db = getDb();
    const key = sessionSummaryKeyForSession(SESSION);
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    db.prepare(
      `UPDATE session_summary_enrichments
       SET summary_text = ?,
           summary_source = 'llm',
           summary_runner = 'claude',
           summary_model = 'sonnet',
           summary_policy_hash = ?,
           enriched_input_hash = summary_input_hash,
           enriched_message_count = 0,
           dirty = 0,
           dirty_reason_json = NULL
       WHERE session_summary_key = ?`,
    ).run("LLM-enriched implementation summary.", policyHash, key);

    rebuildLocalReadModels();

    const rows = listSessionSummaries({ repository: repo });
    expect(rows).toHaveLength(1);
    expect(rows[0].summary_text).toBe("LLM-enriched implementation summary.");
    expect(rows[0].summary_source).toBe("llm");
    expect(rows[0].summary_dirty).toBe(false);

    const detail = sessionSummaryDetail({ session_id: SESSION });
    expect(detail?.session_summary?.summary_text).toBe(
      "LLM-enriched implementation summary.",
    );
    expect(detail?.session_summary?.summary_source).toBe("llm");
    expect(detail?.session_summary?.summary_dirty).toBe(false);
  });

  it("marks enrichment dirty and resets to deterministic text after a material change", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "material-change.ts");
    fs.writeFileSync(file, "final implementation");

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
          new_string: "final implementation",
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

    const db = getDb();
    const key = sessionSummaryKeyForSession(SESSION);
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    db.prepare(
      `UPDATE session_summary_enrichments
       SET summary_text = ?,
           summary_source = 'llm',
           summary_runner = 'claude',
           summary_model = 'sonnet',
           summary_policy_hash = ?,
           enriched_input_hash = summary_input_hash,
           enriched_message_count = 0,
           dirty = 0,
           dirty_reason_json = NULL
       WHERE session_summary_key = ?`,
    ).run("LLM-enriched implementation summary.", policyHash, key);

    fs.writeFileSync(file, "cleanup complete");
    ingest({
      event_type: "UserPromptSubmit",
      ts: 4000,
      cwd,
      repository: repo,
      payload: { prompt: "ship cleanup", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 4100,
      cwd,
      repository: repo,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "x",
          new_string: "cleanup complete",
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 5000,
      cwd,
      repository: repo,
      payload: { session_id: SESSION },
    });

    rebuildLocalReadModels();

    const rows = listSessionSummaries({ repository: repo });
    expect(rows).toHaveLength(1);
    expect(rows[0].summary_source).toBe("deterministic");
    expect(rows[0].summary_dirty).toBe(true);
    expect(rows[0].summary_text).not.toBe(
      "LLM-enriched implementation summary.",
    );
    expect(rows[0].summary_search_text).toContain("ship cleanup");
    expect(rows[0].intent_count).toBe(3);
  });
});

describe("why_code", () => {
  it("returns the best current local explanation for a line", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "why.ts");
    const content = [
      "export function retryPolicy() {",
      "  return 'retry with exponential backoff';",
      "}",
    ].join("\n");
    fs.writeFileSync(file, content);

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd,
      repository: repo,
      payload: { prompt: "add retry helper", session_id: SESSION },
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
          new_string: content,
        },
      },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      cwd,
      repository: repo,
      payload: { session_id: SESSION },
    });

    rebuildLocalReadModels();

    const result = whyCode({ path: file, line: 2 });
    expect(result.match_level).toBe("span");
    expect(result.status).toBe("current");
    expect(result.intent?.prompt_text).toBe("add retry helper");
    expect(result.edit?.file_path).toBe(file);
    expect(result.binding?.start_line).toBe(1);
    expect(result.binding?.end_line).toBe(3);
  });
});

describe("recent_work_on_path", () => {
  it("returns recent local history with session summary context", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "history.ts");
    fs.writeFileSync(file, "current state");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd,
      repository: repo,
      payload: { prompt: "old state", session_id: SESSION },
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
          new_string: "old state",
        },
      },
    });
    ingest({
      event_type: "UserPromptSubmit",
      ts: 2000,
      cwd,
      repository: repo,
      payload: { prompt: "current state", session_id: SESSION },
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
          new_string: "current state",
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

    const result = recentWorkOnPath({ path: file, repository: repo });
    expect(result.recent).toHaveLength(2);
    expect(result.recent[0].prompt_text).toBe("current state");
    expect(result.recent[0].status).toBe("current");
    expect(result.recent[1].prompt_text).toBe("old state");
    expect(result.recent[1].status).toBe("reverted");
    expect(result.recent[0].session_summary_title).toBeTruthy();
    expect(result.repository).toBe(repo);
  });
});
