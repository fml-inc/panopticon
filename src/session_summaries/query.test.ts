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
    },
    ensureDataDir: () => _fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { rebuildActiveClaims } from "../claims/canonicalize.js";
import { config } from "../config.js";
import { Database } from "../db/driver.js";
import {
  closeDb,
  getDb,
  needsSessionSummaryProjectionRebuild,
} from "../db/schema.js";
import {
  insertHookEvent,
  upsertSessionCwd,
  upsertSessionRepository,
} from "../db/store.js";
import { rebuildIntentClaimsFromHooks } from "../intent/asserters/from_hooks.js";
import { reconcileLandedClaimsFromDisk } from "../intent/asserters/landed_from_disk.js";
import { rebuildIntentProjection } from "../intent/project.js";
import { getSessionSummaryRunnerPolicy } from "./policy.js";
import { rebuildSessionSummaryProjections } from "./project.js";
import {
  fileOverview,
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
  const db = getDb();
  db.prepare("DELETE FROM code_provenance").run();
  db.prepare("DELETE FROM intent_session_summaries").run();
  db.prepare("DELETE FROM session_summary_search_index").run();
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
    expect(rows[0].summary_text).toContain(
      "Mixed: 2 intents, 1/2 edits landed",
    );

    const detail = sessionSummaryDetail({ session_id: SESSION });
    expect(detail?.session_summary?.summary_text).toContain(
      "Mixed: 2 intents, 1/2 edits landed",
    );
    expect(detail?.intents).toHaveLength(2);
    expect(detail?.files).toEqual([
      { file_path: file, edit_count: 2, landed_count: 1 },
    ]);
  });

  it("marks prompt-only sessions as read-only", () => {
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
      payload: { prompt: "investigate flaky tests", session_id: SESSION },
    });
    ingest({
      event_type: "Stop",
      ts: 2000,
      cwd,
      repository: repo,
      payload: { session_id: SESSION },
    });

    rebuildLocalReadModels();

    const rows = listSessionSummaries({ repository: repo });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("read-only");
    expect(rows[0].summary_text).toContain(
      "Read-only: 1 intent, no edits recorded",
    );
  });

  it("marks sessions with only non-landed edits as unlanded", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "unlanded-summary.ts");
    fs.writeFileSync(file, "baseline");

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
      payload: { prompt: "try a speculative patch", session_id: SESSION },
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
          new_string: "attempted implementation",
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

    const rows = listSessionSummaries({ repository: repo });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unlanded");
    expect(rows[0].summary_text).toContain(
      "Unlanded: 1 intent, 1 edit recorded, none landed",
    );
  });

  it("returns llm enrichment metadata when present", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "llm-summary.ts");
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

    getDb()
      .prepare(
        `UPDATE session_summary_enrichments
         SET summary_text = ?,
             summary_source = 'llm',
             summary_runner = ?,
             summary_model = ?,
             summary_generated_at_ms = ?,
             dirty = 0
         WHERE session_summary_key = ?`,
      )
      .run(
        "LLM session summary.",
        "claude",
        "sonnet",
        1_700_000_010_000,
        sessionSummaryKeyForSession(SESSION),
      );

    const rows = listSessionSummaries({ repository: repo });
    expect(rows[0].summary_text).toContain("draft implementation");
    expect(rows[0]).toMatchObject({
      summary_source: "deterministic",
      enriched_summary_text: "LLM session summary.",
      enriched_search_text: "LLM session summary.",
      enrichment_source: "llm",
      enrichment_runner: "claude",
      enrichment_model: "sonnet",
      enrichment_dirty: false,
      enrichment_generated_at_ms: 1_700_000_010_000,
    });

    const detail = sessionSummaryDetail({ session_id: SESSION });
    expect(detail?.session_summary?.summary_text).toContain(
      "draft implementation",
    );
    expect(detail?.session_summary).toMatchObject({
      summary_source: "deterministic",
      enriched_summary_text: "LLM session summary.",
      enriched_search_text: "LLM session summary.",
      enrichment_source: "llm",
      enrichment_runner: "claude",
      enrichment_model: "sonnet",
      enrichment_dirty: false,
      enrichment_generated_at_ms: 1_700_000_010_000,
    });
  });

  it("preserves an existing llm enrichment during a targeted session rebuild", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "llm-summary-rebuild.ts");
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

    const seeded = getDb()
      .prepare(
        `SELECT summary_input_hash
         FROM session_summary_enrichments
         WHERE session_summary_key = ?`,
      )
      .get(sessionSummaryKeyForSession(SESSION)) as
      | {
          summary_input_hash: string | null;
        }
      | undefined;

    getDb()
      .prepare(
        `UPDATE session_summary_enrichments
         SET summary_text = ?,
             summary_source = 'llm',
             summary_runner = ?,
             summary_model = ?,
             summary_generated_at_ms = ?,
             summary_policy_hash = ?,
             enriched_input_hash = ?,
             enriched_message_count = ?,
             dirty = 0
         WHERE session_summary_key = ?`,
      )
      .run(
        "LLM session summary.",
        "claude",
        "sonnet",
        1_700_000_010_000,
        getSessionSummaryRunnerPolicy().policyHash,
        seeded?.summary_input_hash ?? null,
        0,
        sessionSummaryKeyForSession(SESSION),
      );

    rebuildSessionSummaryProjections({ sessionId: SESSION });

    const row = getDb()
      .prepare(
        `SELECT summary_text, summary_source, summary_runner, summary_model,
                summary_generated_at_ms, dirty
         FROM session_summary_enrichments
         WHERE session_summary_key = ?`,
      )
      .get(sessionSummaryKeyForSession(SESSION)) as
      | {
          summary_text: string | null;
          summary_source: string | null;
          summary_runner: string | null;
          summary_model: string | null;
          summary_generated_at_ms: number | null;
          dirty: number;
        }
      | undefined;

    expect(row).toMatchObject({
      summary_text: "LLM session summary.",
      summary_source: "llm",
      summary_runner: "claude",
      summary_model: "sonnet",
      summary_generated_at_ms: 1_700_000_010_000,
      dirty: 0,
    });

    const detail = sessionSummaryDetail({ session_id: SESSION });
    expect(detail?.session_summary?.summary_text).toContain(
      "draft implementation",
    );
    expect(detail?.session_summary).toMatchObject({
      summary_source: "deterministic",
      enriched_summary_text: "LLM session summary.",
      enrichment_source: "llm",
      enrichment_dirty: false,
      enrichment_generated_at_ms: 1_700_000_010_000,
    });
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

  it("debounces deterministic summary refreshes during hot scanner rebuilds", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "debounced.ts");
    fs.writeFileSync(file, "second implementation");
    const db = getDb();

    db.prepare(
      `INSERT INTO intent_units
       (id, intent_key, session_id, prompt_text, prompt_ts_ms,
        next_prompt_ts_ms, cwd, repository)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "intent:first",
      SESSION,
      "first implementation",
      1_000,
      2_000,
      cwd,
      repo,
    );
    db.prepare(
      `INSERT INTO intent_edits
       (id, edit_key, intent_unit_id, session_id, timestamp_ms, file_path,
        landed, new_string_snippet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, "edit:first", 1, SESSION, 1_100, file, 1, "first implementation");

    rebuildSessionSummaryProjections({ sessionId: SESSION, nowMs: 10_000 });
    const before = db
      .prepare(
        `SELECT summary_text, projection_hash, projected_at_ms,
                source_last_seen_at_ms, intent_count
         FROM session_summaries
         WHERE session_id = ?`,
      )
      .get(SESSION) as {
      summary_text: string;
      projection_hash: string;
      projected_at_ms: number;
      source_last_seen_at_ms: number | null;
      intent_count: number;
    };

    db.prepare(
      `INSERT INTO intent_units
       (id, intent_key, session_id, prompt_text, prompt_ts_ms,
        next_prompt_ts_ms, cwd, repository)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      2,
      "intent:second",
      SESSION,
      "second implementation",
      20_000,
      21_000,
      cwd,
      repo,
    );
    db.prepare(
      `INSERT INTO intent_edits
       (id, edit_key, intent_unit_id, session_id, timestamp_ms, file_path,
        landed, new_string_snippet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      2,
      "edit:second",
      2,
      SESSION,
      20_100,
      file,
      1,
      "second implementation",
    );

    rebuildSessionSummaryProjections({
      sessionId: SESSION,
      debounce: true,
      nowMs: 20_500,
    });
    const debounced = db
      .prepare(
        `SELECT summary_text, projection_hash, projected_at_ms,
                source_last_seen_at_ms, intent_count
         FROM session_summaries
         WHERE session_id = ?`,
      )
      .get(SESSION) as typeof before;
    const membershipCount = (
      db
        .prepare(`SELECT COUNT(*) AS count FROM intent_session_summaries`)
        .get() as { count: number }
    ).count;

    expect(debounced).toEqual(before);
    expect(membershipCount).toBe(2);

    rebuildSessionSummaryProjections({
      sessionId: SESSION,
      debounce: true,
      nowMs: 41_000,
    });
    const refreshed = db
      .prepare(
        `SELECT summary_text, projection_hash, projected_at_ms,
                source_last_seen_at_ms, intent_count
         FROM session_summaries
         WHERE session_id = ?`,
      )
      .get(SESSION) as typeof before;

    expect(refreshed.summary_text).not.toBe(before.summary_text);
    expect(refreshed.projection_hash).not.toBe(before.projection_hash);
    expect(refreshed.projected_at_ms).toBe(41_000);
    expect(refreshed.source_last_seen_at_ms).toBe(21_000);
    expect(refreshed.intent_count).toBe(2);
  });

  it("rebuilds session summaries when the summary projection component is stale", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "stale-summary.ts");
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
      ts: 1_000,
      cwd,
      repository: repo,
      payload: { prompt: "draft implementation", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1_100,
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
      ts: 2_000,
      cwd,
      repository: repo,
      payload: { session_id: SESSION },
    });

    rebuildLocalReadModels();

    const before = getDb()
      .prepare(
        `SELECT projected_at_ms
         FROM session_summaries
         WHERE session_id = ?`,
      )
      .get(SESSION) as { projected_at_ms: number };

    closeDb();
    const raw = new Database(config.dbPath);
    raw
      .prepare(
        `UPDATE data_versions
         SET version = ?, updated_at_ms = ?
         WHERE component = ?`,
      )
      .run(0, Date.now(), "session_summaries.projection");
    raw.close();

    const reopened = getDb();
    expect(needsSessionSummaryProjectionRebuild()).toBe(true);

    const rows = listSessionSummaries({ repository: repo });
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(SESSION);

    const after = reopened
      .prepare(
        `SELECT projected_at_ms
         FROM session_summaries
         WHERE session_id = ?`,
      )
      .get(SESSION) as { projected_at_ms: number };
    expect(after.projected_at_ms).toBeGreaterThanOrEqual(
      before.projected_at_ms,
    );
    expect(needsSessionSummaryProjectionRebuild()).toBe(false);
  });

  it("excludes internal headless summary sessions from projections", () => {
    const db = getDb();
    const realSession = "real-work-session";
    const headlessSession = "headless-summary-session";
    const legacySummarySession = "legacy-summary-session";
    const headlessCwd = path.join(config.dataDir, "claude-headless");

    db.prepare(
      `INSERT INTO sessions
       (session_id, target, project, cwd, first_prompt, started_at_ms,
        ended_at_ms, machine, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      realSession,
      "claude",
      "fml-inc/panopticon",
      scratchDir,
      "implement useful projection",
      1_000,
      2_000,
      "local",
      4,
      headlessSession,
      "claude",
      "claude-headless",
      headlessCwd,
      "Summarize this coding session segment in 1-2 sentences.",
      3_000,
      4_000,
      "local",
      2,
      legacySummarySession,
      "claude",
      "tmp",
      "/private/tmp",
      `Summarize session ${realSession}. Start by calling the timeline tool with sessionId "${realSession}" and limit 50.`,
      5_000,
      6_000,
      "local",
      2,
    );
    db.prepare(
      `INSERT INTO session_cwds (session_id, cwd, first_seen_ms)
       VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
    ).run(
      realSession,
      scratchDir,
      1_000,
      headlessSession,
      headlessCwd,
      3_000,
      legacySummarySession,
      "/private/tmp",
      5_000,
    );
    db.prepare(
      `INSERT INTO intent_units
       (intent_key, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms,
        cwd, repository)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "intent:real",
      realSession,
      "implement useful projection",
      1_100,
      1_900,
      scratchDir,
      scratchDir,
      "intent:headless",
      headlessSession,
      "Summarize this coding session segment in 1-2 sentences.",
      3_100,
      3_900,
      headlessCwd,
      null,
      "intent:legacy-summary",
      legacySummarySession,
      `Summarize session ${realSession}. Start by calling the timeline tool with sessionId "${realSession}" and limit 50.`,
      5_100,
      5_900,
      "/private/tmp",
      null,
    );

    const result = rebuildSessionSummaryProjections();
    const summaries = db
      .prepare(
        `SELECT session_id, title
         FROM session_summaries
         ORDER BY session_id`,
      )
      .all() as Array<{ session_id: string; title: string }>;
    const enrichmentRows = db
      .prepare(
        `SELECT session_id
         FROM session_summary_enrichments
         ORDER BY session_id`,
      )
      .all() as Array<{ session_id: string }>;

    expect(result.sessionSummaries).toBe(1);
    expect(summaries).toEqual([
      {
        session_id: realSession,
        title: "implement useful projection",
      },
    ]);
    expect(enrichmentRows).toEqual([{ session_id: realSession }]);
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
    expect(detail?.session_summary?.summary_text).toContain(
      "Mixed: 2 intents, 1/2 edits landed",
    );
    expect(detail?.files).toEqual([
      { file_path: file, edit_count: 2, landed_count: 1 },
    ]);
  });

  it("refreshes deterministic summary text after a material change", () => {
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

    const before = listSessionSummaries({ repository: repo });
    expect(before).toHaveLength(1);
    const beforeSummary = before[0].summary_text;

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
    expect(rows[0].summary_text).not.toBe(beforeSummary);
    expect(rows[0].summary_text).toContain("3 intents");
    expect(rows[0].intent_count).toBe(3);

    const detail = sessionSummaryDetail({ session_id: SESSION });
    expect(detail?.session_summary?.summary_text).toContain("3 intents");
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
    expect(result.recent[0].edit_count).toBe(1);
    expect(result.recent[0].status).toBe("current");
    expect(result.recent[1].prompt_text).toBe("old state");
    expect(result.recent[1].edit_count).toBe(1);
    expect(result.recent[1].status).toBe("reverted");
    expect(result.recent[0].session_summary_title).toBeTruthy();
    expect(result.repository).toBe(repo);
  });

  it("collapses repeated edit rows from one apply_patch event", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "batched.ts");
    fs.writeFileSync(
      file,
      ["export const a = 0;", "export const b = 0;", ""].join("\n"),
    );

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd,
      repository: repo,
      payload: { prompt: "batch updates", session_id: SESSION },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1100,
      cwd,
      repository: repo,
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
      cwd,
      repository: repo,
      payload: { session_id: SESSION },
    });

    rebuildLocalReadModels();

    const result = recentWorkOnPath({ path: file, repository: repo });
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0]).toMatchObject({
      prompt_text: "batch updates",
      status: "current",
      edit_count: 2,
      current_edit_count: 2,
      superseded_edit_count: 0,
      reverted_edit_count: 0,
      unknown_edit_count: 0,
      timestamp_ms: 1100,
    });
  });

  it("collapses multiple events from one intent into one mixed row", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const file = path.join(scratchDir, "mixed-intent-history.ts");
    fs.writeFileSync(file, "final state");

    ingest({
      event_type: "UserPromptSubmit",
      ts: 1000,
      cwd,
      repository: repo,
      payload: { prompt: "iterating on the same file", session_id: SESSION },
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
          new_string: "temporary state",
        },
      },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1200,
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
      ts: 2000,
      cwd,
      repository: repo,
      payload: { session_id: SESSION },
    });

    rebuildLocalReadModels();

    const result = recentWorkOnPath({ path: file, repository: repo });
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0]).toMatchObject({
      prompt_text: "iterating on the same file",
      status: "mixed",
      edit_count: 2,
      current_edit_count: 1,
      timestamp_ms: 1200,
    });
    expect(
      result.recent[0].superseded_edit_count +
        result.recent[0].reverted_edit_count,
    ).toBe(1);
  });
});

describe("file_overview", () => {
  it("returns aggregate file stats, current explanation, recent history, and related files", () => {
    const repo = scratchDir;
    const cwd = scratchDir;
    const targetFile = path.join(scratchDir, "target.ts");
    const helperFile = path.join(scratchDir, "helper.ts");
    const configFile = path.join(scratchDir, "config.ts");
    fs.writeFileSync(targetFile, "export const target = 2;\n");
    fs.writeFileSync(helperFile, "export const helper = true;\n");
    fs.writeFileSync(configFile, "export const config = true;\n");

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
      payload: { prompt: "add target and helper", session_id: SESSION },
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
          file_path: targetFile,
          old_string: "x",
          new_string: "export const target = 1;\n",
        },
      },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 1200,
      cwd,
      repository: repo,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: helperFile,
          old_string: "x",
          new_string: "export const helper = true;\n",
        },
      },
    });
    ingest({
      event_type: "UserPromptSubmit",
      ts: 2000,
      cwd,
      repository: repo,
      payload: { prompt: "refine target and add config", session_id: SESSION },
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
          file_path: targetFile,
          old_string: "x",
          new_string: "export const target = 2;\n",
        },
      },
    });
    ingest({
      event_type: "PostToolUse",
      ts: 2200,
      cwd,
      repository: repo,
      tool_name: "Edit",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: configFile,
          old_string: "x",
          new_string: "export const config = true;\n",
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

    const result = fileOverview({
      path: targetFile,
      repository: repo,
      recent_limit: 2,
      related_limit: 5,
    });

    expect(result.path).toBe(targetFile);
    expect(result.repository).toBe(repo);
    expect(result.summary).toMatchObject({
      intent_count: 2,
      edit_count: 2,
      session_summary_count: 1,
      current_edit_count: 1,
      unknown_edit_count: 0,
    });
    expect(
      result.summary.superseded_edit_count + result.summary.reverted_edit_count,
    ).toBe(1);
    expect(result.current.status).toBe("current");
    expect(result.current.intent_unit_id).not.toBeNull();
    expect(result.recent).toHaveLength(2);
    expect(result.recent[0].prompt_text).toBe("refine target and add config");
    expect(result.recent[0].edit_count).toBe(1);
    expect(result.related_files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_path: helperFile,
          shared_intent_count: 1,
          shared_session_summary_count: 1,
          last_status: "current",
        }),
        expect.objectContaining({
          file_path: configFile,
          shared_intent_count: 1,
          shared_session_summary_count: 1,
          last_status: "current",
        }),
      ]),
    );
  });
});
