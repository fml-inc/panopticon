/**
 * Tests that deterministic sync_id values remain stable for fork sessions
 * across resetFileForReparse + re-insert.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), "pano-fork-sync-test-"));
  return {
    config: {
      dataDir: dir,
      dbPath: _path.join(dir, "panopticon.db"),
      port: 14318,
      host: "127.0.0.1",
      serverPidFile: "",
    },
    ensureDataDir: () => _fs.mkdirSync(dir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { updateSessionMessageCounts } from "../db/store.js";
import { buildScannerEventSyncId } from "../db/sync-ids.js";
import { getTarget } from "../targets/index.js";
import "../targets/claude.js";
import {
  insertMessages,
  insertScannerEvents,
  insertTurns,
  resetFileForReparse,
  updateSessionTotals,
  upsertSession,
  writeFileWatermark,
} from "./store.js";

// ── Fixture: a JSONL file with a DAG fork ──────────────────────────────────
// The tree shape (fork point at a2):
//   u1 -> a1 -> u2 -> a2 -> u3 -> a3 -> u4 -> a4 -> u9 -> a9 -> u10 -> a10  (main, 5 user turns after fork)
//                              \-> u5 -> a5 -> u6 -> a6 -> u7 -> a7 -> u8 -> a8  (fork branch, 4 user turns)
// At fork point a2, first child u3's subtree has 4 user turns (u3,u4,u9,u10) which
// exceeds FORK_THRESHOLD (3), triggering large-gap fork detection.

const SESSION_ID = "fork-test-session";

function makeLine(
  type: "user" | "assistant",
  uuid: string,
  parentUuid: string,
  ts: string,
  extra?: Record<string, unknown>,
): string {
  const base: Record<string, unknown> = {
    type,
    sessionId: SESSION_ID,
    uuid,
    parentUuid: parentUuid || undefined,
    timestamp: ts,
  };
  if (type === "user") {
    base.message = {
      content: [{ type: "text", text: `User message ${uuid}` }],
    };
  } else {
    base.message = {
      model: "claude-opus-4-6",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      stop_reason: "end_turn",
      content: [
        {
          type: "tool_use",
          id: `tool_${uuid}`,
          name: "Bash",
          input: { command: "echo test" },
        },
      ],
    };
  }
  return JSON.stringify({ ...base, ...extra });
}

function buildForkedSessionLines(): string[] {
  // Main path: u1 -> a1 -> u2 -> a2 -> u3 -> a3 -> u4 -> a4
  // Fork from a2: u5 -> a5 -> u6 -> a6 -> u7 -> a7 -> u8 -> a8
  const lines = [
    // Main path (before fork point)
    makeLine("user", "u1", "", "2026-03-26T10:00:00.000Z"),
    makeLine("assistant", "a1", "u1", "2026-03-26T10:00:05.000Z"),
    makeLine("user", "u2", "a1", "2026-03-26T10:00:10.000Z"),
    makeLine("assistant", "a2", "u2", "2026-03-26T10:00:15.000Z"),
    // Main path continues (first child of a2 — needs >3 user turns)
    makeLine("user", "u3", "a2", "2026-03-26T10:00:20.000Z"),
    makeLine("assistant", "a3", "u3", "2026-03-26T10:00:25.000Z"),
    makeLine("user", "u4", "a3", "2026-03-26T10:00:30.000Z"),
    makeLine("assistant", "a4", "u4", "2026-03-26T10:00:35.000Z"),
    makeLine("user", "u9", "a4", "2026-03-26T10:00:40.000Z"),
    makeLine("assistant", "a9", "u9", "2026-03-26T10:00:45.000Z"),
    makeLine("user", "u10", "a9", "2026-03-26T10:00:50.000Z"),
    makeLine("assistant", "a10", "u10", "2026-03-26T10:00:55.000Z"),
    // Fork branch (second child of a2)
    makeLine("user", "u5", "a2", "2026-03-26T10:01:00.000Z"),
    makeLine("assistant", "a5", "u5", "2026-03-26T10:01:05.000Z"),
    makeLine("user", "u6", "a5", "2026-03-26T10:01:10.000Z"),
    makeLine("assistant", "a6", "u6", "2026-03-26T10:01:15.000Z"),
    makeLine("user", "u7", "a6", "2026-03-26T10:01:20.000Z"),
    makeLine("assistant", "a7", "u7", "2026-03-26T10:01:25.000Z"),
    makeLine("user", "u8", "a7", "2026-03-26T10:01:30.000Z"),
    makeLine("assistant", "a8", "u8", "2026-03-26T10:01:35.000Z"),
  ];
  return lines;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getSyncIds(sessionId: string): {
  turns: Map<string, string>;
  toolCalls: Map<string, string>;
  events: Map<string, string>;
} {
  const db = getDb();
  const turns = new Map<string, string>();
  const toolCalls = new Map<string, string>();
  const events = new Map<string, string>();

  const turnRows = db
    .prepare(
      "SELECT session_id, turn_index, sync_id FROM scanner_turns WHERE session_id = ?",
    )
    .all(sessionId) as Array<{
    session_id: string;
    turn_index: number;
    sync_id: string;
  }>;
  for (const r of turnRows) {
    turns.set(`${r.session_id}:${r.turn_index}`, r.sync_id);
  }

  const tcRows = db
    .prepare(
      `SELECT tc.session_id, tc.tool_name, tc.tool_use_id, tc.call_index, tc.sync_id, m.ordinal
       FROM tool_calls tc
       INNER JOIN messages m ON tc.message_id = m.id
       WHERE tc.session_id = ?`,
    )
    .all(sessionId) as Array<{
    session_id: string;
    tool_name: string;
    tool_use_id: string;
    call_index: number;
    sync_id: string;
    ordinal: number;
  }>;
  for (const r of tcRows) {
    toolCalls.set(
      `${r.session_id}:${r.ordinal}:${r.tool_use_id || `idx:${r.call_index}`}:${r.tool_name}`,
      r.sync_id,
    );
  }

  const evRows = db
    .prepare(
      "SELECT session_id, source, event_index, event_type, timestamp_ms, COALESCE(tool_name, '') as tool_name, sync_id FROM scanner_events WHERE session_id = ?",
    )
    .all(sessionId) as Array<{
    session_id: string;
    source: string;
    event_index: number;
    event_type: string;
    timestamp_ms: number;
    tool_name: string;
    sync_id: string;
  }>;
  for (const r of evRows) {
    events.set(
      `${r.session_id}:${r.source}:${r.event_index}:${r.event_type}:${r.timestamp_ms}:${r.tool_name}`,
      r.sync_id,
    );
  }

  return { turns, toolCalls, events };
}

function getAllSyncIds(parentSessionId: string): {
  turns: Map<string, string>;
  toolCalls: Map<string, string>;
  events: Map<string, string>;
} {
  const db = getDb();
  const forkRows = db
    .prepare(
      "SELECT session_id FROM sessions WHERE parent_session_id = ? AND relationship_type = 'fork'",
    )
    .all(parentSessionId) as Array<{ session_id: string }>;
  const allIds = [parentSessionId, ...forkRows.map((r) => r.session_id)];

  const turns = new Map<string, string>();
  const toolCalls = new Map<string, string>();
  const events = new Map<string, string>();

  for (const sid of allIds) {
    const s = getSyncIds(sid);
    for (const [k, v] of s.turns) turns.set(k, v);
    for (const [k, v] of s.toolCalls) toolCalls.set(k, v);
    for (const [k, v] of s.events) events.set(k, v);
  }

  return { turns, toolCalls, events };
}

/** Parse a JSONL file and insert its results (main + forks) into the DB. */
function parseAndInsert(filePath: string): void {
  const claude = getTarget("claude")!;
  const result = claude.scanner!.parseFile(filePath, 0);
  if (!result?.meta?.sessionId) throw new Error("Parse failed");

  const source = "claude";
  const db = getDb();

  (
    db.transaction(() => {
      upsertSession(result.meta!, filePath, source);
      if (result.turns.length > 0) {
        insertTurns(result.turns, source);
        updateSessionTotals(result.meta!.sessionId);
      }
      if (result.events.length > 0) {
        insertScannerEvents(result.events, source);
      }
      if (result.messages.length > 0 || result.orphanedToolResults?.size) {
        insertMessages(result.messages, result.orphanedToolResults);
        updateSessionMessageCounts(result.meta!.sessionId);
      }
      writeFileWatermark(
        filePath,
        result.newByteOffset,
        result.meta!.sessionId,
      );
    }) as any
  )();

  if (result.forks) {
    for (const fork of result.forks) {
      if (!fork.meta?.sessionId) continue;
      (
        db.transaction(() => {
          upsertSession(fork.meta!, filePath, source);
          if (fork.turns.length > 0) {
            insertTurns(fork.turns, source);
            updateSessionTotals(fork.meta!.sessionId);
          }
          if (fork.events.length > 0) {
            insertScannerEvents(fork.events, source);
          }
          if (fork.messages.length > 0 || fork.orphanedToolResults?.size) {
            insertMessages(fork.messages, fork.orphanedToolResults);
            updateSessionMessageCounts(fork.meta!.sessionId);
          }
        }) as any
      )();
    }
  }
}

// ── Setup / teardown ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  closeDb();
  try {
    fs.unlinkSync(config.dbPath);
  } catch {}
  try {
    fs.unlinkSync(`${config.dbPath}-wal`);
  } catch {}
  try {
    fs.unlinkSync(`${config.dbPath}-shm`);
  } catch {}
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-fork-fixtures-"));
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("fork sync_id stability", () => {
  it("parser detects fork and produces separate session", () => {
    const file = path.join(tmpDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(file, `${buildForkedSessionLines().join("\n")}\n`);

    const claude = getTarget("claude")!;
    const result = claude.scanner!.parseFile(file, 0);

    expect(result).not.toBeNull();
    expect(result!.forks).toBeDefined();
    expect(result!.forks!.length).toBe(1);
    expect(result!.forks![0].meta!.parentSessionId).toBe(SESSION_ID);
    expect(result!.forks![0].meta!.relationshipType).toBe("fork");
    // Fork should have 4 user + 4 assistant turns from the branch
    expect(result!.forks![0].turns.length).toBeGreaterThan(0);
  });

  it("resetFileForReparse clears file data without snapshotting sync_ids", () => {
    const file = path.join(tmpDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(file, `${buildForkedSessionLines().join("\n")}\n`);

    // Parse and insert
    parseAndInsert(file);

    // Verify fork session exists
    const db = getDb();
    const forks = db
      .prepare(
        "SELECT session_id FROM sessions WHERE parent_session_id = ? AND relationship_type = 'fork'",
      )
      .all(SESSION_ID) as Array<{ session_id: string }>;
    expect(forks.length).toBe(1);

    // Get sync_ids before reset
    const before = getAllSyncIds(SESSION_ID);
    expect(before.turns.size).toBeGreaterThan(0);
    expect(before.toolCalls.size).toBeGreaterThan(0);

    // Reset — should clear data without keeping snapshot state
    const saved = resetFileForReparse(file, SESSION_ID);

    expect(saved.turns.length).toBe(0);
    expect(saved.events.length).toBe(0);
    expect(saved.toolCalls.length).toBe(0);

    // Data should be cleared
    const parentTurns = db
      .prepare("SELECT COUNT(*) as c FROM scanner_turns WHERE session_id = ?")
      .get(SESSION_ID) as { c: number };
    expect(parentTurns.c).toBe(0);

    // Fork sessions should be deleted
    const forksAfter = db
      .prepare(
        "SELECT COUNT(*) as c FROM sessions WHERE parent_session_id = ? AND relationship_type = 'fork'",
      )
      .get(SESSION_ID) as { c: number };
    expect(forksAfter.c).toBe(0);
  });

  it("sync_ids stay stable after resetFileForReparse + re-insert", () => {
    const file = path.join(tmpDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(file, `${buildForkedSessionLines().join("\n")}\n`);

    // Initial parse
    parseAndInsert(file);
    const before = getAllSyncIds(SESSION_ID);

    // Reset and re-insert (simulates a full re-scan)
    resetFileForReparse(file, SESSION_ID);

    parseAndInsert(file);
    const after = getAllSyncIds(SESSION_ID);

    // Turns
    for (const [key, oldSyncId] of before.turns) {
      const newSyncId = after.turns.get(key);
      expect(newSyncId).toBeDefined();
      expect(newSyncId).toBe(oldSyncId);
    }

    // Tool calls
    for (const [key, oldSyncId] of before.toolCalls) {
      const newSyncId = after.toolCalls.get(key);
      expect(newSyncId).toBeDefined();
      expect(newSyncId).toBe(oldSyncId);
    }

    // Events (if any)
    for (const [key, oldSyncId] of before.events) {
      const newSyncId = after.events.get(key);
      expect(newSyncId).toBeDefined();
      expect(newSyncId).toBe(oldSyncId);
    }
  });

  it("fork-only sync_ids stay stable (not just parent)", () => {
    const file = path.join(tmpDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(file, `${buildForkedSessionLines().join("\n")}\n`);

    parseAndInsert(file);

    // Get fork session id
    const db = getDb();
    const forkRow = db
      .prepare(
        "SELECT session_id FROM sessions WHERE parent_session_id = ? AND relationship_type = 'fork'",
      )
      .get(SESSION_ID) as { session_id: string };
    const forkSessionId = forkRow.session_id;

    // Snapshot fork-specific sync_ids
    const forkBefore = getSyncIds(forkSessionId);
    expect(forkBefore.turns.size).toBeGreaterThan(0);

    // Reset + re-insert
    resetFileForReparse(file, SESSION_ID);
    parseAndInsert(file);

    // Verify fork sync_ids
    const forkAfter = getSyncIds(forkSessionId);
    for (const [key, oldSyncId] of forkBefore.turns) {
      expect(forkAfter.turns.get(key)).toBe(oldSyncId);
    }
    for (const [key, oldSyncId] of forkBefore.toolCalls) {
      expect(forkAfter.toolCalls.get(key)).toBe(oldSyncId);
    }
  });

  it("works correctly when no session_id is provided (no snapshot)", () => {
    const file = path.join(tmpDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(file, `${buildForkedSessionLines().join("\n")}\n`);

    parseAndInsert(file);

    // Reset without session_id — should return empty saved state
    const saved = resetFileForReparse(file);
    expect(saved.turns.length).toBe(0);
    expect(saved.events.length).toBe(0);
    expect(saved.toolCalls.length).toBe(0);
  });

  it("keeps repeated same-key scanner events distinct and stable", () => {
    const sessionId = "dup-events-session";
    const source = "claude";
    const file = path.join(tmpDir, `${sessionId}.jsonl`);

    upsertSession({ sessionId, startedAtMs: 1 }, file, source);
    insertScannerEvents(
      [
        {
          sessionId,
          eventType: "file_snapshot",
          timestampMs: 1000,
          content: "snapshot-a",
          metadata: { messageId: "m1" },
        },
        {
          sessionId,
          eventType: "file_snapshot",
          timestampMs: 1000,
          content: "snapshot-b",
          metadata: { messageId: "m2" },
        },
        {
          sessionId,
          eventType: "file_snapshot",
          timestampMs: 1000,
          content: "snapshot-c",
          metadata: { messageId: "m3" },
        },
      ],
      source,
    );

    let rows = getDb()
      .prepare(
        `SELECT event_index, content, sync_id
         FROM scanner_events
         WHERE session_id = ?
         ORDER BY event_index`,
      )
      .all(sessionId) as Array<{
      event_index: number;
      content: string | null;
      sync_id: string;
    }>;

    expect(rows).toEqual([
      {
        event_index: 0,
        content: "snapshot-a",
        sync_id: buildScannerEventSyncId(sessionId, source, 0),
      },
      {
        event_index: 1,
        content: "snapshot-b",
        sync_id: buildScannerEventSyncId(sessionId, source, 1),
      },
      {
        event_index: 2,
        content: "snapshot-c",
        sync_id: buildScannerEventSyncId(sessionId, source, 2),
      },
    ]);

    resetFileForReparse(file, sessionId);
    upsertSession({ sessionId, startedAtMs: 1 }, file, source);
    insertScannerEvents(
      [
        {
          sessionId,
          eventType: "file_snapshot",
          timestampMs: 1000,
          content: "snapshot-a",
          metadata: { messageId: "m1" },
        },
        {
          sessionId,
          eventType: "file_snapshot",
          timestampMs: 1000,
          content: "snapshot-b",
          metadata: { messageId: "m2" },
        },
        {
          sessionId,
          eventType: "file_snapshot",
          timestampMs: 1000,
          content: "snapshot-c",
          metadata: { messageId: "m3" },
        },
      ],
      source,
    );

    rows = getDb()
      .prepare(
        `SELECT event_index, content, sync_id
         FROM scanner_events
         WHERE session_id = ?
         ORDER BY event_index`,
      )
      .all(sessionId) as Array<{
      event_index: number;
      content: string | null;
      sync_id: string;
    }>;

    expect(rows).toEqual([
      {
        event_index: 0,
        content: "snapshot-a",
        sync_id: buildScannerEventSyncId(sessionId, source, 0),
      },
      {
        event_index: 1,
        content: "snapshot-b",
        sync_id: buildScannerEventSyncId(sessionId, source, 1),
      },
      {
        event_index: 2,
        content: "snapshot-c",
        sync_id: buildScannerEventSyncId(sessionId, source, 2),
      },
    ]);
  });
});
