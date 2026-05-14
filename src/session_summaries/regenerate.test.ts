import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
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
  const tmpDir = _path.join(_os.tmpdir(), "pano-session-regen-test");
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

import { getAttemptBackoff } from "../attempt-backoff.js";
import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { SUMMARY_ROW_BACKOFF_SCOPE } from "./backoff.js";
import {
  SESSION_SUMMARY_ENRICHMENT_VERSION,
  SESSION_SUMMARY_PENDING_AGE_THRESHOLD_MS,
} from "./model.js";
import { getSessionSummaryRunnerPolicy } from "./policy.js";
import { regenerateSessionSummaryEnrichments } from "./regenerate.js";

const NOW = Date.parse("2026-05-14T12:00:00.000Z");

beforeAll(() => {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb();
});

afterAll(() => {
  closeDb();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const db = getDb();
  db.prepare("DELETE FROM attempt_backoffs").run();
  db.prepare("DELETE FROM session_summary_search_index").run();
  db.prepare("DELETE FROM session_summary_enrichments").run();
  db.prepare("DELETE FROM session_summaries").run();
  db.prepare("DELETE FROM sessions").run();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("regenerateSessionSummaryEnrichments", () => {
  it("dry-runs a time-scoped regeneration without mutating rows", () => {
    insertSummary({ sessionId: "recent", activityMs: NOW - 60_000 });
    insertSummary({ sessionId: "old", activityMs: NOW - 86_400_000 });

    const result = regenerateSessionSummaryEnrichments({
      since: "2h",
      dryRun: true,
      reason: "prompt-version",
    });

    expect(result).toMatchObject({
      dryRun: true,
      selected: 1,
      markedDirty: 0,
      stale: 1,
      byVersion: { "1": 1 },
    });
    expect(result.items[0]).toMatchObject({
      session_id: "recent",
      dirty: false,
      stale: true,
    });

    const rows = getEnrichmentRows();
    expect(rows).toMatchObject([
      { session_id: "old", dirty: 0 },
      { session_id: "recent", dirty: 0 },
    ]);
  });

  it("marks selected summaries dirty and immediately eligible for enrichment", () => {
    const key = insertSummary({
      sessionId: "recent",
      activityMs: NOW - 60_000,
      dirty: 0,
      lastAttemptedAtMs: NOW - 1_000,
      failureCount: 2,
      lastError: "old failure",
    });
    getDb()
      .prepare(
        `INSERT INTO attempt_backoffs
         (scope_kind, scope_key, failure_count, next_attempt_at_ms, updated_at_ms)
         VALUES (?, ?, 2, ?, ?)`,
      )
      .run(SUMMARY_ROW_BACKOFF_SCOPE, key, NOW + 60_000, NOW);

    const result = regenerateSessionSummaryEnrichments({
      since: "2h",
      dryRun: false,
      reason: "prompt-version",
    });

    expect(result).toMatchObject({
      dryRun: false,
      selected: 1,
      markedDirty: 1,
      alreadyDirty: 0,
    });

    const row = getDb()
      .prepare(
        `SELECT dirty, dirty_reason_json, last_material_change_at_ms,
                last_attempted_at_ms, failure_count, last_error
         FROM session_summary_enrichments
         WHERE session_summary_key = ?`,
      )
      .get(key) as {
      dirty: number;
      dirty_reason_json: string;
      last_material_change_at_ms: number;
      last_attempted_at_ms: number | null;
      failure_count: number;
      last_error: string | null;
    };
    expect(row.dirty).toBe(1);
    expect(row.last_material_change_at_ms).toBe(
      NOW - SESSION_SUMMARY_PENDING_AGE_THRESHOLD_MS - 1,
    );
    expect(row.last_attempted_at_ms).toBeNull();
    expect(row.failure_count).toBe(0);
    expect(row.last_error).toBeNull();
    expect(JSON.parse(row.dirty_reason_json)).toMatchObject({
      reasons: [
        "regeneration_requested",
        "summary_version_changed",
        "summary_policy_changed",
        "refresh_pending",
      ],
      regeneration: {
        reason: "prompt-version",
        current_summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
        time_field: "activity",
      },
    });
    expect(getAttemptBackoff(SUMMARY_ROW_BACKOFF_SCOPE, key)).toBeNull();

    const search = getDb()
      .prepare(
        `SELECT dirty
         FROM session_summary_search_index
         WHERE session_summary_key = ? AND source = 'llm'`,
      )
      .get(key) as { dirty: number };
    expect(search.dirty).toBe(1);

    const session = getDb()
      .prepare(`SELECT derived_sync_seq FROM sessions WHERE session_id = ?`)
      .get("recent") as { derived_sync_seq: number };
    expect(session.derived_sync_seq).toBe(1);
  });

  it("selects by summary generation time when requested", () => {
    insertSummary({
      sessionId: "new-generated",
      activityMs: NOW - 86_400_000,
      generatedAtMs: NOW - 30_000,
    });
    insertSummary({
      sessionId: "old-generated",
      activityMs: NOW - 30_000,
      generatedAtMs: NOW - 86_400_000,
    });

    const result = regenerateSessionSummaryEnrichments({
      since: "1h",
      by: "generated-at",
      dryRun: true,
    });

    expect(result.selected).toBe(1);
    expect(result.items[0].session_id).toBe("new-generated");
  });

  it("requires an explicit scope unless --all is provided", () => {
    expect(() => regenerateSessionSummaryEnrichments()).toThrow(
      "At least one regeneration scope is required",
    );

    expect(
      regenerateSessionSummaryEnrichments({ all: true, dryRun: true }),
    ).toMatchObject({ selected: 0 });
  });
});

function insertSummary(opts: {
  sessionId: string;
  activityMs: number;
  generatedAtMs?: number;
  version?: number;
  dirty?: number;
  lastAttemptedAtMs?: number | null;
  failureCount?: number;
  lastError?: string | null;
}): string {
  const db = getDb();
  const key = `ss:local:${opts.sessionId}`;
  const repository = path.join(os.tmpdir(), "repo");
  const cwd = path.join(repository, "work");
  const policyHash =
    opts.version === SESSION_SUMMARY_ENRICHMENT_VERSION
      ? getSessionSummaryRunnerPolicy().policyHash
      : "old-policy";
  db.prepare(
    `INSERT INTO sessions
     (session_id, target, started_at_ms, ended_at_ms, message_count,
      derived_sync_seq)
     VALUES (?, 'codex', ?, ?, 10, 0)`,
  ).run(opts.sessionId, opts.activityMs - 1000, opts.activityMs);
  db.prepare(
    `INSERT INTO session_summaries
     (session_summary_key, session_id, repository, cwd, title, status,
      intent_count, edit_count, landed_edit_count, open_edit_count,
      summary_text, projection_hash, projected_at_ms, source_last_seen_at_ms,
      last_intent_ts_ms)
     VALUES (?, ?, ?, ?, ?, 'landed', 1, 1, 1, 0, ?, ?, ?, ?, ?)`,
  ).run(
    key,
    opts.sessionId,
    repository,
    cwd,
    `Summary ${opts.sessionId}`,
    `Deterministic ${opts.sessionId}`,
    `projection-${opts.sessionId}`,
    opts.activityMs,
    opts.activityMs,
    opts.activityMs,
  );
  db.prepare(
    `INSERT INTO session_summary_enrichments
     (session_summary_key, session_id, summary_text, summary_source,
      summary_runner, summary_model, summary_version, summary_generated_at_ms,
      projection_hash, summary_input_hash, summary_policy_hash,
      enriched_input_hash, enriched_message_count, dirty, dirty_reason_json,
      last_material_change_at_ms, last_attempted_at_ms, failure_count,
      last_error)
     VALUES (?, ?, ?, 'llm', 'codex', NULL, ?, ?, ?, ?, ?, ?, 10, ?, NULL,
             NULL, ?, ?, ?)`,
  ).run(
    key,
    opts.sessionId,
    `LLM ${opts.sessionId}`,
    opts.version ?? 1,
    opts.generatedAtMs ?? opts.activityMs,
    `projection-${opts.sessionId}`,
    `input-${opts.sessionId}`,
    policyHash,
    `input-${opts.sessionId}`,
    opts.dirty ?? 0,
    opts.lastAttemptedAtMs ?? null,
    opts.failureCount ?? 0,
    opts.lastError ?? null,
  );
  db.prepare(
    `INSERT INTO session_summary_search_index
     (session_summary_key, session_id, corpus_key, source, priority,
      search_text, dirty, updated_at_ms)
     VALUES (?, ?, 'llm_summary', 'llm', 80, ?, 0, ?)`,
  ).run(key, opts.sessionId, `LLM ${opts.sessionId}`, opts.activityMs);
  return key;
}

function getEnrichmentRows(): Array<{ session_id: string; dirty: number }> {
  return getDb()
    .prepare(
      `SELECT session_id, dirty
       FROM session_summary_enrichments
       ORDER BY session_id ASC`,
    )
    .all() as Array<{ session_id: string; dirty: number }>;
}
