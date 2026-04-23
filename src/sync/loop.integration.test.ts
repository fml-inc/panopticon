import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ── Mock config so getDb() uses a temp file ──────────────────────────────────
vi.mock("../config.js", () => {
  const tmpDir = path.join(
    os.tmpdir(),
    "panopticon-test-sync-loop-integration",
  );
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

// ── Mock postSync so we can intercept HTTP and decide what the backend "accepts" ──
vi.mock("./post.js", () => ({
  postSync: vi.fn(),
}));

import { closeDb, getDb } from "../db/schema.js";
import { buildMessageSyncId, buildToolCallSyncId } from "../db/sync-ids.js";
import { createSyncLoop } from "./loop.js";
import { postSync } from "./post.js";
import type { SyncTarget } from "./types.js";

const mockedPostSync = vi.mocked(postSync);

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

function insertToolCall(
  sessionId: string,
  messageId: number,
  callIndex: number,
  toolName: string,
  toolUseId?: string | null,
): number {
  const db = getDb();
  const message = db
    .prepare("SELECT sync_id FROM messages WHERE id = ?")
    .get(messageId) as { sync_id: string };
  const result = db
    .prepare(
      `INSERT INTO tool_calls
         (message_id, session_id, call_index, tool_name, category, tool_use_id, sync_id)
       VALUES (?, ?, ?, ?, 'file', ?, ?)`,
    )
    .run(
      messageId,
      sessionId,
      callIndex,
      toolName,
      toolUseId ?? null,
      buildToolCallSyncId(message.sync_id, callIndex, toolUseId),
    );
  return Number(result.lastInsertRowid);
}

function insertHookEvent(sessionId: string): number {
  const db = getDb();
  // payload is stored as gzipped JSON; the reader decompresses it.
  const payload = zlib.gzipSync(Buffer.from("{}"));
  const result = db
    .prepare(
      `INSERT INTO hook_events (session_id, event_type, timestamp_ms, cwd, payload)
       VALUES (?, 'PreToolUse', 0, '/tmp', ?)`,
    )
    .run(sessionId, payload);
  return Number(result.lastInsertRowid);
}

function insertOtelLog(sessionId: string, index: number): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO otel_logs
         (session_id, timestamp_ns, body, attributes, resource_attributes)
       VALUES (?, ?, ?, '{}', '{}')`,
    )
    .run(sessionId, index + 1, `otel-${index}`);
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

function insertTargetSessionSync(
  sessionId: string,
  target: string,
  {
    confirmed = 1,
    syncSeq,
    syncedSeq = 0,
    wmMessages = 0,
    wmToolCalls = 0,
    wmScannerTurns = 0,
    wmScannerEvents = 0,
    wmHookEvents = 0,
    wmOtelLogs = 0,
    wmOtelMetrics = 0,
    wmOtelSpans = 0,
  }: {
    confirmed?: number;
    syncSeq: number;
    syncedSeq?: number;
    wmMessages?: number;
    wmToolCalls?: number;
    wmScannerTurns?: number;
    wmScannerEvents?: number;
    wmHookEvents?: number;
    wmOtelLogs?: number;
    wmOtelMetrics?: number;
    wmOtelSpans?: number;
  },
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO target_session_sync (
       session_id, target, confirmed, sync_seq, synced_seq,
       wm_messages, wm_tool_calls, wm_scanner_turns, wm_scanner_events,
       wm_hook_events, wm_otel_logs, wm_otel_metrics, wm_otel_spans
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    target,
    confirmed,
    syncSeq,
    syncedSeq,
    wmMessages,
    wmToolCalls,
    wmScannerTurns,
    wmScannerEvents,
    wmHookEvents,
    wmOtelLogs,
    wmOtelMetrics,
    wmOtelSpans,
  );
}

/**
 * Default mock behavior: backend "accepts" every session it receives. Tables
 * other than `sessions` are silently acked with `{}`.
 */
function ackEverything(): void {
  mockedPostSync.mockImplementation(async (_url, body) => {
    if (body.table === "sessions") {
      const ids = body.rows.map((r) => {
        const row = r as { sessionId?: string; session_id?: string };
        return row.sessionId ?? row.session_id ?? "";
      });
      return { accepted: ids };
    }
    return {};
  });
}

function makeTarget(name = "fml"): SyncTarget {
  return { name, url: "https://example.test", token: "test" };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(() => {
  fs.mkdirSync(
    path.join(os.tmpdir(), "panopticon-test-sync-loop-integration"),
    { recursive: true },
  );
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
  mockedPostSync.mockReset();
  ackEverything();
  vi.useRealTimers();
});

afterAll(() => {
  closeDb();
  fs.rmSync(path.join(os.tmpdir(), "panopticon-test-sync-loop-integration"), {
    recursive: true,
    force: true,
  });
});

// ── Helpers for inspecting mock calls ────────────────────────────────────────

function postedSessionIds(): string[] {
  return mockedPostSync.mock.calls
    .filter(([, body]) => body.table === "sessions")
    .flatMap(([, body]) =>
      body.rows.map((r) => {
        const row = r as { sessionId?: string };
        return row.sessionId ?? "";
      }),
    );
}

function postedTablesFor(sessionId: string): string[] {
  return mockedPostSync.mock.calls
    .filter(([, body]) => {
      if (body.table === "sessions") return false;
      return body.rows.some((r) => {
        const row = r as { sessionId?: string };
        return row.sessionId === sessionId;
      });
    })
    .map(([, body]) => body.table);
}

async function waitForPostedTable(table: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (mockedPostSync.mock.calls.some(([, body]) => body.table === table)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${table} post`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createSyncLoop integration", () => {
  describe("Phase 1: session discovery", () => {
    it("posts new sessions with repo and records them as confirmed", async () => {
      insertSession("with-repo", 1);
      insertSessionRepo("with-repo");
      insertSession("no-repo", 1);

      const handle = createSyncLoop({ targets: [makeTarget()] });
      await handle.runOnce();

      expect(postedSessionIds()).toEqual(["with-repo"]);
      expect(getTss("with-repo", "fml")).toBeDefined();
      expect(getTss("no-repo", "fml")).toBeUndefined();
    });

    it("a backlog of no-repo sessions does not block reaching updated sessions", async () => {
      // pmandia's exact regression: 200 no-repo new sessions piled up,
      // plus one confirmed session whose sync_seq has advanced. The updated
      // branch must still be reached on the very next runOnce().
      for (let i = 0; i < 200; i++) {
        insertSession(`no-repo-${i}`, 1);
      }

      insertSession("stale", 1);
      insertSessionRepo("stale");

      // First tick: get "stale" into tss as confirmed.
      const handle = createSyncLoop({
        targets: [makeTarget()],
        batchSize: 50,
      });
      await handle.runOnce();
      expect(getTss("stale", "fml")?.sync_seq).toBe(1);

      // Now bump sync_seq, simulating a scanner write to the session.
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 99 WHERE session_id = ?").run(
        "stale",
      );

      mockedPostSync.mockClear();
      await handle.runOnce();

      // The "updated" branch must reach this session even though there's a
      // huge backlog of no-repo new sessions ahead of it.
      expect(postedSessionIds()).toContain("stale");
      expect(getTss("stale", "fml")?.sync_seq).toBe(99);

      // No no-repo session was ever posted.
      expect(postedSessionIds().some((id) => id.startsWith("no-repo-"))).toBe(
        false,
      );
    });

    it("respects requireRepo=false and posts no-repo sessions", async () => {
      insertSession("no-repo", 1);

      const handle = createSyncLoop({
        targets: [makeTarget()],
        filter: { requireRepo: false },
      });
      await handle.runOnce();

      expect(postedSessionIds()).toContain("no-repo");
      expect(getTss("no-repo", "fml")).toBeDefined();
    });

    it("excludeRepos filter is enforced via syncableSessionIds", async () => {
      insertSession("included", 1);
      insertSessionRepo("included", "org/keep");
      insertSession("excluded", 1);
      insertSessionRepo("excluded", "org/private");

      const handle = createSyncLoop({
        targets: [makeTarget()],
        filter: { excludeRepos: ["org/private"] },
      });
      await handle.runOnce();

      expect(postedSessionIds()).toContain("included");
      expect(postedSessionIds()).not.toContain("excluded");
    });

    it("hasMore is true when either branch hits its batchSize", async () => {
      // 5 new sessions with repo, batchSize=3 → new branch full → hasMore.
      for (let i = 0; i < 5; i++) {
        insertSession(`s-${i}`, 1);
        insertSessionRepo(`s-${i}`);
      }

      const handle = createSyncLoop({
        targets: [makeTarget()],
        batchSize: 3,
      });
      const hasMore = await handle.runOnce();
      expect(hasMore).toBe(true);
    });

    it("backend rejection (session not in `accepted`) leaves tss unset for retry", async () => {
      insertSession("good", 1);
      insertSessionRepo("good");
      insertSession("bad", 1);
      insertSessionRepo("bad");

      // Backend rejects "bad" by omitting it from accepted.
      mockedPostSync.mockImplementation(async (_url, body) => {
        if (body.table === "sessions") {
          const ids = body.rows
            .map((r) => (r as { sessionId: string }).sessionId)
            .filter((id) => id !== "bad");
          return { accepted: ids };
        }
        return {};
      });

      const handle = createSyncLoop({ targets: [makeTarget()] });
      await handle.runOnce();

      expect(getTss("good", "fml")).toBeDefined();
      expect(getTss("bad", "fml")).toBeUndefined();
    });

    it("backs off target retries after a sync failure instead of hammering every run", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      insertSession("blocked", 1);
      insertSessionRepo("blocked");

      mockedPostSync.mockRejectedValue(new Error("HTTP 503"));

      const handle = createSyncLoop({ targets: [makeTarget()] });
      await handle.runOnce();

      expect(mockedPostSync).toHaveBeenCalledTimes(1);
      expect(getAttemptBackoff("sync-target", "fml")).toMatchObject({
        failure_count: 1,
        last_error: "HTTP 503",
        next_attempt_at_ms: 60_000,
      });

      mockedPostSync.mockClear();
      await handle.runOnce();
      expect(mockedPostSync).not.toHaveBeenCalled();

      vi.setSystemTime(new Date(60_000));
      await handle.runOnce();
      expect(mockedPostSync).toHaveBeenCalledTimes(1);
      expect(getAttemptBackoff("sync-target", "fml")).toMatchObject({
        failure_count: 2,
        next_attempt_at_ms: 180_000,
      });
    });
  });

  describe("Phase 2: per-session data sync", () => {
    it("drains per-table data for confirmed sessions and advances watermarks", async () => {
      insertSession("s1", 1);
      insertSessionRepo("s1");
      insertMessage("s1", 0);
      const m2 = insertMessage("s1", 1);
      const h1 = insertHookEvent("s1");

      const handle = createSyncLoop({ targets: [makeTarget()] });
      await handle.runOnce();

      // Phase 1 confirmed it; Phase 2 drained messages + hook_events.
      const tables = postedTablesFor("s1");
      expect(tables).toContain("messages");
      expect(tables).toContain("hook_events");

      const tss = getTss("s1", "fml");
      expect(tss).toBeDefined();
      expect(tss!.wm_messages).toBe(m2);
      expect(tss!.wm_hook_events).toBe(h1);
      expect(tss!.synced_seq).toBe(tss!.sync_seq);
    });

    it("posts tool calls with messageSyncId, callIndex, and deterministic syncId", async () => {
      insertSession("s1", 1);
      insertSessionRepo("s1");
      const messageId = insertMessage("s1", 0);
      const toolCallId = insertToolCall("s1", messageId, 0, "Write", null);

      const handle = createSyncLoop({ targets: [makeTarget()] });
      await handle.runOnce();

      const toolCallCalls = mockedPostSync.mock.calls.filter(
        ([, body]) => body.table === "tool_calls",
      );
      expect(toolCallCalls).toHaveLength(1);

      const rows = toolCallCalls.flatMap(
        ([, body]) =>
          body.rows as Array<{
            id: number;
            messageId: number;
            messageSyncId: string | null;
            callIndex: number;
            syncId: string | null;
            toolName: string;
            sessionId: string;
          }>,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: toolCallId,
        messageId,
        messageSyncId: buildMessageSyncId("s1", 0),
        sessionId: "s1",
        toolName: "Write",
        callIndex: 0,
        syncId: buildToolCallSyncId(buildMessageSyncId("s1", 0), 0, null),
      });
      expect(getTss("s1", "fml")?.wm_tool_calls).toBe(toolCallId);
    });

    it("incremental sync only posts rows past the per-table watermark", async () => {
      insertSession("s1", 1);
      insertSessionRepo("s1");
      insertMessage("s1", 0);
      const m2 = insertMessage("s1", 1);

      const handle = createSyncLoop({ targets: [makeTarget()] });
      await handle.runOnce();

      // Confirm watermark advanced to m2.
      expect(getTss("s1", "fml")?.wm_messages).toBe(m2);

      // Add new message, bump sync_seq, run again.
      const m3 = insertMessage("s1", 2);
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 5 WHERE session_id = ?").run(
        "s1",
      );

      mockedPostSync.mockClear();
      await handle.runOnce();

      // Phase 2 should have posted only the one new message.
      const messageCalls = mockedPostSync.mock.calls.filter(
        ([, body]) => body.table === "messages",
      );
      const allPostedMessageIds = messageCalls.flatMap(([, body]) =>
        body.rows.map((r) => (r as { id: number }).id),
      );
      expect(allPostedMessageIds).toEqual([m3]);
      const allPostedMessageSyncIds = messageCalls.flatMap(([, body]) =>
        body.rows.map((r) => (r as { syncId: string | null }).syncId),
      );
      expect(allPostedMessageSyncIds).toEqual([buildMessageSyncId("s1", 2)]);
      expect(getTss("s1", "fml")?.wm_messages).toBe(m3);
    });

    it("revives stuck per-table watermarks on the next runOnce after the fix", async () => {
      // Simulate the pmandia state for a single session: tss is confirmed
      // with a stale sync_seq, per-table watermarks lag, and there's a huge
      // backlog of unrelated no-repo sessions. After one runOnce, Phase 1
      // bumps tss.sync_seq, Phase 2 drains the pending data.
      for (let i = 0; i < 50; i++) {
        insertSession(`no-repo-${i}`, 1);
      }

      insertSession("stuck", 1);
      insertSessionRepo("stuck");
      insertHookEvent("stuck");

      // Initial sync to land it in tss.
      const handle = createSyncLoop({
        targets: [makeTarget()],
        batchSize: 25,
      });
      await handle.runOnce();
      expect(getTss("stuck", "fml")?.wm_hook_events).toBeGreaterThan(0);

      // Now scanner writes a pile of messages and bumps sync_seq.
      for (let i = 0; i < 5; i++) insertMessage("stuck", i);
      const db = getDb();
      db.prepare("UPDATE sessions SET sync_seq = 100 WHERE session_id = ?").run(
        "stuck",
      );

      mockedPostSync.mockClear();
      await handle.runOnce();

      // Phase 1 reached the updated branch despite the backlog.
      expect(postedSessionIds()).toContain("stuck");
      // Phase 2 drained messages to the latest id.
      expect(getTss("stuck", "fml")?.wm_messages).toBeGreaterThan(0);
      expect(getTss("stuck", "fml")?.synced_seq).toBe(100);
    });

    it("replays scanner data after a reparse-style watermark rewind", async () => {
      insertSession("reparsed", 5);
      insertSessionRepo("reparsed");
      const messageId = insertMessage("reparsed", 0);

      const db = getDb();
      db.prepare(
        `INSERT INTO target_session_sync (
           session_id, target, confirmed, sync_seq, synced_seq,
           wm_messages, wm_tool_calls, wm_scanner_turns, wm_scanner_events,
           wm_hook_events, wm_otel_logs, wm_otel_metrics, wm_otel_spans
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("reparsed", "fml", 4, 4, 0, 0, 0, 0, 12, 13, 14, 15);

      const handle = createSyncLoop({ targets: [makeTarget()] });
      await handle.runOnce();

      expect(postedSessionIds()).toContain("reparsed");

      const messageCalls = mockedPostSync.mock.calls.filter(
        ([, body]) => body.table === "messages",
      );
      const postedMessageIds = messageCalls.flatMap(([, body]) =>
        body.rows.map((r) => (r as { id: number }).id),
      );
      expect(postedMessageIds).toEqual([messageId]);

      const tss = getTss("reparsed", "fml");
      expect(tss).toMatchObject({
        sync_seq: 5,
        synced_seq: 5,
        wm_messages: messageId,
        wm_hook_events: 12,
        wm_otel_logs: 13,
        wm_otel_metrics: 14,
        wm_otel_spans: 15,
      });
    });

    it("advances large session backlogs across ticks without marking synced_seq early", async () => {
      insertSession("s1", 1);
      insertSessionRepo("s1");
      const messageIds = Array.from({ length: 5 }, (_, i) =>
        insertMessage("s1", i),
      );

      const handle = createSyncLoop({
        targets: [makeTarget()],
        sessionTables: ["messages"],
        nonSessionTables: [],
        batchSize: 2,
        sessionRowBudget: 2,
      });

      await handle.runOnce();
      expect(getTss("s1", "fml")).toMatchObject({
        wm_messages: messageIds[1],
        synced_seq: 0,
        sync_seq: 1,
      });

      mockedPostSync.mockClear();
      await handle.runOnce();
      const secondTickIds = mockedPostSync.mock.calls
        .filter(([, body]) => body.table === "messages")
        .flatMap(([, body]) => body.rows.map((r) => (r as { id: number }).id));
      expect(secondTickIds).toEqual([messageIds[2], messageIds[3]]);
      expect(getTss("s1", "fml")).toMatchObject({
        wm_messages: messageIds[3],
        synced_seq: 0,
      });

      mockedPostSync.mockClear();
      await handle.runOnce();
      const thirdTickIds = mockedPostSync.mock.calls
        .filter(([, body]) => body.table === "messages")
        .flatMap(([, body]) => body.rows.map((r) => (r as { id: number }).id));
      expect(thirdTickIds).toEqual([messageIds[4]]);
      expect(getTss("s1", "fml")).toMatchObject({
        wm_messages: messageIds[4],
        synced_seq: 1,
      });
    });

    it("moves otel backlog onto a separate loop with independent watermarks", async () => {
      insertSession("s1", 1);
      insertSessionRepo("s1");
      const messageId = insertMessage("s1", 0);
      const otelIds = Array.from({ length: 5 }, (_, i) =>
        insertOtelLog("s1", i),
      );

      const coreHandle = createSyncLoop({
        targets: [makeTarget()],
        sessionTables: ["messages"],
        nonSessionTables: [],
      });
      await coreHandle.runOnce();

      expect(getTss("s1", "fml")).toMatchObject({
        wm_messages: messageId,
        wm_otel_logs: 0,
        synced_seq: 1,
      });

      mockedPostSync.mockClear();
      const otelHandle = createSyncLoop({
        targets: [makeTarget()],
        syncSessions: false,
        sessionTables: ["otel_logs"],
        nonSessionTables: [],
        sessionPendingMode: "watermark-gap",
        batchSize: 2,
        sessionRowBudget: 2,
      });

      await otelHandle.runOnce();

      const firstOtelIds = mockedPostSync.mock.calls
        .filter(([, body]) => body.table === "otel_logs")
        .flatMap(([, body]) => body.rows.map((r) => (r as { id: number }).id));
      expect(firstOtelIds).toEqual([otelIds[0], otelIds[1]]);
      expect(getTss("s1", "fml")).toMatchObject({
        wm_messages: messageId,
        wm_otel_logs: otelIds[1],
        synced_seq: 1,
      });

      mockedPostSync.mockClear();
      await otelHandle.runOnce();
      const secondOtelIds = mockedPostSync.mock.calls
        .filter(([, body]) => body.table === "otel_logs")
        .flatMap(([, body]) => body.rows.map((r) => (r as { id: number }).id));
      expect(secondOtelIds).toEqual([otelIds[2], otelIds[3]]);
      expect(getTss("s1", "fml")).toMatchObject({
        wm_otel_logs: otelIds[3],
        synced_seq: 1,
      });
    });

    it("does not let the otel loop clobber core watermarks or synced_seq", async () => {
      insertSession("s1", 2);
      insertSessionRepo("s1");
      const messageId = insertMessage("s1", 0);
      const otelId = insertOtelLog("s1", 0);
      insertTargetSessionSync("s1", "fml", {
        syncSeq: 2,
        syncedSeq: 1,
      });

      let releaseOtelPost: (() => void) | undefined;
      const otelPostBlocked = new Promise<void>((resolve) => {
        releaseOtelPost = resolve;
      });
      mockedPostSync.mockImplementation(async (_url, body) => {
        if (body.table === "otel_logs") {
          await otelPostBlocked;
          return {};
        }
        return {};
      });

      const otelHandle = createSyncLoop({
        targets: [makeTarget()],
        syncSessions: false,
        sessionTables: ["otel_logs"],
        nonSessionTables: [],
        sessionPendingMode: "watermark-gap",
      });
      const coreHandle = createSyncLoop({
        targets: [makeTarget()],
        syncSessions: false,
        sessionTables: ["messages"],
        nonSessionTables: [],
      });

      const otelRun = otelHandle.runOnce();
      await waitForPostedTable("otel_logs");

      await coreHandle.runOnce();
      releaseOtelPost?.();
      await otelRun;

      expect(getTss("s1", "fml")).toMatchObject({
        wm_messages: messageId,
        wm_otel_logs: otelId,
        synced_seq: 2,
      });
    });

    it("round-robins pending sessions across ticks when per-session budget is exhausted", async () => {
      const messageIdsBySession = new Map<string, number[]>();
      for (const sessionId of ["s1", "s2", "s3", "s4"]) {
        insertSession(sessionId, 1);
        insertSessionRepo(sessionId);
        messageIdsBySession.set(sessionId, [
          insertMessage(sessionId, 0),
          insertMessage(sessionId, 1),
          insertMessage(sessionId, 2),
        ]);
        insertTargetSessionSync(sessionId, "fml", {
          syncSeq: 1,
          syncedSeq: 0,
        });
      }

      const handle = createSyncLoop({
        targets: [makeTarget()],
        syncSessions: false,
        sessionTables: ["messages"],
        nonSessionTables: [],
        batchSize: 2,
        sessionRowBudget: 2,
        maxSessionsPerTick: 2,
      });

      await handle.runOnce();
      mockedPostSync.mockClear();

      await handle.runOnce();

      const secondTickSessionIds = [
        ...new Set(
          mockedPostSync.mock.calls
            .filter(([, body]) => body.table === "messages")
            .flatMap(([, body]) =>
              body.rows.map((row) => (row as { sessionId: string }).sessionId),
            ),
        ),
      ];
      expect(secondTickSessionIds).toEqual(["s3", "s4"]);
      expect(getTss("s1", "fml")).toMatchObject({
        wm_messages: messageIdsBySession.get("s1")?.[1],
        synced_seq: 0,
      });
      expect(getTss("s3", "fml")).toMatchObject({
        wm_messages: messageIdsBySession.get("s3")?.[1],
        synced_seq: 0,
      });
    });
  });

  describe("multi-target", () => {
    it("targets are tracked independently", async () => {
      insertSession("s1", 1);
      insertSessionRepo("s1");

      const handle = createSyncLoop({
        targets: [makeTarget("a"), makeTarget("b")],
      });
      await handle.runOnce();

      expect(getTss("s1", "a")).toBeDefined();
      expect(getTss("s1", "b")).toBeDefined();
    });

    it("a thrown error on one target does not block the other", async () => {
      insertSession("s1", 1);
      insertSessionRepo("s1");

      // Fail target "a", succeed for target "b".
      mockedPostSync.mockImplementation(async (url, body) => {
        if (url.startsWith("https://a.test")) {
          throw new Error("simulated network error");
        }
        if (body.table === "sessions") {
          return {
            accepted: body.rows.map(
              (r) => (r as { sessionId: string }).sessionId,
            ),
          };
        }
        return {};
      });

      const handle = createSyncLoop({
        targets: [
          { name: "a", url: "https://a.test", token: "x" },
          { name: "b", url: "https://b.test", token: "x" },
        ],
      });
      await handle.runOnce();

      expect(getTss("s1", "a")).toBeUndefined();
      expect(getTss("s1", "b")).toBeDefined();
    });
  });
});
