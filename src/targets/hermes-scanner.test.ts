import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../db/driver.js";
import { getTarget } from "./index.js";

function makeHermesStateDb(): { filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-hermes-scanner-"));
  const filePath = path.join(dir, "state.db");
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      source TEXT,
      model TEXT,
      started_at REAL,
      ended_at REAL,
      cwd TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      title TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL,
      token_count INTEGER,
      reasoning TEXT,
      reasoning_content TEXT,
      reasoning_details TEXT,
      active INTEGER DEFAULT 1
    );
  `);
  db.prepare(
    `INSERT INTO sessions
       (id, source, model, started_at, cwd, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "20260611_120000_abcd",
    "cli",
    "gpt-test",
    1_780_000_000,
    "/tmp/project",
    100,
    25,
    7,
    3,
    5,
    "fallback title",
  );
  db.prepare(
    `INSERT INTO messages
       (session_id, role, content, timestamp, active)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "20260611_120000_abcd",
    "user",
    `${"\0"}json:${JSON.stringify([{ type: "text", text: "build it" }])}`,
    1_780_000_001,
    1,
  );
  db.prepare(
    `INSERT INTO messages
       (session_id, role, content, tool_calls, timestamp, token_count,
        reasoning_content, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "20260611_120000_abcd",
    "assistant",
    "I will read the file.",
    JSON.stringify([
      {
        id: "call_1",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "/tmp/project/a.ts" }),
        },
      },
    ]),
    1_780_000_002,
    25,
    "Need the file contents first.",
    1,
  );
  db.prepare(
    `INSERT INTO messages
       (session_id, role, content, tool_call_id, tool_name, timestamp, active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "20260611_120000_abcd",
    "tool",
    "file contents",
    "call_1",
    "read_file",
    1_780_000_003,
    1,
  );
  db.close();
  return {
    filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("hermes scanner", () => {
  it("parses active state.db sessions, messages, tool calls, and token totals", () => {
    const hermes = getTarget("hermes")!;
    const { filePath, cleanup } = makeHermesStateDb();
    try {
      const result = hermes.scanner!.parseFile(filePath, 0)!;
      expect(result.meta).toMatchObject({
        sessionId: "20260611_120000_abcd",
        model: "gpt-test",
        cwd: "/tmp/project",
        firstPrompt: "build it",
      });
      expect(result.absoluteIndices).toBe(true);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toMatchObject({
        role: "user",
        content: "build it",
      });
      expect(result.messages[1]).toMatchObject({
        role: "assistant",
        hasThinking: true,
        hasToolUse: true,
      });
      expect(result.messages[1].toolCalls[0]).toMatchObject({
        toolUseId: "call_1",
        toolName: "read_file",
        category: "Read",
        inputJson: JSON.stringify({ path: "/tmp/project/a.ts" }),
      });
      expect(result.orphanedToolResults?.get("call_1")).toMatchObject({
        contentRaw: "file contents",
      });
      expect(result.turns.at(-1)).toMatchObject({
        role: "assistant",
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 7,
        cacheCreationTokens: 3,
        reasoningTokens: 5,
      });
      // Watermark is the max messages.id, not a byte size — state.db is
      // SQLite/WAL, where the main file's byte size never tracks new data.
      expect(result.newByteOffset).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("marks Hermes scanner-discovered child sessions as subagents", () => {
    const hermes = getTarget("hermes")!;
    const { filePath, cleanup } = makeHermesStateDb();
    try {
      const db = new Database(filePath);
      db.prepare(
        `UPDATE sessions
            SET parent_session_id = ?
          WHERE id = ?`,
      ).run("20260611_115900_parent", "20260611_120000_abcd");
      db.close();

      const result = hermes.scanner!.parseFile(filePath, 0)!;
      expect(result.meta).toMatchObject({
        sessionId: "20260611_120000_abcd",
        parentSessionId: "20260611_115900_parent",
        relationshipType: "subagent",
      });
    } finally {
      cleanup();
    }
  });

  it("does not classify tool names by incidental substrings", () => {
    const hermes = getTarget("hermes")!;
    const { filePath, cleanup } = makeHermesStateDb();
    try {
      const db = new Database(filePath);
      db.prepare(
        `UPDATE messages
            SET tool_calls = ?
          WHERE session_id = ? AND role = ?`,
      ).run(
        JSON.stringify([
          {
            id: "call_1",
            function: {
              name: "thread",
              arguments: JSON.stringify({ id: "abc" }),
            },
          },
        ]),
        "20260611_120000_abcd",
        "assistant",
      );
      db.close();

      const result = hermes.scanner!.parseFile(filePath, 0)!;
      expect(result.messages[1].toolCalls[0]).toMatchObject({
        toolName: "thread",
        category: "",
      });
    } finally {
      cleanup();
    }
  });

  it("returns null when no messages were added since the watermark", () => {
    const hermes = getTarget("hermes")!;
    const { filePath, cleanup } = makeHermesStateDb();
    try {
      const first = hermes.scanner!.parseFile(filePath, 0)!;
      expect(hermes.scanner!.parseFile(filePath, first.newByteOffset)).toBe(
        null,
      );
    } finally {
      cleanup();
    }
  });

  it("re-snapshots only sessions with new messages on incremental parse", () => {
    const hermes = getTarget("hermes")!;
    const { filePath, cleanup } = makeHermesStateDb();
    try {
      const first = hermes.scanner!.parseFile(filePath, 0)!;

      const db = new Database(filePath);
      db.prepare(
        `INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("20260611_130000_efgh", "cli", "gpt-test", 1_780_000_100, 40, 9);
      db.prepare(
        `INSERT INTO messages (session_id, role, content, timestamp, active)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("20260611_130000_efgh", "user", "second session", 1_780_000_101, 1);
      db.prepare(
        `INSERT INTO messages (session_id, role, content, timestamp, active)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("20260611_130000_efgh", "assistant", "on it", 1_780_000_102, 1);
      db.close();

      const second = hermes.scanner!.parseFile(filePath, first.newByteOffset)!;
      expect(second.meta?.sessionId).toBe("20260611_130000_efgh");
      expect(second.forks ?? []).toHaveLength(0);
      // Full snapshot of the changed session: both its messages, absolute indices
      expect(second.messages).toHaveLength(2);
      expect(second.messages[0]).toMatchObject({ ordinal: 0, role: "user" });
      expect(second.absoluteIndices).toBe(true);
      // Session-aggregate tokens land on its latest assistant turn
      expect(second.turns.at(-1)).toMatchObject({
        role: "assistant",
        inputTokens: 40,
        outputTokens: 9,
      });
      expect(second.newByteOffset).toBe(5);
    } finally {
      cleanup();
    }
  });

  it("re-snapshots a recently active session when only token aggregates change", () => {
    const hermes = getTarget("hermes")!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-hermes-active-"));
    const filePath = path.join(dir, "state.db");
    const nowSec = Date.now() / 1000;
    const db = new Database(filePath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, parent_session_id TEXT, source TEXT, model TEXT,
        started_at REAL, ended_at REAL, cwd TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER, title TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
        content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
        timestamp REAL, token_count INTEGER, reasoning TEXT,
        reasoning_content TEXT, reasoning_details TEXT, active INTEGER DEFAULT 1
      );
    `);
    // Active session: messages are timestamped "now"; usage not yet recorded.
    db.prepare(
      `INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, 0, 0)`,
    ).run("live", "cli", "gpt-test", nowSec);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp, active)
       VALUES (?, 'user', 'hi', ?, 1)`,
    ).run("live", nowSec);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp, active)
       VALUES (?, 'assistant', 'yo', ?, 1)`,
    ).run("live", nowSec);
    db.close();

    try {
      const first = hermes.scanner!.parseFile(filePath, 0)!;
      expect(first.turns.at(-1)).toMatchObject({ outputTokens: 0 });

      // Hermes finalizes usage AFTER the assistant message row (set_session_usage)
      // — token columns change with no new messages, so MAX(messages.id) is
      // unchanged. The recently-active session must still be re-snapshotted.
      const db2 = new Database(filePath);
      db2
        .prepare(
          "UPDATE sessions SET input_tokens = 500, output_tokens = 120 WHERE id = 'live'",
        )
        .run();
      db2.close();

      const second = hermes.scanner!.parseFile(filePath, first.newByteOffset);
      expect(second).not.toBeNull();
      expect(second!.meta?.sessionId).toBe("live");
      expect(second!.turns.at(-1)).toMatchObject({
        inputTokens: 500,
        outputTokens: 120,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-snapshots everything when the watermark exceeds max id (recreated db)", () => {
    const hermes = getTarget("hermes")!;
    const { filePath, cleanup } = makeHermesStateDb();
    try {
      const result = hermes.scanner!.parseFile(filePath, 999)!;
      expect(result.meta?.sessionId).toBe("20260611_120000_abcd");
      expect(result.messages).toHaveLength(2);
      expect(result.newByteOffset).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("emits a message-only session whose sessions row is missing (no watermark churn)", () => {
    const hermes = getTarget("hermes")!;
    const { filePath, cleanup } = makeHermesStateDb();
    try {
      const first = hermes.scanner!.parseFile(filePath, 0)!;

      // A message whose session_id has no row in `sessions` (late/missing
      // metadata). Before the fix, the incremental parse returned null here,
      // so the watermark never advanced and every scan re-queried these rows.
      const db = new Database(filePath);
      db.prepare(
        `INSERT INTO messages (session_id, role, content, timestamp, active)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("orphan_session", "user", "orphaned", 1_780_000_200, 1);
      db.close();

      const second = hermes.scanner!.parseFile(filePath, first.newByteOffset);
      expect(second).not.toBeNull();
      expect(second!.meta?.sessionId).toBe("orphan_session");
      expect(second!.messages).toHaveLength(1);
      // Watermark advances past the orphan message (fixture max id 3 -> 4).
      expect(second!.newByteOffset).toBe(4);
    } finally {
      cleanup();
    }
  });
});
