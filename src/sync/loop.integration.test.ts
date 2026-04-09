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
      `INSERT INTO messages (session_id, ordinal, role, content)
       VALUES (?, ?, 'assistant', ?)`,
    )
    .run(sessionId, ordinal, `msg-${ordinal}`);
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

function getTss(sessionId: string, target: string) {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM target_session_sync WHERE session_id = ? AND target = ?",
    )
    .get(sessionId, target) as Record<string, number | string> | undefined;
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
  db.prepare("DELETE FROM watermarks").run();
  mockedPostSync.mockReset();
  ackEverything();
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
