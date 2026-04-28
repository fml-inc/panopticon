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
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-sync-loop");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { closeDb, getDb } from "../db/schema.js";
import { buildMessageSyncId } from "../db/sync-ids.js";
import {
  readSessionDerivedState,
  readSessionMessages,
  readSessionsByIds,
} from "./reader.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function insertSession(sessionId: string, syncSeq: number): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO sessions (session_id, sync_seq, machine, relationship_type)
     VALUES (?, ?, 'test-machine', 'standalone')`,
  ).run(sessionId, syncSeq);
}

function insertSessionRepo(sessionId: string, repository = "org/repo"): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO session_repositories (session_id, repository, first_seen_ms)
     VALUES (?, ?, 0)`,
  ).run(sessionId, repository);
}

function insertSessionSummary(sessionId: string, summaryText: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO session_summaries (
       session_summary_key, session_id, title, status, summary_text,
       projection_hash, projected_at_ms
     ) VALUES (?, ?, 'Test summary', 'read-only', ?, 'hash', 0)`,
  ).run(`summary:${sessionId}`, sessionId, summaryText);
}

function insertMessage(
  sessionId: string,
  ordinal: number,
  content = `msg-${ordinal}`,
): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO messages (session_id, ordinal, role, content, sync_id)
       VALUES (?, ?, 'assistant', ?, ?)`,
    )
    .run(sessionId, ordinal, content, buildMessageSyncId(sessionId, ordinal));
  return Number(result.lastInsertRowid);
}

function getTargetSync(sessionId: string, target: string) {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM target_session_sync WHERE session_id = ? AND target = ?",
    )
    .get(sessionId, target) as Record<string, unknown> | undefined;
}

function recordConfirmed(sessionIds: string[], targetName: string): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO target_session_sync (session_id, target, confirmed, sync_seq)
     VALUES (?, ?, 1, (SELECT sync_seq FROM sessions WHERE session_id = ?))
     ON CONFLICT(session_id, target) DO UPDATE SET
       confirmed = 1,
       sync_seq = MAX(target_session_sync.sync_seq,
                      (SELECT sync_seq FROM sessions WHERE session_id = excluded.session_id))`,
  );
  for (const sessionId of sessionIds) {
    upsert.run(sessionId, targetName, sessionId);
  }
}

function getPendingSessions(targetName: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT session_id, sync_seq, synced_seq,
              wm_messages, wm_tool_calls, wm_scanner_turns,
              wm_scanner_events, wm_hook_events, wm_otel_logs,
              wm_otel_metrics, wm_otel_spans
       FROM target_session_sync
       WHERE target = ? AND confirmed = 1
         AND sync_seq > synced_seq
       ORDER BY rowid`,
    )
    .all(targetName) as Array<Record<string, number> & { session_id: string }>;
}

/**
 * Mirrors the Phase 1 queries in syncSessions (loop.ts). Two independent
 * LIMITs so neither branch can starve the other. **Keep in sync with the
 * production queries in src/sync/loop.ts.**
 */
function getSessionsNeedingSync(
  targetName: string,
  limit = 100,
  requireRepo = false,
) {
  const db = getDb();
  const repoExists = requireRepo
    ? "AND EXISTS (SELECT 1 FROM session_repositories sr WHERE sr.session_id = s.session_id)"
    : "";
  const newRows = db
    .prepare(
      `SELECT s.session_id FROM sessions s
       LEFT JOIN target_session_sync tss
         ON s.session_id = tss.session_id AND tss.target = ?
       WHERE tss.session_id IS NULL ${repoExists}
       LIMIT ?`,
    )
    .all(targetName, limit) as Array<{ session_id: string }>;
  const updatedRows = db
    .prepare(
      `SELECT s.session_id FROM sessions s
       JOIN target_session_sync tss
         ON s.session_id = tss.session_id AND tss.target = ?
       WHERE tss.confirmed = 1 AND s.sync_seq > tss.sync_seq ${repoExists}
       LIMIT ?`,
    )
    .all(targetName, limit) as Array<{ session_id: string }>;
  return [...newRows, ...updatedRows];
}

function markSynced(
  sessionId: string,
  target: string,
  syncSeq: number,
  watermarks: Record<string, number>,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE target_session_sync
     SET wm_messages = ?, wm_tool_calls = ?, wm_scanner_turns = ?,
         wm_scanner_events = ?, wm_hook_events = ?, wm_otel_logs = ?,
         wm_otel_metrics = ?, wm_otel_spans = ?, synced_seq = ?
     WHERE session_id = ? AND target = ?`,
  ).run(
    watermarks.messages ?? 0,
    watermarks.tool_calls ?? 0,
    watermarks.scanner_turns ?? 0,
    watermarks.scanner_events ?? 0,
    watermarks.hook_events ?? 0,
    watermarks.otel_logs ?? 0,
    watermarks.otel_metrics ?? 0,
    watermarks.otel_spans ?? 0,
    syncSeq,
    sessionId,
    target,
  );
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(() => {
  fs.mkdirSync(path.join(os.tmpdir(), "panopticon-test-sync-loop"), {
    recursive: true,
  });
  getDb();
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM target_session_sync").run();
  db.prepare("DELETE FROM code_provenance").run();
  db.prepare("DELETE FROM intent_edits").run();
  db.prepare("DELETE FROM intent_units").run();
  db.prepare("DELETE FROM intent_session_summaries").run();
  db.prepare("DELETE FROM session_summary_search_index").run();
  db.prepare("DELETE FROM session_summary_enrichments").run();
  db.prepare("DELETE FROM session_summaries").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM session_cwds").run();
  db.prepare("DELETE FROM session_repositories").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM watermarks").run();
});

afterAll(() => {
  closeDb();
  fs.rmSync(path.join(os.tmpdir(), "panopticon-test-sync-loop"), {
    recursive: true,
    force: true,
  });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("target_session_sync", () => {
  describe("recordConfirmedSessions", () => {
    it("inserts confirmed row with sync_seq from sessions table", () => {
      insertSession("sess-1", 3);
      recordConfirmed(["sess-1"], "target-a");

      const row = getTargetSync("sess-1", "target-a");
      expect(row).toBeDefined();
      expect(row!.confirmed).toBe(1);
      expect(row!.sync_seq).toBe(3);
      expect(row!.synced_seq).toBe(0);
      expect(row!.wm_messages).toBe(0);
    });

    it("re-confirming updates sync_seq to latest", () => {
      insertSession("sess-1", 3);
      recordConfirmed(["sess-1"], "target-a");

      // Bump sync_seq on the session
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 7 WHERE session_id = ?").run(
        "sess-1",
      );
      recordConfirmed(["sess-1"], "target-a");

      const row = getTargetSync("sess-1", "target-a");
      expect(row!.sync_seq).toBe(7);
      // watermarks should NOT be reset
      expect(row!.synced_seq).toBe(0);
    });

    it("sync_seq never moves backward (MAX guard)", () => {
      insertSession("sess-1", 10);
      recordConfirmed(["sess-1"], "target-a");
      expect(getTargetSync("sess-1", "target-a")!.sync_seq).toBe(10);

      // Simulate stale confirmation with lower sync_seq
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 5 WHERE session_id = ?").run(
        "sess-1",
      );
      recordConfirmed(["sess-1"], "target-a");

      expect(getTargetSync("sess-1", "target-a")!.sync_seq).toBe(10);
    });

    it("each target gets its own row", () => {
      insertSession("sess-1", 1);
      recordConfirmed(["sess-1"], "target-a");
      recordConfirmed(["sess-1"], "target-b");

      const a = getTargetSync("sess-1", "target-a");
      const b = getTargetSync("sess-1", "target-b");
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a!.target).toBe("target-a");
      expect(b!.target).toBe("target-b");
    });
  });

  describe("pending session queries", () => {
    it("returns sessions where sync_seq > synced_seq", () => {
      insertSession("sess-1", 5);
      recordConfirmed(["sess-1"], "target-a");

      const pending = getPendingSessions("target-a");
      expect(pending).toHaveLength(1);
      expect(pending[0].session_id).toBe("sess-1");
      expect(pending[0].sync_seq).toBe(5);
    });

    it("excludes fully synced sessions", () => {
      insertSession("sess-1", 5);
      recordConfirmed(["sess-1"], "target-a");
      markSynced("sess-1", "target-a", 5, {});

      const pending = getPendingSessions("target-a");
      expect(pending).toHaveLength(0);
    });

    it("re-includes session after sync_seq bump", () => {
      insertSession("sess-1", 5);
      recordConfirmed(["sess-1"], "target-a");
      markSynced("sess-1", "target-a", 5, { messages: 10 });

      // Bump sync_seq and re-confirm
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 8 WHERE session_id = ?").run(
        "sess-1",
      );
      recordConfirmed(["sess-1"], "target-a");

      const pending = getPendingSessions("target-a");
      expect(pending).toHaveLength(1);
      expect(pending[0].sync_seq).toBe(8);
      // Watermark should be preserved from previous sync
      expect(pending[0].wm_messages).toBe(10);
    });

    it("targets are independent", () => {
      insertSession("sess-1", 3);
      recordConfirmed(["sess-1"], "target-a");
      recordConfirmed(["sess-1"], "target-b");

      // Sync target-a only
      markSynced("sess-1", "target-a", 3, { messages: 50 });

      expect(getPendingSessions("target-a")).toHaveLength(0);
      expect(getPendingSessions("target-b")).toHaveLength(1);
    });
  });

  describe("watermark advancement", () => {
    it("incremental sync reads only new messages", () => {
      insertSession("sess-1", 1);
      insertMessage("sess-1", 0, "first");
      const id2 = insertMessage("sess-1", 1, "second");

      // Simulate first sync — read all from afterId=0
      const first = readSessionMessages("sess-1", 0, 100);
      expect(first.rows).toHaveLength(2);
      expect(first.maxId).toBe(id2);

      // Add more messages
      const id3 = insertMessage("sess-1", 2, "third");

      // Simulate incremental sync — read from last watermark
      const second = readSessionMessages("sess-1", id2, 100);
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0].ordinal).toBe(2);
      expect(second.rows[0].syncId).toBe(buildMessageSyncId("sess-1", 2));
      expect(second.maxId).toBe(id3);
    });

    it("watermarks persist across mark/query cycles", () => {
      insertSession("sess-1", 1);
      insertMessage("sess-1", 0);
      const id2 = insertMessage("sess-1", 1);

      recordConfirmed(["sess-1"], "target-a");
      markSynced("sess-1", "target-a", 1, { messages: id2 });

      // Bump session, add message, re-confirm
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 2 WHERE session_id = ?").run(
        "sess-1",
      );
      recordConfirmed(["sess-1"], "target-a");
      insertMessage("sess-1", 2);

      const pending = getPendingSessions("target-a");
      expect(pending).toHaveLength(1);
      expect(pending[0].wm_messages).toBe(id2);

      // Reader should only return the new message
      const result = readSessionMessages("sess-1", pending[0].wm_messages, 100);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].ordinal).toBe(2);
      expect(result.rows[0].syncId).toBe(buildMessageSyncId("sess-1", 2));
    });
  });

  describe("orphan cleanup", () => {
    it("removes entries for deleted sessions", () => {
      insertSession("sess-1", 1);
      insertSession("sess-2", 1);
      recordConfirmed(["sess-1", "sess-2"], "target-a");

      // Delete sess-1 from sessions
      const db = getDb();
      db.prepare("DELETE FROM sessions WHERE session_id = ?").run("sess-1");

      // Run orphan cleanup
      db.prepare(
        `DELETE FROM target_session_sync
         WHERE session_id NOT IN (SELECT session_id FROM sessions)`,
      ).run();

      expect(getTargetSync("sess-1", "target-a")).toBeUndefined();
      expect(getTargetSync("sess-2", "target-a")).toBeDefined();
    });
  });

  describe("old table migration", () => {
    it("pending_session_sync table does not exist", () => {
      const db = getDb();
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_session_sync'",
        )
        .all();
      expect(tables).toHaveLength(0);
    });

    it("target_session_sync table exists with correct columns", () => {
      const db = getDb();
      const cols = db
        .prepare("PRAGMA table_info(target_session_sync)")
        .all() as Array<{
        name: string;
      }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("session_id");
      expect(colNames).toContain("target");
      expect(colNames).toContain("confirmed");
      expect(colNames).toContain("sync_seq");
      expect(colNames).toContain("synced_seq");
      expect(colNames).toContain("derived_synced_seq");
      expect(colNames).toContain("wm_messages");
      expect(colNames).toContain("wm_tool_calls");
      expect(colNames).toContain("wm_scanner_turns");
      expect(colNames).toContain("wm_scanner_events");
      expect(colNames).toContain("wm_hook_events");
      expect(colNames).toContain("wm_otel_logs");
      expect(colNames).toContain("wm_otel_metrics");
      expect(colNames).toContain("wm_otel_spans");
    });
  });

  describe("session discovery without watermark", () => {
    it("finds new sessions regardless of sync_seq value", () => {
      // Regression: a session with sync_seq=5000 should not prevent
      // discovering a session with sync_seq=1 (the old watermark bug)
      insertSession("long-running", 5000);
      insertSession("brand-new", 1);

      const needing = getSessionsNeedingSync("target-a");
      const ids = needing.map((r) => r.session_id);
      expect(ids).toContain("long-running");
      expect(ids).toContain("brand-new");
    });

    it("does not return confirmed sessions with unchanged sync_seq", () => {
      insertSession("sess-1", 5);
      recordConfirmed(["sess-1"], "target-a");

      // sess-1 is confirmed and tss.sync_seq matches sessions.sync_seq
      const needing = getSessionsNeedingSync("target-a");
      expect(needing).toHaveLength(0);
    });

    it("returns confirmed sessions when sync_seq advances", () => {
      insertSession("sess-1", 5);
      recordConfirmed(["sess-1"], "target-a");

      // Session gets updated
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 10 WHERE session_id = ?").run(
        "sess-1",
      );

      const needing = getSessionsNeedingSync("target-a");
      expect(needing).toHaveLength(1);
      expect(needing[0].session_id).toBe("sess-1");
    });

    it("readSessionsByIds returns correct records", () => {
      insertSession("sess-1", 3);
      insertSession("sess-2", 7);
      insertSessionSummary("sess-1", "Deterministic summary text.");

      const rows = readSessionsByIds(["sess-1", "sess-2"]);
      expect(rows).toHaveLength(2);

      const ids = rows.map((r) => r.sessionId);
      expect(ids).toContain("sess-1");
      expect(ids).toContain("sess-2");
      expect(rows.find((r) => r.sessionId === "sess-1")?.summary).toBe(
        "Deterministic summary text.",
      );
      expect(rows.find((r) => r.sessionId === "sess-2")?.summary).toBeNull();
    });

    it("readSessionsByIds returns empty for empty input", () => {
      expect(readSessionsByIds([])).toHaveLength(0);
    });

    it("readSessionDerivedState returns stable-key derived bundles", () => {
      insertSession("sess-1", 3);

      const db = getDb();
      db.prepare(
        `INSERT INTO intent_units (
           id, intent_key, session_id, prompt_text, prompt_ts_ms, repository
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        101,
        "intent:sess-1:user:0",
        "sess-1",
        "Implement repo-relative provenance",
        1000,
        "org/repo",
      );
      db.prepare(
        `INSERT INTO intent_edits (
           id, edit_key, intent_unit_id, session_id, timestamp_ms, file_path,
           tool_name, landed, new_string_hash, new_string_snippet
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        201,
        "edit:intent:sess-1:user:0:src/app.ts:0",
        101,
        "sess-1",
        1100,
        "src/app.ts",
        "Edit",
        1,
        "hash-1",
        "const value = 1;",
      );
      db.prepare(
        `INSERT INTO session_summaries (
           id, session_summary_key, session_id, repository, cwd, branch, actor,
           machine, origin_scope, title, status, first_intent_ts_ms,
           last_intent_ts_ms, intent_count, edit_count, landed_edit_count,
           open_edit_count, summary_text, projection_hash, projected_at_ms,
           source_last_seen_at_ms, reason_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        301,
        "ss:local:sess-1",
        "sess-1",
        "org/repo",
        "/tmp/repo",
        "main",
        "gus",
        "test-machine",
        "local",
        "Repo-relative provenance",
        "landed",
        1000,
        1200,
        1,
        1,
        1,
        0,
        "Summary text",
        "projection-hash",
        1300,
        1200,
        "{\"strategy\":\"session_id\"}",
      );
      db.prepare(
        `INSERT INTO session_summary_enrichments (
           session_summary_key, session_id, summary_text, summary_source,
           summary_runner, summary_model, summary_version,
           summary_generated_at_ms, projection_hash, summary_input_hash,
           summary_policy_hash, enriched_input_hash, enriched_message_count,
           dirty, dirty_reason_json, last_material_change_at_ms,
           last_attempted_at_ms, failure_count, last_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "ss:local:sess-1",
        "sess-1",
        "LLM summary",
        "llm",
        "claude",
        "sonnet",
        1,
        1400,
        "projection-hash",
        "summary-input-hash",
        "policy-hash",
        "enriched-input-hash",
        42,
        1,
        "{\"reason\":\"pending\"}",
        1450,
        1460,
        2,
        "timeout",
      );
      db.prepare(
        `INSERT INTO intent_session_summaries (
           intent_unit_id, session_summary_id, membership_kind, source, score, reason_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        101,
        301,
        "primary",
        "session_id",
        1,
        "{\"strategy\":\"session_id\"}",
      );
      db.prepare(
        `INSERT INTO code_provenance (
           repository, file_path, binding_level, start_line, end_line,
           snippet_hash, snippet_preview, language, actor, machine,
           origin_scope, intent_unit_id, intent_edit_id, session_summary_id,
           status, confidence, file_hash, established_at_ms, verified_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "org/repo",
        "src/app.ts",
        "span",
        12,
        18,
        "hash-1",
        "const value = 1;",
        "typescript",
        "gus",
        "test-machine",
        "local",
        101,
        201,
        301,
        "current",
        0.95,
        "file-hash",
        1100,
        1500,
      );

      expect(readSessionDerivedState("sess-1")).toEqual({
        sessionId: "sess-1",
        summaries: [
          {
            sessionSummaryKey: "ss:local:sess-1",
            sessionId: "sess-1",
            repository: "org/repo",
            cwd: "/tmp/repo",
            branch: "main",
            worktree: null,
            actor: "gus",
            machine: "test-machine",
            originScope: "local",
            title: "Repo-relative provenance",
            status: "landed",
            firstIntentTsMs: 1000,
            lastIntentTsMs: 1200,
            intentCount: 1,
            editCount: 1,
            landedEditCount: 1,
            openEditCount: 0,
            summaryText: "Summary text",
            projectionHash: "projection-hash",
            projectedAtMs: 1300,
            sourceLastSeenAtMs: 1200,
            reasonJson: "{\"strategy\":\"session_id\"}",
          },
        ],
        enrichments: [
          {
            sessionSummaryKey: "ss:local:sess-1",
            sessionId: "sess-1",
            summaryText: "LLM summary",
            summarySource: "llm",
            summaryRunner: "claude",
            summaryModel: "sonnet",
            summaryVersion: 1,
            summaryGeneratedAtMs: 1400,
            projectionHash: "projection-hash",
            summaryInputHash: "summary-input-hash",
            summaryPolicyHash: "policy-hash",
            enrichedInputHash: "enriched-input-hash",
            enrichedMessageCount: 42,
            dirty: true,
            dirtyReasonJson: "{\"reason\":\"pending\"}",
            lastMaterialChangeAtMs: 1450,
            lastAttemptedAtMs: 1460,
            failureCount: 2,
            lastError: "timeout",
          },
        ],
        memberships: [
          {
            sessionSummaryKey: "ss:local:sess-1",
            sessionId: "sess-1",
            intentKey: "intent:sess-1:user:0",
            membershipKind: "primary",
            source: "session_id",
            score: 1,
            reasonJson: "{\"strategy\":\"session_id\"}",
          },
        ],
        codeProvenance: [
          {
            sessionSummaryKey: "ss:local:sess-1",
            sessionId: "sess-1",
            repository: "org/repo",
            filePath: "src/app.ts",
            bindingLevel: "span",
            startLine: 12,
            endLine: 18,
            snippetHash: "hash-1",
            snippetPreview: "const value = 1;",
            language: "typescript",
            symbolKind: null,
            symbolName: null,
            actor: "gus",
            machine: "test-machine",
            originScope: "local",
            intentKey: "intent:sess-1:user:0",
            intentEditKey: "edit:intent:sess-1:user:0:src/app.ts:0",
            status: "current",
            confidence: 0.95,
            fileHash: "file-hash",
            establishedAtMs: 1100,
            verifiedAtMs: 1500,
          },
        ],
      });
    });
  });

  describe("no-repo backlog handling", () => {
    it("SQL filter excludes sessions without repo attribution", () => {
      insertSession("with-repo", 1);
      insertSession("no-repo", 1);
      insertSessionRepo("with-repo");

      const ids = getSessionsNeedingSync("target-a", 100, true).map(
        (r) => r.session_id,
      );
      expect(ids).toContain("with-repo");
      expect(ids).not.toContain("no-repo");
    });

    it("a backlog of no-repo sessions does not starve the updated branch", () => {
      // Regression for pmandia's stuck sync: the previous query used
      // UNION ALL with a single LIMIT, so a large prefix of no-repo sessions
      // in the "new" branch would consume every slot and the "updated"
      // branch was never reached. Independent LIMITs + the EXISTS filter
      // fix this.
      const limit = 50;

      // 200 new sessions with no repo attribution (would be filtered out)
      for (let i = 0; i < 200; i++) {
        insertSession(`no-repo-${i}`, 1);
      }

      // One confirmed session with repo whose sync_seq has advanced
      insertSession("stale-confirmed", 100);
      insertSessionRepo("stale-confirmed");
      recordConfirmed(["stale-confirmed"], "target-a");
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 200 WHERE session_id = ?").run(
        "stale-confirmed",
      );

      const ids = getSessionsNeedingSync("target-a", limit, true).map(
        (r) => r.session_id,
      );

      // The updated branch must reach the stale session even with a huge
      // backlog of no-repo new sessions ahead of it.
      expect(ids).toContain("stale-confirmed");
      // None of the no-repo sessions should appear with requireRepo=true.
      expect(ids.filter((id) => id.startsWith("no-repo-"))).toHaveLength(0);
    });

    it("requireRepo=false leaves no-repo sessions in the candidate set", () => {
      insertSession("with-repo", 1);
      insertSession("no-repo", 1);
      insertSessionRepo("with-repo");

      const ids = getSessionsNeedingSync("target-a", 100, false).map(
        (r) => r.session_id,
      );
      expect(ids).toContain("with-repo");
      expect(ids).toContain("no-repo");
    });

    it("new and updated branches each get their own LIMIT slot", () => {
      // With UNION ALL + one LIMIT, a full new branch would crowd out the
      // updated branch. With independent LIMITs each can return up to N rows.
      const limit = 3;

      // 5 new sessions with repo (more than limit)
      for (let i = 0; i < 5; i++) {
        insertSession(`new-${i}`, 1);
        insertSessionRepo(`new-${i}`);
      }

      // 5 updated sessions with repo (more than limit)
      for (let i = 0; i < 5; i++) {
        insertSession(`upd-${i}`, 10);
        insertSessionRepo(`upd-${i}`);
        recordConfirmed([`upd-${i}`], "target-a");
        const db = getDb();
        db.prepare(
          "UPDATE sessions SET sync_seq = 20 WHERE session_id = ?",
        ).run(`upd-${i}`);
      }

      const ids = getSessionsNeedingSync("target-a", limit, true).map(
        (r) => r.session_id,
      );

      // Each branch contributes up to `limit` rows independently → total 6.
      const newCount = ids.filter((id) => id.startsWith("new-")).length;
      const updCount = ids.filter((id) => id.startsWith("upd-")).length;
      expect(newCount).toBe(limit);
      expect(updCount).toBe(limit);
    });

    it("updated session that lost its repo attribution is filtered out", () => {
      // Defensive: if session_repositories was pruned (e.g., by retention)
      // for a session that's already in tss, the EXISTS check should still
      // apply and exclude it from sync.
      insertSession("orphaned", 5);
      recordConfirmed(["orphaned"], "target-a");
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 99 WHERE session_id = ?").run(
        "orphaned",
      );
      // Note: no insertSessionRepo() call → no repo row exists.

      const requireRepo = getSessionsNeedingSync("target-a", 100, true).map(
        (r) => r.session_id,
      );
      const noFilter = getSessionsNeedingSync("target-a", 100, false).map(
        (r) => r.session_id,
      );

      expect(requireRepo).not.toContain("orphaned");
      expect(noFilter).toContain("orphaned");
    });

    it("returns empty when nothing has repo attribution and requireRepo=true", () => {
      // No infinite loop / no false-positive work: with a pile of no-repo
      // sessions and requireRepo=true, the result is just empty.
      for (let i = 0; i < 10; i++) {
        insertSession(`no-repo-${i}`, 1);
      }

      const ids = getSessionsNeedingSync("target-a", 100, true);
      expect(ids).toHaveLength(0);
    });

    it("does not include unconfirmed sessions in the updated branch", () => {
      // Updated branch JOINs on confirmed=1. An unconfirmed tss row should
      // not be picked even if sync_seq advanced.
      insertSession("unconfirmed", 5);
      insertSessionRepo("unconfirmed");
      const db = getDb();
      // Insert tss row with confirmed=0
      db.prepare(
        `INSERT INTO target_session_sync (session_id, target, confirmed, sync_seq, synced_seq)
         VALUES (?, 'target-a', 0, 1, 0)`,
      ).run("unconfirmed");

      const ids = getSessionsNeedingSync("target-a", 100, true).map(
        (r) => r.session_id,
      );

      // It's not in the updated branch (confirmed=0) and not in the new
      // branch (tss row exists), so it must be absent entirely.
      expect(ids).not.toContain("unconfirmed");
    });

    it("a session is reachable when it moves from new → updated", () => {
      // End-to-end shape: a new session gets confirmed, then its sync_seq
      // advances, and the updated branch picks it up — even with a
      // backlog of no-repo new sessions in the way.
      for (let i = 0; i < 100; i++) {
        insertSession(`no-repo-${i}`, 1);
      }
      insertSession("real", 1);
      insertSessionRepo("real");

      // First tick: new branch returns it.
      let ids = getSessionsNeedingSync("target-a", 10, true).map(
        (r) => r.session_id,
      );
      expect(ids).toContain("real");

      // Confirm it (simulates backend ack).
      recordConfirmed(["real"], "target-a");

      // Now nothing pending.
      ids = getSessionsNeedingSync("target-a", 10, true).map(
        (r) => r.session_id,
      );
      expect(ids).not.toContain("real");

      // Bump sync_seq (simulates a new write).
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 5 WHERE session_id = ?").run(
        "real",
      );

      // Updated branch picks it up.
      ids = getSessionsNeedingSync("target-a", 10, true).map(
        (r) => r.session_id,
      );
      expect(ids).toContain("real");
    });
  });
});
