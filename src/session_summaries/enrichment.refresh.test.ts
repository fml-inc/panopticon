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
    attemptBackoffScheduleMs: [
      60_000,
      2 * 60_000,
      4 * 60_000,
      8 * 60_000,
      16 * 60_000,
      32 * 60_000,
      60 * 60_000,
      2 * 60 * 60_000,
      4 * 60 * 60_000,
      6 * 60 * 60_000,
    ],
    attemptBackoffJitterRatio: 0.1,
  },
}));

vi.mock("../db/schema.js", () => ({
  getDb: () => state.db,
}));

vi.mock("../summary/llm.js", () => ({
  detectAgent: state.detectAgentMock,
  invokeLlmAsync: state.invokeLlmMock,
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
      CREATE TABLE attempt_backoffs (
        scope_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_attempted_at_ms INTEGER,
        next_attempt_at_ms INTEGER,
        last_error TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope_kind, scope_key)
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

  it("runs the llm outside the database transaction and persists the result", async () => {
    const db = state.db!;
    state.invokeLlmMock.mockImplementation(async () => {
      expect(state.inTx).toBe(false);
      return "LLM summary text.";
    });

    const result = await refreshSessionSummaryEnrichmentsOnce({
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

  it("releases a stale claim instead of persisting outdated output", async () => {
    const db = state.db!;
    state.invokeLlmMock.mockImplementation(async () => {
      expect(state.inTx).toBe(false);
      db.prepare(
        `UPDATE session_summary_enrichments
         SET summary_input_hash = ?, dirty = 1
         WHERE session_summary_key = 'ss:local:session-1'`,
      ).run("hash-2");
      return "stale summary";
    });

    const result = await refreshSessionSummaryEnrichmentsOnce({
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

  it("skips cleanly when no allowed runner is available", async () => {
    const db = state.db!;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    state.detectAgentMock.mockReturnValue(null);

    try {
      const result = await refreshSessionSummaryEnrichmentsOnce({
        sessionId: "session-1",
        force: true,
      });

      const row = db
        .prepare(
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
      const backoff = db
        .prepare(
          `SELECT failure_count, next_attempt_at_ms, last_error
           FROM attempt_backoffs
           WHERE scope_kind = 'session-summary-global'
             AND scope_key = 'runner-availability'`,
        )
        .get() as
        | {
            failure_count: number;
            next_attempt_at_ms: number | null;
            last_error: string | null;
          }
        | undefined;

      expect(result).toEqual({ attempted: 0, updated: 0 });
      expect(row).toMatchObject({
        last_attempted_at_ms: null,
        failure_count: 0,
        last_error: null,
        dirty: 1,
      });
      expect(backoff).toMatchObject({
        failure_count: 1,
        next_attempt_at_ms: 160_000,
        last_error: "no allowed summary runner available",
      });

      const skipped = await refreshSessionSummaryEnrichmentsOnce({
        sessionId: "session-1",
      });
      expect(skipped).toEqual({ attempted: 0, updated: 0 });
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("backs off runner retries after an invocation failure", async () => {
    const db = state.db!;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    state.invokeLlmMock.mockReturnValue(null);

    try {
      const first = await refreshSessionSummaryEnrichmentsOnce({
        sessionId: "session-1",
        force: true,
      });
      const row = db
        .prepare(
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
      const backoff = db
        .prepare(
          `SELECT failure_count, next_attempt_at_ms, last_error
           FROM attempt_backoffs
           WHERE scope_kind = 'session-summary-runner'
             AND scope_key = 'claude'`,
        )
        .get() as
        | {
            failure_count: number;
            next_attempt_at_ms: number | null;
            last_error: string | null;
          }
        | undefined;

      expect(first).toEqual({ attempted: 1, updated: 0 });
      expect(state.invokeLlmMock).toHaveBeenCalledOnce();
      expect(row).toMatchObject({
        failure_count: 1,
        last_error: "summary enrichment invocation failed for claude",
        dirty: 1,
      });
      expect(backoff).toMatchObject({
        failure_count: 1,
        next_attempt_at_ms: 160_000,
      });

      state.invokeLlmMock.mockClear();
      const skipped = await refreshSessionSummaryEnrichmentsOnce({
        sessionId: "session-1",
      });
      expect(skipped).toEqual({ attempted: 0, updated: 0 });
      expect(state.invokeLlmMock).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("ages a hot dirty row into eligibility without requiring another rebuild", async () => {
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

    state.invokeLlmMock.mockResolvedValue("LLM summary text.");

    const result = await refreshSessionSummaryEnrichmentsOnce({
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

  it("applies the limit after eligibility so a hot row does not block older work", async () => {
    const db = state.db!;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));

    try {
      const now = Date.now();
      db.prepare(
        `UPDATE session_summary_enrichments
         SET last_material_change_at_ms = ?, dirty = 1
         WHERE session_summary_key = 'ss:local:session-1'`,
      ).run(now);
      db.prepare(
        `UPDATE session_summaries
         SET last_intent_ts_ms = ?
         WHERE session_summary_key = 'ss:local:session-1'`,
      ).run(now);
      db.prepare(
        `UPDATE sessions
         SET started_at_ms = ?, ended_at_ms = ?, message_count = ?
         WHERE session_id = 'session-1'`,
      ).run(now, now, 1);

      seedSummaryRow({
        id: 2,
        sessionId: "session-2",
        sessionSummaryKey: "ss:local:session-2",
        lastIntentTsMs: now - 7 * 60 * 60 * 1000,
        lastMaterialChangeAtMs: now - 60 * 60 * 1000,
        messageCount: 2,
      });

      state.invokeLlmMock.mockResolvedValue("LLM summary text.");

      const result = await refreshSessionSummaryEnrichmentsOnce({ limit: 1 });

      const rows = db
        .prepare(
          `SELECT session_id, summary_source, dirty
           FROM session_summary_enrichments
           ORDER BY session_id`,
        )
        .all() as Array<{
        session_id: string;
        summary_source: string;
        dirty: number;
      }>;

      expect(result).toEqual({ attempted: 1, updated: 1 });
      expect(state.invokeLlmMock).toHaveBeenCalledOnce();
      expect(rows).toEqual([
        { session_id: "session-1", summary_source: "deterministic", dirty: 1 },
        { session_id: "session-2", summary_source: "llm", dirty: 0 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes recent message context when message growth triggers a refresh", async () => {
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

    state.invokeLlmMock.mockImplementation(async (prompt: string) => {
      expect(prompt).toContain("Counts: messages 25;");
      expect(prompt).toContain("Recent messages:");
      expect(prompt).toContain("user: Please verify the final patch behavior.");
      expect(prompt).toContain(
        "assistant: I checked the edge cases and the output now stays stable.",
      );
      return "LLM summary text.";
    });

    const result = await refreshSessionSummaryEnrichmentsOnce({
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

  it("processes multiple claimed rows up to the configured concurrency", async () => {
    const db = state.db!;
    seedAdditionalSummaryRow();

    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    state.invokeLlmMock.mockImplementation(async (prompt: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve();
        });
      });
      return prompt.includes("session-2")
        ? "Second LLM summary text."
        : "First LLM summary text.";
    });

    const refreshPromise = refreshSessionSummaryEnrichmentsOnce({
      limit: 2,
      concurrency: 2,
      force: true,
    });
    await vi.waitFor(() => {
      expect(state.invokeLlmMock).toHaveBeenCalledTimes(2);
    });
    for (const release of releases.splice(0)) {
      release();
    }
    const result = await refreshPromise;

    const rows = db
      .prepare(
        `SELECT session_summary_key, summary_text, dirty
         FROM session_summary_enrichments
         WHERE session_summary_key IN ('ss:local:session-1', 'ss:local:session-2')
         ORDER BY session_summary_key ASC`,
      )
      .all() as Array<{
      session_summary_key: string;
      summary_text: string | null;
      dirty: number;
    }>;

    expect(result).toEqual({ attempted: 2, updated: 2 });
    expect(peak).toBe(2);
    expect(rows).toEqual([
      {
        session_summary_key: "ss:local:session-1",
        summary_text: "First LLM summary text.",
        dirty: 0,
      },
      {
        session_summary_key: "ss:local:session-2",
        summary_text: "Second LLM summary text.",
        dirty: 0,
      },
    ]);
  });

  it("processes multiple concurrent enrichment batches across repeated rounds", async () => {
    const db = state.db!;
    seedAdditionalSummaryRow();

    let maxPeak = 0;
    for (const round of [1, 2, 3]) {
      let active = 0;
      let peak = 0;
      const releases: Array<() => void> = [];
      state.invokeLlmMock.mockReset();
      state.invokeLlmMock.mockImplementation(async (prompt: string) => {
        active += 1;
        peak = Math.max(peak, active);
        maxPeak = Math.max(maxPeak, peak);
        const label = prompt.includes("session-2") ? "session-2" : "session-1";
        await new Promise<void>((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve();
          });
        });
        return `round-${round}-${label}`;
      });

      const refreshPromise = refreshSessionSummaryEnrichmentsOnce({
        limit: 2,
        concurrency: 2,
        force: true,
      });
      await vi.waitFor(() => {
        expect(state.invokeLlmMock).toHaveBeenCalledTimes(2);
      });
      for (const release of releases.splice(0)) {
        release();
      }

      const result = await refreshPromise;
      const rows = db
        .prepare(
          `SELECT session_summary_key, summary_text, dirty
           FROM session_summary_enrichments
           WHERE session_summary_key IN ('ss:local:session-1', 'ss:local:session-2')
           ORDER BY session_summary_key ASC`,
        )
        .all() as Array<{
        session_summary_key: string;
        summary_text: string | null;
        dirty: number;
      }>;

      expect(result).toEqual({ attempted: 2, updated: 2 });
      expect(peak).toBe(2);
      expect(rows).toEqual([
        {
          session_summary_key: "ss:local:session-1",
          summary_text: `round-${round}-session-1`,
          dirty: 0,
        },
        {
          session_summary_key: "ss:local:session-2",
          summary_text: `round-${round}-session-2`,
          dirty: 0,
        },
      ]);

      if (round < 3) {
        prepareRowsForAnotherRound(round);
      }
    }

    expect(maxPeak).toBe(2);
  });
});

function seedSummaryRow(
  opts: {
    id?: number;
    sessionId?: string;
    sessionSummaryKey?: string;
    lastIntentTsMs?: number;
    lastMaterialChangeAtMs?: number;
    messageCount?: number;
  } = {},
): void {
  const db = state.db!;
  const id = opts.id ?? 1;
  const sessionId = opts.sessionId ?? "session-1";
  const sessionSummaryKey = opts.sessionSummaryKey ?? "ss:local:session-1";
  const lastIntentTsMs = opts.lastIntentTsMs ?? 1_000;
  const lastMaterialChangeAtMs = opts.lastMaterialChangeAtMs ?? 600;
  const messageCount = opts.messageCount ?? 7;
  db.prepare(
    `INSERT INTO session_summaries
     (id, session_summary_key, session_id, title, status, repository, branch,
      intent_count, edit_count, landed_edit_count, open_edit_count,
      last_intent_ts_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionSummaryKey,
    sessionId,
    "diagnose summary lock",
    "mixed",
    "/repo",
    "main",
    1,
    1,
    1,
    0,
    lastIntentTsMs,
  );

  db.prepare(
    `INSERT INTO sessions (session_id, target, started_at_ms, ended_at_ms, message_count)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    "claude",
    lastIntentTsMs - 500,
    lastIntentTsMs,
    messageCount,
  );

  db.prepare(
    `INSERT INTO intent_units
     (id, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms, repository, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id * 10,
    sessionId,
    "fix the summary contention bug",
    lastIntentTsMs - 100,
    null,
    "/repo",
    "/repo",
  );

  db.prepare(
    `INSERT INTO intent_session_summaries (session_summary_id, intent_unit_id)
     VALUES (?, ?)`,
  ).run(id, id * 10);

  db.prepare(
    `INSERT INTO intent_edits
     (id, intent_unit_id, session_id, file_path, tool_name, timestamp_ms, landed,
      landed_reason, new_string_hash, new_string_snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id * 10,
    sessionId,
    "src/session_summaries/enrichment.ts",
    "Edit",
    lastIntentTsMs - 50,
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
    sessionSummaryKey,
    sessionId,
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
    lastMaterialChangeAtMs,
    null,
    0,
    null,
  );
}

function seedAdditionalSummaryRow(): void {
  const db = state.db!;
  db.prepare(
    `INSERT INTO session_summaries
     (id, session_summary_key, session_id, title, status, repository, branch,
      intent_count, edit_count, landed_edit_count, open_edit_count,
      last_intent_ts_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    2,
    "ss:local:session-2",
    "session-2",
    "session-2 concurrency check",
    "landed",
    "/repo",
    "main",
    1,
    1,
    1,
    0,
    1_500,
  );

  db.prepare(
    `INSERT INTO sessions (session_id, target, started_at_ms, ended_at_ms, message_count)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("session-2", "claude", 1_100, 1_500, 8);

  db.prepare(
    `INSERT INTO intent_units
     (id, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms, repository, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    20,
    "session-2",
    "summarize the second session row",
    1_200,
    null,
    "/repo",
    "/repo",
  );

  db.prepare(
    `INSERT INTO intent_session_summaries (session_summary_id, intent_unit_id)
     VALUES (?, ?)`,
  ).run(2, 20);

  db.prepare(
    `INSERT INTO intent_edits
     (id, intent_unit_id, session_id, file_path, tool_name, timestamp_ms, landed,
      landed_reason, new_string_hash, new_string_snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    2,
    20,
    "session-2",
    "src/session_summaries/pass.ts",
    "Edit",
    1_250,
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
    "ss:local:session-2",
    "session-2",
    null,
    "deterministic",
    null,
    null,
    SESSION_SUMMARY_ENRICHMENT_VERSION,
    null,
    "projection-hash-2",
    "hash-2",
    null,
    null,
    null,
    1,
    JSON.stringify({ reasons: ["session_cold", "refresh_pending"] }),
    1_200,
    null,
    0,
    null,
  );
}

function prepareRowsForAnotherRound(round: number): void {
  const db = state.db!;
  db.prepare(
    `UPDATE session_summary_enrichments
     SET dirty = 1,
         dirty_reason_json = ?,
         last_material_change_at_ms = ?,
         last_attempted_at_ms = NULL,
         summary_input_hash = ?,
         enriched_input_hash = NULL,
         enriched_message_count = NULL
     WHERE session_summary_key = ?`,
  ).run(
    JSON.stringify({ reasons: ["refresh_pending", `round_${round}_rerun`] }),
    2_000 + round,
    `hash-1-round-${round}`,
    "ss:local:session-1",
  );
  db.prepare(
    `UPDATE session_summary_enrichments
     SET dirty = 1,
         dirty_reason_json = ?,
         last_material_change_at_ms = ?,
         last_attempted_at_ms = NULL,
         summary_input_hash = ?,
         enriched_input_hash = NULL,
         enriched_message_count = NULL
     WHERE session_summary_key = ?`,
  ).run(
    JSON.stringify({ reasons: ["refresh_pending", `round_${round}_rerun`] }),
    3_000 + round,
    `hash-2-round-${round}`,
    "ss:local:session-2",
  );
}
