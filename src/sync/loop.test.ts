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
import { readSessionMessages } from "./reader.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function insertSession(sessionId: string, syncSeq: number): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO sessions (session_id, sync_seq, machine, relationship_type)
     VALUES (?, ?, 'test-machine', 'standalone')`,
  ).run(sessionId, syncSeq);
}

function insertMessage(
  sessionId: string,
  ordinal: number,
  content = `msg-${ordinal}`,
): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO messages (session_id, ordinal, role, content)
       VALUES (?, ?, 'assistant', ?)`,
    )
    .run(sessionId, ordinal, content);
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
  db.prepare("DELETE FROM sessions").run();
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
});
