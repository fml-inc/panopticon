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
import { closeDb, getDb } from "../db/schema.js";
import { buildMessageSyncId } from "../db/sync-ids.js";
import { createSyncLoop } from "./loop.js";
import { createTestSyncServerDb, startTestSyncServer } from "./test-server.js";

vi.mock("../config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-sync-loop-collector");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

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

function insertMessage(sessionId: string, ordinal: number): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO messages (session_id, ordinal, role, content, sync_id)
       VALUES (?, ?, 'assistant', ?, ?)`,
    )
    .run(
      sessionId,
      ordinal,
      `msg-${ordinal}`,
      buildMessageSyncId(sessionId, ordinal),
    );
  return Number(result.lastInsertRowid);
}

function getTss(sessionId: string, target: string) {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM target_session_sync WHERE session_id = ? AND target = ?",
    )
    .get(sessionId, target) as Record<string, number | string> | undefined;
}

function getAttemptBackoff(scopeKind: string, scopeKey: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT scope_kind, scope_key, failure_count, last_attempted_at_ms,
              next_attempt_at_ms, last_error, updated_at_ms
       FROM attempt_backoffs
       WHERE scope_kind = ? AND scope_key = ?`,
    )
    .get(scopeKind, scopeKey) as
    | Record<string, number | string | null>
    | undefined;
}

async function readCollectorStats(url: string): Promise<{
  failedSyncRequests: number;
  requestsByTable: Array<{ count: number; table: string }>;
  sessions: number;
  syncRequests: number;
  tables: Array<{ cnt: number; tbl: string }>;
}> {
  const response = await fetch(`${url}/stats`);
  return (await response.json()) as {
    failedSyncRequests: number;
    requestsByTable: Array<{ count: number; table: string }>;
    sessions: number;
    syncRequests: number;
    tables: Array<{ cnt: number; tbl: string }>;
  };
}

const QUIET_LOGGER = {
  error: () => {},
  log: () => {},
};

beforeAll(() => {
  fs.mkdirSync(path.join(os.tmpdir(), "panopticon-test-sync-loop-collector"), {
    recursive: true,
  });
  getDb();
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM target_session_sync").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM session_repositories").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM tool_calls").run();
  db.prepare("DELETE FROM hook_events").run();
  db.prepare("DELETE FROM otel_logs").run();
  db.prepare("DELETE FROM otel_metrics").run();
  db.prepare("DELETE FROM otel_spans").run();
  db.prepare("DELETE FROM watermarks").run();
  db.prepare("DELETE FROM attempt_backoffs").run();
});

afterAll(() => {
  closeDb();
  fs.rmSync(path.join(os.tmpdir(), "panopticon-test-sync-loop-collector"), {
    recursive: true,
    force: true,
  });
});

describe("createSyncLoop against the synthetic collector", () => {
  it("backs off a failing collector and catches up once the collector recovers", async () => {
    insertSession("recover-me", 1);
    insertSessionRepo("recover-me");
    insertMessage("recover-me", 0);
    const lastMessageId = insertMessage("recover-me", 1);

    const receiverDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pano-test-sync-collector-"),
    );
    const receiverDb = createTestSyncServerDb("collector", {
      dir: receiverDir,
      log: QUIET_LOGGER,
    });
    const receiver = await startTestSyncServer({
      db: receiverDb.db,
      failureRules: [
        {
          table: "sessions",
          remaining: 1,
          status: 400,
          body: { error: "synthetic collector failure" },
        },
      ],
      log: QUIET_LOGGER,
      name: "collector",
    });

    try {
      const handle = createSyncLoop({
        targets: [{ name: "collector", url: receiver.url, token: "test" }],
        nonSessionTables: [],
        postBatchSize: 1,
        sessionTables: ["messages"],
      });

      await handle.runOnce();

      expect(receiver.state.syncRequests).toBe(1);
      expect(receiver.state.requestsByTable.get("sessions")).toBe(1);
      expect(getTss("recover-me", "collector")).toBeUndefined();
      expect(getAttemptBackoff("sync-target", "collector")).toMatchObject({
        failure_count: 1,
      });
      expect(
        String(getAttemptBackoff("sync-target", "collector")?.last_error ?? ""),
      ).toContain("HTTP 400");

      const failedStats = await readCollectorStats(receiver.url);
      expect(failedStats).toMatchObject({
        failedSyncRequests: 1,
        sessions: 0,
        syncRequests: 1,
      });

      await handle.runOnce();
      expect(receiver.state.syncRequests).toBe(1);

      getDb()
        .prepare(
          `UPDATE attempt_backoffs
           SET next_attempt_at_ms = 0
           WHERE scope_kind = ? AND scope_key = ?`,
        )
        .run("sync-target", "collector");

      await handle.runOnce();

      expect(receiver.state.syncRequests).toBe(4);
      expect(receiver.state.requestsByTable.get("sessions")).toBe(2);
      expect(receiver.state.requestsByTable.get("messages")).toBe(2);

      const recoveredStats = await readCollectorStats(receiver.url);
      expect(recoveredStats).toMatchObject({
        failedSyncRequests: 1,
        sessions: 1,
        syncRequests: 4,
      });
      expect(recoveredStats.tables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tbl: "messages", cnt: 2 }),
        ]),
      );
      expect(getTss("recover-me", "collector")).toMatchObject({
        sync_seq: 1,
        synced_seq: 1,
        wm_messages: lastMessageId,
      });
      expect(getAttemptBackoff("sync-target", "collector")).toBeUndefined();
    } finally {
      await receiver.close();
      receiverDb.db.close();
      fs.rmSync(receiverDir, { recursive: true, force: true });
    }
  });
});
