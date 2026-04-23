import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/driver.js";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const ENV_KEYS = [
  "PANOPTICON_DATA_DIR",
  "PANOPTICON_ENABLE_SESSION_SUMMARY_PROJECTIONS",
  "PANOPTICON_SESSION_SUMMARY_ALLOWED_RUNNERS",
  "PANOPTICON_SESSION_SUMMARY_RUNNER_STRATEGY",
  "PANOPTICON_SESSION_SUMMARY_FIXED_RUNNER",
  "PANOPTICON_SESSION_SUMMARY_FALLBACK_RUNNERS",
  "PATH",
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

type RuntimeModules = {
  closeDb: () => void;
  getDb: () => Database;
  rebuildSessionSummaryProjections: (opts?: { sessionId?: string }) => {
    memberships: number;
    provenance: number;
    sessionSummaries: number;
  };
  refreshSessionSummaryEnrichmentsOnce: (opts?: {
    force?: boolean;
    limit?: number;
    log?: (msg: string) => void;
    sessionId?: string;
  }) => { attempted: number; updated: number };
};

function configureSummaryEnv(dataDir: string, shimDir: string): void {
  process.env.PANOPTICON_DATA_DIR = dataDir;
  process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_PROJECTIONS = "1";
  process.env.PANOPTICON_SESSION_SUMMARY_ALLOWED_RUNNERS = "claude";
  process.env.PANOPTICON_SESSION_SUMMARY_RUNNER_STRATEGY = "fixed";
  process.env.PANOPTICON_SESSION_SUMMARY_FIXED_RUNNER = "claude";
  process.env.PANOPTICON_SESSION_SUMMARY_FALLBACK_RUNNERS = "claude";
  process.env.PATH = `${shimDir}:${SYSTEM_PATH}`;
}

function writeClaudeShim(
  shimDir: string,
  mode: "failure" | "success" | "unavailable",
): void {
  const shimPath = path.join(shimDir, "claude");
  fs.rmSync(shimPath, { force: true });

  if (mode === "unavailable") return;

  const body =
    mode === "success"
      ? [
          "#!/bin/sh",
          'printf \'%s\' \'{"type":"result","subtype":"success","is_error":false,"result":"Synthetic summary from shim."}\'',
          "",
        ].join("\n")
      : [
          "#!/bin/sh",
          'printf \'%s\' \'{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · synthetic auth failure"}\'',
          "exit 1",
          "",
        ].join("\n");

  fs.writeFileSync(shimPath, body, { mode: 0o755 });
}

function seedSummaryInputs(db: Database, filePath: string): void {
  db.prepare(
    `INSERT INTO sessions (
       session_id, target, started_at_ms, ended_at_ms, machine, message_count
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("session-1", "claude", 1, 2, "test-machine", 24);

  db.prepare(
    `INSERT INTO session_repositories (
       session_id, repository, first_seen_ms, git_user_name, branch
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run("session-1", "org/repo", 1, "tester", "main");

  db.prepare(
    `INSERT INTO session_cwds (session_id, cwd, first_seen_ms)
     VALUES (?, ?, ?)`,
  ).run("session-1", path.dirname(filePath), 1);

  const intent = db
    .prepare(
      `INSERT INTO intent_units (
         intent_key, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms,
         edit_count, cwd, repository
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "intent-1",
      "session-1",
      "Add summary retry coverage for the enrichment loop",
      1,
      2,
      1,
      path.dirname(filePath),
      "org/repo",
    );

  db.prepare(
    `INSERT INTO intent_edits (
       edit_key, intent_unit_id, session_id, timestamp_ms, file_path,
       tool_name, new_string_hash, new_string_snippet, landed
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "edit-1",
    Number(intent.lastInsertRowid),
    "session-1",
    3,
    filePath,
    "Write",
    "hash-1",
    "export function retrySummary() { return 'ok'; }",
    1,
  );
}

function readAttemptBackoff(
  db: Database,
  scopeKind: string,
  scopeKey: string,
):
  | {
      failure_count: number;
      last_attempted_at_ms: number | null;
      last_error: string | null;
      next_attempt_at_ms: number | null;
    }
  | undefined {
  return db
    .prepare(
      `SELECT failure_count, last_attempted_at_ms, last_error, next_attempt_at_ms
       FROM attempt_backoffs
       WHERE scope_kind = ? AND scope_key = ?`,
    )
    .get(scopeKind, scopeKey) as
    | {
        failure_count: number;
        last_attempted_at_ms: number | null;
        last_error: string | null;
        next_attempt_at_ms: number | null;
      }
    | undefined;
}

function readEnrichmentRow(db: Database) {
  return db
    .prepare(
      `SELECT summary_text, summary_source, summary_runner, dirty,
              failure_count, last_error, last_attempted_at_ms
       FROM session_summary_enrichments
       WHERE session_summary_key = 'ss:local:session-1'`,
    )
    .get() as
    | {
        dirty: number;
        failure_count: number;
        last_attempted_at_ms: number | null;
        last_error: string | null;
        summary_runner: string | null;
        summary_source: string;
        summary_text: string | null;
      }
    | undefined;
}

function expireBackoff(
  db: Database,
  scopeKind: string,
  scopeKey: string,
): void {
  db.prepare(
    `UPDATE attempt_backoffs
     SET next_attempt_at_ms = 0
     WHERE scope_kind = ? AND scope_key = ?`,
  ).run(scopeKind, scopeKey);
}

async function restartRuntime(): Promise<RuntimeModules> {
  vi.resetModules();
  const configMod = await import("../config.js");
  const dbMod = await import("../db/schema.js");
  const projectMod = await import("./project.js");
  const enrichMod = await import("./enrichment.js");

  configMod.ensureDataDir();

  return {
    closeDb: dbMod.closeDb,
    getDb: dbMod.getDb,
    rebuildSessionSummaryProjections:
      projectMod.rebuildSessionSummaryProjections,
    refreshSessionSummaryEnrichmentsOnce:
      enrichMod.refreshSessionSummaryEnrichmentsOnce,
  };
}

afterEach(async () => {
  try {
    const dbMod = await import("../db/schema.js");
    dbMod.closeDb();
  } catch {}

  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("session summary enrichment with PATH-based runner availability", () => {
  it("persists backoff across restarts for unavailable and failing runners, then recovers on success", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pano-summary-agent-integration-"),
    );
    const shimDir = path.join(tempDir, "bin");
    const repoDir = path.join(tempDir, "repo");
    const filePath = path.join(repoDir, "src", "retry-summary.ts");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      "export function retrySummary() { return 'ok'; }\n",
    );

    configureSummaryEnv(tempDir, shimDir);
    writeClaudeShim(shimDir, "unavailable");

    let runtime = await restartRuntime();
    try {
      const db = runtime.getDb();
      seedSummaryInputs(db, filePath);

      expect(
        runtime.rebuildSessionSummaryProjections({ sessionId: "session-1" }),
      ).toMatchObject({
        memberships: 1,
        sessionSummaries: 1,
      });

      expect(
        runtime.refreshSessionSummaryEnrichmentsOnce({
          sessionId: "session-1",
        }),
      ).toEqual({ attempted: 0, updated: 0 });
      expect(readEnrichmentRow(db)).toMatchObject({
        dirty: 1,
        failure_count: 0,
        last_attempted_at_ms: null,
        last_error: null,
        summary_source: "deterministic",
      });

      expect(
        readAttemptBackoff(db, "session-summary-global", "runner-availability"),
      ).toMatchObject({
        failure_count: 1,
        last_error: "no allowed summary runner available",
      });

      runtime.closeDb();
      writeClaudeShim(shimDir, "success");
      runtime = await restartRuntime();
      const afterRestartDb = runtime.getDb();

      expect(
        runtime.refreshSessionSummaryEnrichmentsOnce({
          sessionId: "session-1",
        }),
      ).toEqual({ attempted: 0, updated: 0 });
      expect(readEnrichmentRow(afterRestartDb)).toMatchObject({
        dirty: 1,
        summary_source: "deterministic",
      });

      expireBackoff(
        afterRestartDb,
        "session-summary-global",
        "runner-availability",
      );

      runtime.closeDb();
      writeClaudeShim(shimDir, "failure");
      runtime = await restartRuntime();
      const failingDb = runtime.getDb();

      expect(
        runtime.refreshSessionSummaryEnrichmentsOnce({
          sessionId: "session-1",
        }),
      ).toEqual({ attempted: 1, updated: 0 });
      expect(readEnrichmentRow(failingDb)).toMatchObject({
        dirty: 1,
        failure_count: 1,
        last_error: "summary enrichment invocation failed for claude",
        summary_source: "deterministic",
      });
      expect(
        readAttemptBackoff(failingDb, "session-summary-runner", "claude"),
      ).toMatchObject({
        failure_count: 1,
        last_error: "summary enrichment invocation failed for claude",
      });

      runtime.closeDb();
      writeClaudeShim(shimDir, "success");
      runtime = await restartRuntime();
      const blockedRunnerDb = runtime.getDb();

      expect(
        runtime.refreshSessionSummaryEnrichmentsOnce({
          sessionId: "session-1",
        }),
      ).toEqual({ attempted: 0, updated: 0 });

      expireBackoff(blockedRunnerDb, "session-summary-runner", "claude");

      runtime.closeDb();
      runtime = await restartRuntime();
      const recoveredDb = runtime.getDb();

      expect(
        runtime.refreshSessionSummaryEnrichmentsOnce({
          sessionId: "session-1",
        }),
      ).toEqual({ attempted: 1, updated: 1 });
      expect(readEnrichmentRow(recoveredDb)).toMatchObject({
        dirty: 0,
        failure_count: 0,
        last_error: null,
        summary_runner: "claude",
        summary_source: "llm",
        summary_text: "Synthetic summary from shim.",
      });
      expect(
        recoveredDb
          .prepare(
            `SELECT COUNT(*) AS cnt
             FROM attempt_backoffs
             WHERE scope_kind LIKE 'session-summary-%'`,
          )
          .get() as { cnt: number },
      ).toMatchObject({ cnt: 0 });
    } finally {
      runtime.closeDb();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
