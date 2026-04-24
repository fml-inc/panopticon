import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../db/driver.js";
import { refreshSessionSummaryEnrichmentsOnce } from "./enrichment.js";
import { SESSION_SUMMARY_ENRICHMENT_VERSION } from "./model.js";

const state = vi.hoisted(() => ({
  db: null as Database | null,
  inTx: false,
  detectAgentMock: vi.fn(
    (runner: string): string | null => `/usr/local/bin/${runner}`,
  ),
  invokeLlmMock: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    sessionSummaryAllowedRunners: ["claude", "codex"],
    sessionSummaryRunnerStrategy: "same_as_session",
    sessionSummaryFixedRunner: "claude",
    sessionSummaryFallbackRunners: ["claude", "codex"],
    sessionSummaryRunnerModels: {
      claude: "sonnet",
      codex: null,
    },
  },
}));

vi.mock("../db/schema.js", () => ({
  getDb: () => state.db,
}));

vi.mock("../summary/llm.js", () => ({
  detectAgent: state.detectAgentMock,
  invokeLlm: state.invokeLlmMock,
}));

describe("session summary enrichment refresh", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    state.detectAgentMock.mockImplementation(
      (runner: string): string | null => `/usr/local/bin/${runner}`,
    );
    state.invokeLlmMock.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-enrich-refresh-"));
    const dbPath = path.join(tempDir, "test.db");
    state.db = new Database(dbPath);

    const rawTransaction = state.db.transaction.bind(state.db);
    state.inTx = false;
    state.db.transaction = ((fn: (...args: unknown[]) => unknown) =>
      rawTransaction((...args: unknown[]) => {
        state.inTx = true;
        try {
          return fn(...args);
        } finally {
          state.inTx = false;
        }
      })) as typeof state.db.transaction;

    state.db.exec(`
      CREATE TABLE session_summary_enrichments (
        session_summary_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary_text TEXT,
        summary_source TEXT NOT NULL DEFAULT 'deterministic',
        summary_runner TEXT,
        summary_model TEXT,
        summary_version INTEGER NOT NULL DEFAULT 1,
        summary_generated_at_ms INTEGER,
        projection_hash TEXT,
        summary_input_hash TEXT,
        summary_policy_hash TEXT,
        enriched_input_hash TEXT,
        enriched_message_count INTEGER,
        dirty INTEGER NOT NULL DEFAULT 1,
        dirty_reason_json TEXT,
        last_material_change_at_ms INTEGER,
        last_attempted_at_ms INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE session_summaries (
        id INTEGER PRIMARY KEY,
        session_summary_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        repository TEXT,
        branch TEXT,
        intent_count INTEGER NOT NULL,
        edit_count INTEGER NOT NULL,
        landed_edit_count INTEGER NOT NULL,
        open_edit_count INTEGER NOT NULL,
        summary_search_text TEXT,
        last_intent_ts_ms INTEGER
      );
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        target TEXT,
        started_at_ms INTEGER,
        ended_at_ms INTEGER,
        message_count INTEGER
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        is_system INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE intent_session_summaries (
        session_summary_id INTEGER NOT NULL,
        intent_unit_id INTEGER NOT NULL
      );
      CREATE TABLE intent_units (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        prompt_ts_ms INTEGER,
        next_prompt_ts_ms INTEGER,
        repository TEXT,
        cwd TEXT
      );
      CREATE TABLE intent_edits (
        id INTEGER PRIMARY KEY,
        intent_unit_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        tool_name TEXT,
        timestamp_ms INTEGER,
        landed INTEGER,
        landed_reason TEXT,
        new_string_hash TEXT,
        new_string_snippet TEXT
      );
    `);

    seedSummaryRow();
  });

  afterEach(() => {
    state.db?.close();
    state.db = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs the llm outside the database transaction and persists the result", () => {
    const db = state.db!;
    state.invokeLlmMock.mockImplementation(() => {
      expect(state.inTx).toBe(false);
      return "LLM summary text.";
    });

    const result = refreshSessionSummaryEnrichmentsOnce({
      sessionId: "session-1",
      force: true,
    });

    const row = db
      .prepare(
        `SELECT summary_text, summary_source, summary_runner, summary_model,
                dirty, failure_count, last_error
         FROM session_summary_enrichments
         WHERE session_summary_key = 'ss:local:session-1'`,
      )
      .get() as
      | {
          summary_text: string;
          summary_source: string;
          summary_runner: string | null;
          summary_model: string | null;
          dirty: number;
          failure_count: number;
          last_error: string | null;
        }
      | undefined;

    expect(result).toEqual({ attempted: 1, updated: 1 });
    expect(state.invokeLlmMock).toHaveBeenCalledOnce();
    expect(row).toMatchObject({
      summary_text: "LLM summary text.",
      summary_source: "llm",
      summary_runner: "claude",
      summary_model: "sonnet",
      dirty: 0,
      failure_count: 0,
      last_error: null,
    });
  });

  it("releases a stale claim instead of persisting outdated output", () => {
    const db = state.db!;
    state.invokeLlmMock.mockImplementation(() => {
      expect(state.inTx).toBe(false);
      db.prepare(
        `UPDATE session_summary_enrichments
         SET summary_input_hash = ?, dirty = 1
         WHERE session_summary_key = 'ss:local:session-1'`,
      ).run("hash-2");
      return "stale summary";
    });

    const result = refreshSessionSummaryEnrichmentsOnce({
      sessionId: "session-1",
      force: true,
    });

    const row = db
      .prepare(
        `SELECT summary_text, summary_source, summary_input_hash,
                last_attempted_at_ms, dirty, failure_count, last_error
         FROM session_summary_enrichments
         WHERE session_summary_key = 'ss:local:session-1'`,
      )
      .get() as
      | {
          summary_text: string;
          summary_source: string;
          summary_input_hash: string | null;
          last_attempted_at_ms: number | null;
          dirty: number;
          failure_count: number;
          last_error: string | null;
        }
      | undefined;

    expect(result).toEqual({ attempted: 1, updated: 0 });
    expect(row).toMatchObject({
      summary_text: null,
      summary_source: "deterministic",
      summary_input_hash: "hash-2",
      last_attempted_at_ms: null,
      dirty: 1,
      failure_count: 0,
      last_error: null,
    });
  });

  it("skips cleanly when no allowed runner is available", () => {
    state.detectAgentMock.mockReturnValue(null);

    const result = refreshSessionSummaryEnrichmentsOnce({
      sessionId: "session-1",
    });

    const row = state
      .db!.prepare(
        `SELECT last_attempted_at_ms, failure_count, last_error, dirty
         FROM session_summary_enrichments
         WHERE session_summary_key = 'ss:local:session-1'`,
      )
      .get() as
      | {
          last_attempted_at_ms: number | null;
          failure_count: number;
          last_error: string | null;
          dirty: number;
        }
      | undefined;

    expect(result).toEqual({ attempted: 0, updated: 0 });
    expect(row).toMatchObject({
      last_attempted_at_ms: null,
      failure_count: 0,
      last_error: null,
      dirty: 1,
    });
  });

  it("ages a hot dirty row into eligibility without requiring another rebuild", () => {
    const db = state.db!;
    const now = Date.now();
    db.prepare(
      `UPDATE session_summary_enrichments
       SET last_material_change_at_ms = ?, dirty = 1
       WHERE session_summary_key = 'ss:local:session-1'`,
    ).run(now - 31 * 60 * 1000);
    db.prepare(
      `UPDATE session_summaries
       SET last_intent_ts_ms = ?
       WHERE session_summary_key = 'ss:local:session-1'`,
    ).run(now - 5 * 60 * 1000);

    state.invokeLlmMock.mockReturnValue("LLM summary text.");

    const result = refreshSessionSummaryEnrichmentsOnce({
      sessionId: "session-1",
    });

    const row = db
      .prepare(
        `SELECT summary_text, summary_source, dirty, last_attempted_at_ms
         FROM session_summary_enrichments
         WHERE session_summary_key = 'ss:local:session-1'`,
      )
      .get() as
      | {
          summary_text: string | null;
          summary_source: string;
          dirty: number;
          last_attempted_at_ms: number | null;
        }
      | undefined;

    expect(result).toEqual({ attempted: 1, updated: 1 });
    expect(state.invokeLlmMock).toHaveBeenCalledOnce();
    expect(row).toMatchObject({
      summary_text: "LLM summary text.",
      summary_source: "llm",
      dirty: 0,
    });
    expect(row?.last_attempted_at_ms).not.toBeNull();
  });

  it("includes recent message context when message growth triggers a refresh", () => {
    const db = state.db!;
    db.prepare(
      `UPDATE session_summary_enrichments
       SET summary_text = ?, summary_source = 'llm', summary_runner = 'claude',
           summary_model = 'sonnet', summary_generated_at_ms = ?, enriched_input_hash = ?,
           enriched_message_count = ?, dirty = 1, dirty_reason_json = ?,
           last_material_change_at_ms = ?, last_attempted_at_ms = NULL
       WHERE session_summary_key = 'ss:local:session-1'`,
    ).run(
      "older llm summary",
      1_000,
      "hash-1",
      1,
      JSON.stringify({
        reasons: ["message_threshold_reached", "refresh_pending"],
      }),
      1_000,
    );
    db.prepare(
      `UPDATE sessions
       SET message_count = ?
       WHERE session_id = 'session-1'`,
    ).run(25);
    db.prepare(
      `INSERT INTO messages (id, session_id, ordinal, role, content, is_system)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "session-1",
      0,
      "user",
      "Please verify the final patch behavior.",
      0,
      2,
      "session-1",
      1,
      "assistant",
      "I checked the edge cases and the output now stays stable.",
      0,
      3,
      "session-1",
      2,
      "user",
      "Confirm the retry path does not regress fixed-runner selection.",
      0,
    );

    state.invokeLlmMock.mockImplementation((prompt: string) => {
      expect(prompt).toContain("Counts: messages 25;");
      expect(prompt).toContain("Recent messages:");
      expect(prompt).toContain("user: Please verify the final patch behavior.");
      expect(prompt).toContain(
        "assistant: I checked the edge cases and the output now stays stable.",
      );
      return "LLM summary text.";
    });

    const result = refreshSessionSummaryEnrichmentsOnce({
      sessionId: "session-1",
    });

    const row = db
      .prepare(
        `SELECT summary_text, summary_source, dirty, enriched_message_count
         FROM session_summary_enrichments
         WHERE session_summary_key = 'ss:local:session-1'`,
      )
      .get() as
      | {
          summary_text: string | null;
          summary_source: string;
          dirty: number;
          enriched_message_count: number | null;
        }
      | undefined;

    expect(result).toEqual({ attempted: 1, updated: 1 });
    expect(state.invokeLlmMock).toHaveBeenCalledOnce();
    expect(row).toMatchObject({
      summary_text: "LLM summary text.",
      summary_source: "llm",
      dirty: 0,
      enriched_message_count: 25,
    });
  });
});

function seedSummaryRow(): void {
  const db = state.db!;
  db.prepare(
    `INSERT INTO session_summaries
     (id, session_summary_key, session_id, title, status, repository, branch,
      intent_count, edit_count, landed_edit_count, open_edit_count,
      summary_search_text, last_intent_ts_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    1,
    "ss:local:session-1",
    "session-1",
    "diagnose summary lock",
    "mixed",
    "/repo",
    "main",
    1,
    1,
    1,
    0,
    "Title: diagnose summary lock",
    1_000,
  );

  db.prepare(
    `INSERT INTO sessions (session_id, target, started_at_ms, ended_at_ms, message_count)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("session-1", "claude", 500, 1_000, 7);

  db.prepare(
    `INSERT INTO intent_units
     (id, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms, repository, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    10,
    "session-1",
    "fix the summary contention bug",
    900,
    null,
    "/repo",
    "/repo",
  );

  db.prepare(
    `INSERT INTO intent_session_summaries (session_summary_id, intent_unit_id)
     VALUES (?, ?)`,
  ).run(1, 10);

  db.prepare(
    `INSERT INTO intent_edits
     (id, intent_unit_id, session_id, file_path, tool_name, timestamp_ms, landed,
      landed_reason, new_string_hash, new_string_snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    1,
    10,
    "session-1",
    "src/session_summaries/enrichment.ts",
    "Edit",
    950,
    1,
    null,
    null,
    null,
  );

  db.prepare(
    `INSERT INTO session_summary_enrichments
     (session_summary_key, session_id, summary_text,
      summary_source, summary_runner, summary_model, summary_version,
      summary_generated_at_ms, projection_hash, summary_input_hash,
      summary_policy_hash, enriched_input_hash, enriched_message_count,
      dirty, dirty_reason_json, last_material_change_at_ms,
      last_attempted_at_ms, failure_count, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "ss:local:session-1",
    "session-1",
    null,
    "deterministic",
    null,
    null,
    SESSION_SUMMARY_ENRICHMENT_VERSION,
    null,
    "projection-hash",
    "hash-1",
    null,
    null,
    null,
    1,
    JSON.stringify({ reasons: ["session_cold", "refresh_pending"] }),
    600,
    null,
    0,
    null,
  );
}
