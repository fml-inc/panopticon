import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_DATA_COMPONENTS,
  CLAIM_DERIVED_COMPONENTS,
  SESSION_SUMMARY_PROJECTION_COMPONENT,
  targetDataVersion,
} from "./data-versions.js";
import { Database } from "./driver.js";
import { MIGRATIONS, type Migration, runMigrations } from "./migrations.js";
import { SCHEMA_SQL } from "./schema.js";
import {
  buildMessageSyncId,
  buildScannerEventSyncId,
  buildScannerTurnSyncId,
  buildToolCallSyncId,
} from "./sync-ids.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb(): { db: Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-migrations-"));
  const dbPath = path.join(dir, "test.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

function createDb(): Database {
  const { db, cleanup } = makeTempDb();
  cleanups.push(cleanup);
  return db;
}

/** Create a DB with schema_migrations already present (simulates existing DB). */
function createExistingDb(): Database {
  const db = createDb();
  db.exec(`
    CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

function getApplied(db: Database): Array<{ id: number; name: string }> {
  return db
    .prepare("SELECT id, name FROM schema_migrations ORDER BY id")
    .all() as Array<{ id: number; name: string }>;
}

// ---------------------------------------------------------------------------
// Tests: fresh DB behavior
// ---------------------------------------------------------------------------

describe("runMigrations — fresh DB", () => {
  it("stamps all migrations without executing them", () => {
    const db = createDb();
    db.exec(SCHEMA_SQL);
    runMigrations(db);

    const rows = getApplied(db);
    expect(rows.length).toBe(MIGRATIONS.length);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(rows[i].id).toBe(MIGRATIONS[i].id);
      expect(rows[i].name).toBe(MIGRATIONS[i].name);
    }
  });

  it("does not execute sql on fresh DB", () => {
    const db = createDb();
    // Create the table with the column already (as SCHEMA_SQL would)
    db.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY, col_a TEXT)");

    const migrations: Migration[] = [
      {
        id: 1,
        name: "should_not_run",
        // This would fail if executed — column already exists
        sql: "ALTER TABLE test_table ADD COLUMN col_a TEXT",
      },
    ];

    // No schema_migrations → fresh DB → stamps without executing
    runMigrations(db, migrations);
    expect(getApplied(db)).toHaveLength(1);
  });

  it("does not call up() on fresh DB", () => {
    const db = createDb();
    const spy = vi.fn();

    const migrations: Migration[] = [{ id: 1, name: "noop", up: spy }];

    runMigrations(db, migrations);
    expect(spy).not.toHaveBeenCalled();
    expect(getApplied(db)).toHaveLength(1);
  });

  it("records applied_at timestamp", () => {
    const db = createDb();
    db.exec(SCHEMA_SQL);
    runMigrations(db);

    const row = db
      .prepare("SELECT applied_at FROM schema_migrations WHERE id = 1")
      .get() as { applied_at: string };
    expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Tests: pre-migration-system DB (no schema_migrations table but has data)
// ---------------------------------------------------------------------------

describe("runMigrations — pre-migration-system DB", () => {
  it("runs migrations instead of stamping when sessions table has data", () => {
    const db = createDb();
    // Simulate a pre-migration-system DB: tables exist with data but no schema_migrations
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        start_ms INTEGER NOT NULL
      )
    `);
    db.exec("INSERT INTO sessions (session_id, start_ms) VALUES ('s1', 1000)");
    db.exec(`
      CREATE TABLE user_config_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_name TEXT NOT NULL,
        snapshot_at_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        permissions JSON NOT NULL DEFAULT '{}',
        enabled_plugins JSON NOT NULL DEFAULT '[]',
        hooks JSON NOT NULL DEFAULT '[]',
        commands JSON NOT NULL DEFAULT '[]',
        rules JSON NOT NULL DEFAULT '[]',
        skills JSON NOT NULL DEFAULT '[]'
      )
    `);

    runMigrations(db);

    // Migration should have EXECUTED (not just stamped)
    const cols = db
      .prepare("PRAGMA table_info(user_config_snapshots)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("plugin_hooks");
    expect(getApplied(db).map((r) => r.id)).toContain(1);
  });

  it("stamps without executing when sessions table has no data", () => {
    const db = createDb();
    db.exec(
      "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, start_ms INTEGER NOT NULL)",
    );
    // No data inserted — treat as fresh
    const spy = vi.fn();
    const migrations: Migration[] = [{ id: 1, name: "noop", up: spy }];

    runMigrations(db, migrations);

    expect(spy).not.toHaveBeenCalled();
    expect(getApplied(db)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: existing DB behavior
// ---------------------------------------------------------------------------

describe("runMigrations — existing DB", () => {
  it("runs sql migration on existing DB missing a column", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE user_config_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_name TEXT NOT NULL,
        snapshot_at_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        permissions JSON NOT NULL DEFAULT '{}',
        enabled_plugins JSON NOT NULL DEFAULT '[]',
        hooks JSON NOT NULL DEFAULT '[]',
        commands JSON NOT NULL DEFAULT '[]',
        rules JSON NOT NULL DEFAULT '[]',
        skills JSON NOT NULL DEFAULT '[]'
      )
    `);

    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(user_config_snapshots)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("plugin_hooks");
    expect(getApplied(db).map((r) => r.id)).toContain(1);
  });

  it("migration 4 adds panopticon_allowed, panopticon_approvals, memory_files", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE user_config_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_name TEXT NOT NULL,
        snapshot_at_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        permissions JSON NOT NULL DEFAULT '{}',
        enabled_plugins JSON NOT NULL DEFAULT '[]',
        hooks JSON NOT NULL DEFAULT '[]',
        commands JSON NOT NULL DEFAULT '[]',
        rules JSON NOT NULL DEFAULT '[]',
        skills JSON NOT NULL DEFAULT '[]',
        plugin_hooks JSON NOT NULL DEFAULT '[]'
      )
    `);
    // Stamp migrations 1-3 as already applied so only 4 runs
    db.prepare(
      "INSERT INTO schema_migrations (id, name) VALUES (?, ?), (?, ?), (?, ?)",
    ).run(1, "stamp1", 2, "stamp2", 3, "stamp3");

    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(user_config_snapshots)")
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("panopticon_allowed");
    expect(names).toContain("panopticon_approvals");
    expect(names).toContain("memory_files");
    expect(getApplied(db).map((r) => r.id)).toContain(4);

    // Insert a row with defaults — confirms defaults are valid JSON that reader helpers
    // (parseJsonObjectOrNull, parseMemoryMap) can handle.
    db.prepare(
      `INSERT INTO user_config_snapshots (device_name, snapshot_at_ms, content_hash)
       VALUES ('test', 1, 'abc')`,
    ).run();
    const row = db
      .prepare(
        "SELECT panopticon_allowed, panopticon_approvals, memory_files FROM user_config_snapshots WHERE device_name = 'test'",
      )
      .get() as {
      panopticon_allowed: string;
      panopticon_approvals: string;
      memory_files: string;
    };
    expect(row.panopticon_allowed).toBe("null");
    expect(row.panopticon_approvals).toBe("null");
    expect(row.memory_files).toBe("{}");
  });

  it("migration 6 adds and backfills messages.sync_id", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp_ms INTEGER,
        has_thinking INTEGER NOT NULL DEFAULT 0,
        has_tool_use INTEGER NOT NULL DEFAULT 0,
        content_length INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        token_usage TEXT NOT NULL DEFAULT '',
        context_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        has_context_tokens INTEGER NOT NULL DEFAULT 0,
        has_output_tokens INTEGER NOT NULL DEFAULT 0,
        uuid TEXT,
        parent_uuid TEXT,
        UNIQUE(session_id, ordinal)
      )
    `);
    db.prepare(
      "INSERT INTO schema_migrations (id, name) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)",
    ).run(1, "stamp1", 2, "stamp2", 3, "stamp3", 4, "stamp4", 5, "stamp5");
    db.prepare(
      `INSERT INTO messages (session_id, ordinal, role, content, uuid)
       VALUES (?, ?, 'assistant', 'with-uuid', ?), (?, ?, 'assistant', 'without-uuid', NULL)`,
    ).run("sess-1", 0, "uuid-123", "sess-1", 1);

    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("sync_id");

    const rows = db
      .prepare(
        "SELECT session_id, ordinal, uuid, sync_id FROM messages ORDER BY ordinal",
      )
      .all() as Array<{
      session_id: string;
      ordinal: number;
      uuid: string | null;
      sync_id: string | null;
    }>;
    expect(rows).toEqual([
      {
        session_id: "sess-1",
        ordinal: 0,
        uuid: "uuid-123",
        sync_id: buildMessageSyncId("sess-1", 0, "uuid-123"),
      },
      {
        session_id: "sess-1",
        ordinal: 1,
        uuid: null,
        sync_id: buildMessageSyncId("sess-1", 1),
      },
    ]);
    expect(getApplied(db).map((r) => r.id)).toContain(6);
  });

  it("migration 7 adds call_index and backfills tool_call sync ids", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp_ms INTEGER,
        has_thinking INTEGER NOT NULL DEFAULT 0,
        has_tool_use INTEGER NOT NULL DEFAULT 0,
        content_length INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        token_usage TEXT NOT NULL DEFAULT '',
        context_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        has_context_tokens INTEGER NOT NULL DEFAULT 0,
        has_output_tokens INTEGER NOT NULL DEFAULT 0,
        uuid TEXT,
        parent_uuid TEXT,
        sync_id TEXT NOT NULL,
        UNIQUE(session_id, ordinal)
      )
    `);
    db.exec(`
      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        category TEXT NOT NULL,
        tool_use_id TEXT,
        input_json TEXT,
        skill_name TEXT,
        result_content_length INTEGER,
        result_content TEXT,
        duration_ms INTEGER,
        subagent_session_id TEXT,
        sync_id TEXT DEFAULT (hex(randomblob(8)))
      )
    `);
    db.prepare(
      "INSERT INTO schema_migrations (id, name) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)",
    ).run(
      1,
      "stamp1",
      2,
      "stamp2",
      3,
      "stamp3",
      4,
      "stamp4",
      5,
      "stamp5",
      6,
      "stamp6",
    );
    const messageSyncId = buildMessageSyncId("sess-1", 0, "uuid-123");
    db.prepare(
      `INSERT INTO messages (session_id, ordinal, role, content, uuid, sync_id)
       VALUES (?, ?, 'assistant', 'msg', ?, ?)`,
    ).run("sess-1", 0, "uuid-123", messageSyncId);
    const messageId = (
      db
        .prepare("SELECT id FROM messages WHERE session_id = 'sess-1'")
        .get() as {
        id: number;
      }
    ).id;
    db.prepare(
      `INSERT INTO tool_calls
         (message_id, session_id, tool_name, category, tool_use_id)
       VALUES (?, ?, 'Write', 'file', NULL), (?, ?, 'Edit', 'file', 'tu-1')`,
    ).run(messageId, "sess-1", messageId, "sess-1");

    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(tool_calls)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("call_index");

    const rows = db
      .prepare(
        "SELECT call_index, tool_use_id, sync_id FROM tool_calls ORDER BY id",
      )
      .all() as Array<{
      call_index: number;
      tool_use_id: string | null;
      sync_id: string;
    }>;
    expect(rows).toEqual([
      {
        call_index: 0,
        tool_use_id: null,
        sync_id: buildToolCallSyncId(messageSyncId, 0, null),
      },
      {
        call_index: 1,
        tool_use_id: "tu-1",
        sync_id: buildToolCallSyncId(messageSyncId, 1, "tu-1"),
      },
    ]);
    expect(getApplied(db).map((r) => r.id)).toContain(7);
  });

  it("migration 8 backfills deterministic scanner turn and event sync ids", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE scanner_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        model TEXT,
        role TEXT,
        content_preview TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        sync_id TEXT DEFAULT (hex(randomblob(8))),
        UNIQUE(session_id, source, turn_index)
      )
    `);
    db.exec(`
      CREATE TABLE scanner_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        tool_output TEXT,
        content TEXT,
        metadata JSON,
        sync_id TEXT DEFAULT (hex(randomblob(8))),
        UNIQUE(session_id, source, event_type, timestamp_ms, tool_name)
      )
    `);
    db.prepare(
      "INSERT INTO schema_migrations (id, name) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)",
    ).run(
      1,
      "stamp1",
      2,
      "stamp2",
      3,
      "stamp3",
      4,
      "stamp4",
      5,
      "stamp5",
      6,
      "stamp6",
      7,
      "stamp7",
    );
    db.prepare(
      `INSERT INTO scanner_turns (session_id, source, turn_index, timestamp_ms, role, sync_id)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    ).run(
      "sess-1",
      "claude",
      0,
      100,
      "assistant",
      "old-turn-sync-1",
      "sess-1",
      "claude",
      1,
      101,
      "user",
      "old-turn-sync-2",
    );
    db.prepare(
      `INSERT INTO scanner_events (session_id, source, event_type, timestamp_ms, tool_name, sync_id)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    ).run(
      "sess-1",
      "claude",
      "tool_call",
      200,
      "Bash",
      "old-event-sync-1",
      "sess-1",
      "claude",
      "note",
      201,
      null,
      "old-event-sync-2",
    );

    runMigrations(db);

    const turns = db
      .prepare(
        "SELECT session_id, source, turn_index, sync_id FROM scanner_turns ORDER BY turn_index",
      )
      .all() as Array<{
      session_id: string;
      source: string;
      turn_index: number;
      sync_id: string | null;
    }>;
    expect(turns).toEqual([
      {
        session_id: "sess-1",
        source: "claude",
        turn_index: 0,
        sync_id: buildScannerTurnSyncId("sess-1", "claude", 0),
      },
      {
        session_id: "sess-1",
        source: "claude",
        turn_index: 1,
        sync_id: buildScannerTurnSyncId("sess-1", "claude", 1),
      },
    ]);

    const events = db
      .prepare(
        `SELECT session_id, source, event_type, timestamp_ms, tool_name, sync_id
         FROM scanner_events ORDER BY id`,
      )
      .all() as Array<{
      session_id: string;
      source: string;
      event_type: string;
      timestamp_ms: number;
      tool_name: string | null;
      sync_id: string | null;
    }>;
    expect(events).toEqual([
      {
        session_id: "sess-1",
        source: "claude",
        event_type: "tool_call",
        timestamp_ms: 200,
        tool_name: "Bash",
        sync_id: buildScannerEventSyncId("sess-1", "claude", 0),
      },
      {
        session_id: "sess-1",
        source: "claude",
        event_type: "note",
        timestamp_ms: 201,
        tool_name: null,
        sync_id: buildScannerEventSyncId("sess-1", "claude", 1),
      },
    ]);
    expect(getApplied(db).map((r) => r.id)).toContain(8);
  });

  it("migration 9 rebuilds scanner_events with event_index and new uniqueness", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE scanner_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        tool_output TEXT,
        content TEXT,
        metadata JSON,
        sync_id TEXT DEFAULT (hex(randomblob(8))),
        UNIQUE(session_id, source, event_type, timestamp_ms, tool_name)
      )
    `);
    db.prepare(
      `INSERT INTO schema_migrations (id, name)
       VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)`,
    ).run(
      1,
      "stamp1",
      2,
      "stamp2",
      3,
      "stamp3",
      4,
      "stamp4",
      5,
      "stamp5",
      6,
      "stamp6",
      7,
      "stamp7",
      8,
      "stamp8",
    );
    db.prepare(
      `INSERT INTO scanner_events (
         id, session_id, source, event_type, timestamp_ms, tool_name,
         tool_input, tool_output, content, metadata, sync_id
       ) VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      5,
      "sess-1",
      "claude",
      "note",
      100,
      null,
      null,
      null,
      "first",
      JSON.stringify({ a: 1 }),
      "old-sync-a",
      7,
      "sess-1",
      "claude",
      "note",
      101,
      null,
      null,
      null,
      "second",
      JSON.stringify({ a: 2 }),
      "old-sync-b",
      9,
      "sess-2",
      "gemini",
      "reasoning",
      102,
      null,
      null,
      null,
      "third",
      JSON.stringify({ a: 3 }),
      "old-sync-c",
    );

    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(scanner_events)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("event_index");

    const rows = db
      .prepare(
        `SELECT id, session_id, source, event_index, event_type, timestamp_ms, sync_id
         FROM scanner_events
         ORDER BY session_id, source, event_index`,
      )
      .all() as Array<{
      id: number;
      session_id: string;
      source: string;
      event_index: number;
      event_type: string;
      timestamp_ms: number;
      sync_id: string | null;
    }>;
    expect(rows).toEqual([
      {
        id: 5,
        session_id: "sess-1",
        source: "claude",
        event_index: 0,
        event_type: "note",
        timestamp_ms: 100,
        sync_id: buildScannerEventSyncId("sess-1", "claude", 0),
      },
      {
        id: 7,
        session_id: "sess-1",
        source: "claude",
        event_index: 1,
        event_type: "note",
        timestamp_ms: 101,
        sync_id: buildScannerEventSyncId("sess-1", "claude", 1),
      },
      {
        id: 9,
        session_id: "sess-2",
        source: "gemini",
        event_index: 0,
        event_type: "reasoning",
        timestamp_ms: 102,
        sync_id: buildScannerEventSyncId("sess-2", "gemini", 0),
      },
    ]);

    expect(getApplied(db).map((r) => r.id)).toContain(9);
  });

  it("migrations 10 and 11 reset derived state and rebuild claim_evidence schema", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        UNIQUE(session_id, ordinal)
      );
      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        call_index INTEGER NOT NULL DEFAULT 0,
        tool_name TEXT NOT NULL,
        tool_use_id TEXT,
        sync_id TEXT NOT NULL
      );
      CREATE TABLE hook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        tool_name TEXT,
        sync_id TEXT
      );
      CREATE TABLE claim_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id INTEGER NOT NULL,
        evidence_key TEXT NOT NULL,
        detail JSON,
        role TEXT NOT NULL DEFAULT 'supporting'
      );
      CREATE TABLE evidence_ref_paths (
        evidence_ref_id INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        UNIQUE(evidence_ref_id, file_path)
      );
      CREATE TABLE claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_key TEXT NOT NULL UNIQUE,
        head_key TEXT NOT NULL,
        predicate TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        value_kind TEXT NOT NULL,
        value_text TEXT,
        value_num REAL,
        value_json TEXT,
        source_type TEXT NOT NULL,
        source_rank INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 1.0,
        observed_at_ms INTEGER NOT NULL,
        asserted_at_ms INTEGER NOT NULL,
        asserter TEXT NOT NULL,
        asserter_version INTEGER NOT NULL,
        machine TEXT NOT NULL DEFAULT 'local',
        sync_id TEXT DEFAULT (hex(randomblob(8)))
      );
      CREATE TABLE active_claims (
        head_key TEXT PRIMARY KEY,
        claim_id INTEGER NOT NULL,
        selected_at_ms INTEGER NOT NULL,
        selection_reason TEXT NOT NULL
      );
      CREATE TABLE intent_units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        intent_key TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        prompt_ts_ms INTEGER,
        next_prompt_ts_ms INTEGER,
        edit_count INTEGER NOT NULL DEFAULT 0,
        landed_count INTEGER,
        reconciled_at_ms INTEGER,
        cwd TEXT,
        repository TEXT
      );
      CREATE VIRTUAL TABLE intent_units_fts USING fts5(
        prompt_text,
        content='',
        contentless_delete=1,
        tokenize='trigram'
      );
      CREATE TABLE intent_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        edit_key TEXT NOT NULL UNIQUE,
        intent_unit_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        timestamp_ms INTEGER,
        file_path TEXT NOT NULL,
        tool_name TEXT,
        multi_edit_index INTEGER NOT NULL DEFAULT 0,
        new_string_hash TEXT,
        new_string_snippet TEXT,
        landed INTEGER,
        landed_reason TEXT
      );
      CREATE TABLE session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_summary_key TEXT NOT NULL UNIQUE,
        repository TEXT,
        cwd TEXT,
        branch TEXT,
        worktree TEXT,
        actor TEXT,
        machine TEXT NOT NULL DEFAULT 'local',
        origin_scope TEXT NOT NULL DEFAULT 'local',
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        first_intent_ts_ms INTEGER,
        last_intent_ts_ms INTEGER,
        intent_count INTEGER NOT NULL DEFAULT 0,
        edit_count INTEGER NOT NULL DEFAULT 0,
        landed_edit_count INTEGER NOT NULL DEFAULT 0,
        open_edit_count INTEGER NOT NULL DEFAULT 0,
        reconciled_at_ms INTEGER,
        reason_json TEXT
      );
      CREATE TABLE intent_session_summaries (
        intent_unit_id INTEGER NOT NULL,
        session_summary_id INTEGER NOT NULL,
        membership_kind TEXT NOT NULL,
        source TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 1.0,
        reason_json TEXT,
        UNIQUE(intent_unit_id, session_summary_id)
      );
      CREATE TABLE code_provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository TEXT NOT NULL,
        file_path TEXT NOT NULL,
        binding_level TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        snippet_hash TEXT,
        snippet_preview TEXT,
        language TEXT,
        symbol_kind TEXT,
        symbol_name TEXT,
        actor TEXT,
        machine TEXT NOT NULL DEFAULT 'local',
        origin_scope TEXT NOT NULL DEFAULT 'local',
        intent_unit_id INTEGER NOT NULL,
        intent_edit_id INTEGER,
        session_summary_id INTEGER,
        status TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        file_hash TEXT,
        established_at_ms INTEGER NOT NULL,
        verified_at_ms INTEGER NOT NULL
      );
      CREATE TABLE ingestion_cursors (
        asserter TEXT NOT NULL,
        source TEXT NOT NULL,
        cursor_text TEXT NOT NULL DEFAULT '',
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (asserter, source)
      );
      CREATE TABLE claim_rebuild_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asserter TEXT NOT NULL,
        asserter_version INTEGER NOT NULL,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        rows_emitted INTEGER NOT NULL DEFAULT 0,
        scope JSON
      );
    `);
    db.prepare(
      `INSERT INTO schema_migrations (id, name)
       VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?),
              (?, ?), (?, ?), (?, ?), (?, ?)`,
    ).run(
      1,
      "stamp1",
      2,
      "stamp2",
      3,
      "stamp3",
      4,
      "stamp4",
      5,
      "stamp5",
      6,
      "stamp6",
      7,
      "stamp7",
      8,
      "stamp8",
      9,
      "stamp9",
    );
    db.prepare(
      `INSERT INTO messages (id, session_id, ordinal, role, content, sync_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, "sess-1", 0, "user", "hi", "msg-sync-1");
    db.prepare(
      `INSERT INTO tool_calls (
         id, message_id, session_id, call_index, tool_name, tool_use_id, sync_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 1, "sess-1", 0, "Edit", "tool-123", "tc-sync-1");
    db.prepare(
      `INSERT INTO hook_events (
         id, session_id, event_type, timestamp_ms, tool_name, sync_id
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, "sess-1", "PostToolUse", 1000, "Edit", "hook-sync-1");
    db.prepare(
      `INSERT INTO claims (
         id, observation_key, head_key, predicate, subject_kind, subject,
         value_kind, value_text, source_type, observed_at_ms, asserted_at_ms,
         asserter, asserter_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "obs-1",
      "head-1",
      "edit/part-of-intent",
      "edit",
      "edit:test",
      "text",
      "intent:test",
      "scanner",
      1000,
      1000,
      "intent.from_scanner",
      "1",
    );
    db.prepare(
      `INSERT INTO active_claims (head_key, claim_id, selected_at_ms, selection_reason)
       VALUES (?, ?, ?, ?)`,
    ).run("head-1", 1, 1000, "test");
    db.prepare(
      `INSERT INTO claim_evidence (claim_id, evidence_key)
       VALUES (?, ?), (?, ?), (?, ?), (?, ?)`,
    ).run(
      1,
      "message:sess-1:0",
      1,
      "tool:tool-123",
      1,
      "hook:1",
      1,
      "fs_snapshot:/tmp/file.txt:abc123",
    );
    db.prepare(
      `INSERT INTO evidence_ref_paths (evidence_ref_id, file_path)
       VALUES (?, ?)`,
    ).run(1, "/tmp/file.txt");
    db.prepare(
      `INSERT INTO intent_units (id, intent_key, session_id, prompt_text)
       VALUES (?, ?, ?, ?)`,
    ).run(1, "intent:test", "sess-1", "hi");
    db.prepare(
      `INSERT INTO intent_units_fts (rowid, prompt_text) VALUES (?, ?)`,
    ).run(1, "hi");
    db.prepare(
      `INSERT INTO intent_edits (id, edit_key, intent_unit_id, session_id, file_path)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(1, "edit:test", 1, "sess-1", "/tmp/file.txt");
    db.prepare(
      `INSERT INTO session_summaries (
         id, session_summary_key, title, status
       ) VALUES (?, ?, ?, ?)`,
    ).run(1, "summary:test", "Test summary", "active");
    db.prepare(
      `INSERT INTO intent_session_summaries (
         intent_unit_id, session_summary_id, membership_kind, source
       ) VALUES (?, ?, ?, ?)`,
    ).run(1, 1, "primary", "heuristic");
    db.prepare(
      `INSERT INTO code_provenance (
         repository, file_path, binding_level, intent_unit_id, status,
         established_at_ms, verified_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("/tmp/repo", "/tmp/file.txt", "file", 1, "current", 1000, 1000);
    db.prepare(
      `INSERT INTO ingestion_cursors (asserter, source, updated_at_ms)
       VALUES (?, ?, ?)`,
    ).run("intent.from_scanner", "scanner", 1000);
    db.prepare(
      `INSERT INTO claim_rebuild_runs (
         asserter, asserter_version, started_at_ms
       ) VALUES (?, ?, ?)`,
    ).run("intent.from_scanner", 1, 1000);

    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(claim_evidence)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("evidence_ref_id");
    expect(cols.map((c) => c.name)).not.toContain("evidence_key");
    const claimCols = db.prepare("PRAGMA table_info(claims)").all() as Array<{
      name: string;
      type: string;
    }>;
    const rebuildRunCols = db
      .prepare("PRAGMA table_info(claim_rebuild_runs)")
      .all() as Array<{ name: string; type: string }>;
    expect(claimCols.find((c) => c.name === "asserter_version")?.type).toBe(
      "INTEGER",
    );
    expect(
      rebuildRunCols.find((c) => c.name === "asserter_version")?.type,
    ).toBe("INTEGER");

    const derivedCounts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM claims) AS claims,
           (SELECT COUNT(*) FROM active_claims) AS active_claims,
           (SELECT COUNT(*) FROM claim_evidence) AS claim_evidence,
           (SELECT COUNT(*) FROM evidence_refs) AS evidence_refs,
           (SELECT COUNT(*) FROM evidence_ref_paths) AS evidence_ref_paths,
           (SELECT COUNT(*) FROM intent_units) AS intent_units,
           (SELECT COUNT(*) FROM intent_units_fts) AS intent_units_fts,
           (SELECT COUNT(*) FROM intent_edits) AS intent_edits,
           (SELECT COUNT(*) FROM session_summaries) AS session_summaries,
           (SELECT COUNT(*) FROM intent_session_summaries) AS intent_session_summaries,
           (SELECT COUNT(*) FROM code_provenance) AS code_provenance,
           (SELECT COUNT(*) FROM ingestion_cursors) AS ingestion_cursors,
           (SELECT COUNT(*) FROM claim_rebuild_runs) AS claim_rebuild_runs`,
      )
      .get() as Record<string, number>;
    expect(derivedCounts).toEqual({
      claims: 0,
      active_claims: 0,
      claim_evidence: 0,
      evidence_refs: 0,
      evidence_ref_paths: 0,
      intent_units: 0,
      intent_units_fts: 0,
      intent_edits: 0,
      session_summaries: 0,
      intent_session_summaries: 0,
      code_provenance: 0,
      ingestion_cursors: 0,
      claim_rebuild_runs: 0,
    });

    const rawCounts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM tool_calls) AS tool_calls,
           (SELECT COUNT(*) FROM hook_events) AS hook_events`,
      )
      .get() as Record<string, number>;
    expect(rawCounts).toEqual({
      messages: 1,
      tool_calls: 1,
      hook_events: 1,
    });

    expect(getApplied(db).map((r) => r.id)).toContain(10);
    expect(getApplied(db).map((r) => r.id)).toContain(11);
    expect(getApplied(db).map((r) => r.id)).toContain(12);
    expect(getApplied(db).map((r) => r.id)).toContain(13);
  });

  it("tolerates rerunning migration 5 after claim_evidence was rebuilt", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE claim_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id INTEGER NOT NULL,
        evidence_ref_id INTEGER NOT NULL,
        detail JSON,
        role TEXT NOT NULL DEFAULT 'supporting'
      )
    `);
    db.prepare(
      `INSERT INTO schema_migrations (id, name)
       VALUES (?, ?), (?, ?), (?, ?), (?, ?)`,
    ).run(1, "stamp1", 2, "stamp2", 3, "stamp3", 4, "stamp4");

    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(claim_evidence)")
      .all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain("evidence_ref_id");
    expect(cols.map((col) => col.name)).not.toContain("evidence_key");
    expect(getApplied(db).map((row) => row.id)).toEqual(
      MIGRATIONS.map((migration) => migration.id),
    );
  });

  it("replays pending migrations safely after latest-schema bootstrap", () => {
    const db = createExistingDb();
    db.exec(SCHEMA_SQL);

    runMigrations(db);

    expect(getApplied(db).map((row) => row.id)).toEqual(
      MIGRATIONS.map((migration) => migration.id),
    );
  });

  it("adds scanner watermark session_id and forces a full reparse instead of backfilling", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        target TEXT,
        started_at_ms INTEGER,
        created_at INTEGER,
        relationship_type TEXT DEFAULT '',
        scanner_file_path TEXT
      );
      CREATE TABLE scanner_file_watermarks (
        file_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        last_scanned_ms INTEGER NOT NULL,
        archived_size INTEGER DEFAULT 0
      );
    `);

    const stamp = db.prepare(
      "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
    );
    for (const migration of MIGRATIONS) {
      if (migration.id >= 14) break;
      stamp.run(migration.id, `stamp${migration.id}`);
    }

    db.exec(`
      CREATE TABLE data_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    const insertDataVersion = db.prepare(
      `INSERT INTO data_versions (component, version, updated_at_ms)
       VALUES (?, ?, ?)`,
    );
    for (const component of ALL_DATA_COMPONENTS) {
      insertDataVersion.run(component, targetDataVersion(component), 1000);
    }

    db.prepare(
      `INSERT INTO sessions (
         session_id, target, started_at_ms, created_at, relationship_type, scanner_file_path
       ) VALUES
         (?, ?, ?, ?, ?, ?),
         (?, ?, ?, ?, ?, ?),
         (?, ?, ?, ?, ?, ?)`,
    ).run(
      "root-session",
      "claude",
      100,
      100,
      "",
      "/tmp/session.jsonl",
      "root-session-fork",
      "claude",
      50,
      50,
      "fork",
      "/tmp/session.jsonl",
      "agent-1",
      "claude",
      10,
      10,
      "subagent",
      "/tmp/session.jsonl",
    );
    db.prepare(
      `INSERT INTO scanner_file_watermarks (file_path, byte_offset, last_scanned_ms)
       VALUES (?, ?, ?)`,
    ).run("/tmp/session.jsonl", 42, 1000);

    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(scanner_file_watermarks)")
      .all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain("session_id");

    const row = db
      .prepare(
        `SELECT byte_offset, archived_size, session_id
         FROM scanner_file_watermarks
         WHERE file_path = ?`,
      )
      .get("/tmp/session.jsonl") as {
      byte_offset: number;
      archived_size: number | null;
      session_id: string | null;
    };
    expect(row).toEqual({
      byte_offset: 42,
      archived_size: 0,
      session_id: null,
    });

    const dataVersions = db
      .prepare(
        `SELECT component, version
         FROM data_versions
         ORDER BY component ASC`,
      )
      .all() as Array<{ component: string; version: number }>;
    expect(dataVersions).toEqual(
      [...ALL_DATA_COMPONENTS]
        .sort((a, b) => a.localeCompare(b))
        .map((component) => ({ component, version: 0 })),
    );
  });

  it("upgrades a 0.2.10-style session summary schema to the split storage model", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE data_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        target TEXT,
        started_at_ms INTEGER,
        ended_at_ms INTEGER,
        cwd TEXT,
        first_prompt TEXT,
        permission_mode TEXT,
        agent_version TEXT,
        model TEXT,
        cli_version TEXT,
        scanner_file_path TEXT,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_cache_read_tokens INTEGER DEFAULT 0,
        total_cache_creation_tokens INTEGER DEFAULT 0,
        total_reasoning_tokens INTEGER DEFAULT 0,
        turn_count INTEGER DEFAULT 0,
        otel_input_tokens INTEGER DEFAULT 0,
        otel_output_tokens INTEGER DEFAULT 0,
        otel_cache_read_tokens INTEGER DEFAULT 0,
        otel_cache_creation_tokens INTEGER DEFAULT 0,
        models TEXT,
        has_hooks INTEGER DEFAULT 0,
        has_otel INTEGER DEFAULT 0,
        has_scanner INTEGER DEFAULT 0,
        summary TEXT,
        summary_version INTEGER DEFAULT 0,
        sync_dirty INTEGER DEFAULT 0,
        sync_seq INTEGER DEFAULT 0,
        tool_counts JSON DEFAULT '{}',
        hook_tool_counts JSON DEFAULT '{}',
        event_type_counts JSON DEFAULT '{}',
        hook_event_type_counts JSON DEFAULT '{}',
        project TEXT,
        machine TEXT NOT NULL DEFAULT 'local',
        message_count INTEGER DEFAULT 0,
        user_message_count INTEGER DEFAULT 0,
        parent_session_id TEXT,
        relationship_type TEXT DEFAULT '',
        is_automated INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE TABLE session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_summary_key TEXT NOT NULL UNIQUE,
        repository TEXT,
        cwd TEXT,
        branch TEXT,
        worktree TEXT,
        actor TEXT,
        machine TEXT NOT NULL DEFAULT 'local',
        origin_scope TEXT NOT NULL DEFAULT 'local',
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        first_intent_ts_ms INTEGER,
        last_intent_ts_ms INTEGER,
        intent_count INTEGER NOT NULL DEFAULT 0,
        edit_count INTEGER NOT NULL DEFAULT 0,
        landed_edit_count INTEGER NOT NULL DEFAULT 0,
        open_edit_count INTEGER NOT NULL DEFAULT 0,
        reconciled_at_ms INTEGER,
        reason_json TEXT
      );
      CREATE TABLE intent_session_summaries (
        intent_unit_id INTEGER NOT NULL,
        session_summary_id INTEGER NOT NULL,
        membership_kind TEXT NOT NULL,
        source TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 1.0,
        reason_json TEXT,
        UNIQUE(intent_unit_id, session_summary_id)
      );
      CREATE TABLE code_provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository TEXT NOT NULL,
        file_path TEXT NOT NULL,
        binding_level TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        snippet_hash TEXT,
        snippet_preview TEXT,
        language TEXT,
        symbol_kind TEXT,
        symbol_name TEXT,
        actor TEXT,
        machine TEXT NOT NULL DEFAULT 'local',
        origin_scope TEXT NOT NULL DEFAULT 'local',
        intent_unit_id INTEGER NOT NULL,
        intent_edit_id INTEGER,
        session_summary_id INTEGER,
        status TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        file_hash TEXT,
        established_at_ms INTEGER NOT NULL,
        verified_at_ms INTEGER NOT NULL
      );
    `);
    const stamp = db.prepare(
      "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
    );
    for (const migration of MIGRATIONS) {
      if (migration.id >= 15) break;
      stamp.run(migration.id, `stamp${migration.id}`);
    }
    const insertDataVersion = db.prepare(
      `INSERT INTO data_versions (component, version, updated_at_ms)
       VALUES (?, ?, ?)`,
    );
    for (const component of ALL_DATA_COMPONENTS) {
      if (component === SESSION_SUMMARY_PROJECTION_COMPONENT) continue;
      insertDataVersion.run(component, targetDataVersion(component), 1000);
    }
    db.prepare(
      `INSERT INTO sessions (
         session_id, target, started_at_ms, summary, summary_version,
         sync_dirty, sync_seq, machine
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "session:legacy-summary",
      "claude",
      900,
      "legacy weak summary",
      2,
      1,
      3,
      "local",
    );
    db.prepare(
      `INSERT INTO session_summaries (
         id, session_summary_key, title, status, reconciled_at_ms
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(1, "summary:test", "Old summary", "active", 1000);
    db.prepare(
      `INSERT INTO intent_session_summaries (
         intent_unit_id, session_summary_id, membership_kind, source
       ) VALUES (?, ?, ?, ?)`,
    ).run(1, 1, "primary", "heuristic");
    db.prepare(
      `INSERT INTO code_provenance (
         repository, file_path, binding_level, intent_unit_id, status,
         established_at_ms, verified_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("/tmp/repo", "/tmp/file.ts", "file", 1, "current", 1000, 1000);

    db.exec(SCHEMA_SQL);
    runMigrations(db);

    const summaryCols = db
      .prepare("PRAGMA table_info(session_summaries)")
      .all() as Array<{ name: string }>;
    expect(summaryCols.map((col) => col.name)).toContain("session_id");
    expect(summaryCols.map((col) => col.name)).toContain("summary_text");
    expect(summaryCols.map((col) => col.name)).toContain("projection_hash");
    expect(summaryCols.map((col) => col.name)).toContain("projected_at_ms");
    expect(summaryCols.map((col) => col.name)).toContain(
      "source_last_seen_at_ms",
    );
    expect(summaryCols.map((col) => col.name)).not.toContain(
      "reconciled_at_ms",
    );
    const sessionCols = db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    expect(sessionCols.map((col) => col.name)).not.toContain("summary");
    expect(sessionCols.map((col) => col.name)).not.toContain("summary_version");
    expect(
      db
        .prepare(
          `SELECT session_id, target, started_at_ms, sync_dirty, sync_seq, machine
           FROM sessions
           WHERE session_id = ?`,
        )
        .get("session:legacy-summary"),
    ).toEqual({
      session_id: "session:legacy-summary",
      target: "claude",
      started_at_ms: 900,
      sync_dirty: 1,
      sync_seq: 3,
      machine: "local",
    });

    const summaryCount = (
      db.prepare(`SELECT COUNT(*) AS count FROM session_summaries`).get() as {
        count: number;
      }
    ).count;
    const membershipCount = (
      db
        .prepare(`SELECT COUNT(*) AS count FROM intent_session_summaries`)
        .get() as { count: number }
    ).count;
    const provenanceCount = (
      db.prepare(`SELECT COUNT(*) AS count FROM code_provenance`).get() as {
        count: number;
      }
    ).count;
    expect(summaryCount).toBe(0);
    expect(membershipCount).toBe(0);
    expect(provenanceCount).toBe(0);

    const tables = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'session_summary_enrichments',
             'session_summary_search_index',
             'attempt_backoffs'
           )
         ORDER BY name ASC`,
      )
      .all() as Array<{ name: string }>;
    expect(tables).toEqual([
      { name: "attempt_backoffs" },
      { name: "session_summary_enrichments" },
      { name: "session_summary_search_index" },
    ]);

    const dataVersion = db
      .prepare(`SELECT version FROM data_versions WHERE component = ?`)
      .get(SESSION_SUMMARY_PROJECTION_COMPONENT) as { version: number };
    expect(dataVersion.version).toBe(0);
    expect(getApplied(db).map((row) => row.id)).toEqual(
      MIGRATIONS.map((migration) => migration.id),
    );
  });

  it("upgrades a 0.2.4-style DB after SCHEMA_SQL creates latest claim tables", () => {
    const db = createExistingDb();
    db.prepare(
      `INSERT INTO schema_migrations (id, name)
       VALUES (?, ?), (?, ?), (?, ?), (?, ?)`,
    ).run(1, "stamp1", 2, "stamp2", 3, "stamp3", 4, "stamp4");

    db.exec(SCHEMA_SQL);
    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(claim_evidence)")
      .all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain("evidence_ref_id");
    expect(cols.map((col) => col.name)).not.toContain("evidence_key");
    expect(getApplied(db).map((row) => row.id)).toEqual(
      MIGRATIONS.map((migration) => migration.id),
    );
  });

  it("resets derived file identity state for repo-relative path storage", () => {
    const db = createExistingDb();
    db.exec(SCHEMA_SQL);

    const stamp = db.prepare(
      "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
    );
    for (const migration of MIGRATIONS) {
      if (migration.id >= 18) break;
      stamp.run(migration.id, `stamp${migration.id}`);
    }

    const insertDataVersion = db.prepare(
      `INSERT INTO data_versions (component, version, updated_at_ms)
       VALUES (?, ?, ?)`,
    );
    for (const component of ALL_DATA_COMPONENTS) {
      insertDataVersion.run(component, targetDataVersion(component), 1000);
    }

    db.prepare(
      `INSERT INTO claims (
         id, observation_key, head_key, predicate, subject_kind, subject,
         value_kind, value_text, source_type, observed_at_ms, asserted_at_ms,
         asserter, asserter_version, machine
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "obs:1",
      "head:1",
      "file/path",
      "file",
      "file:/repo:src/index.ts",
      "text",
      "src/index.ts",
      "scanner",
      1000,
      1000,
      "intent.from_scanner",
      2,
      "local",
    );
    db.prepare(
      `INSERT INTO evidence_refs (
         id, ref_key, kind, locator_json, file_path, repository
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, "ref:1", "tool_call", "{}", "/repo/src/index.ts", "org/repo");
    db.prepare(
      `INSERT INTO evidence_ref_paths (evidence_ref_id, file_path)
       VALUES (?, ?)`,
    ).run(1, "/repo/src/index.ts");
    db.prepare(
      `INSERT INTO claim_evidence (
         claim_id, evidence_ref_id, role
       ) VALUES (?, ?, ?)`,
    ).run(1, 1, "supporting");
    db.prepare(
      `INSERT INTO active_claims (head_key, claim_id, selected_at_ms, selection_reason)
       VALUES (?, ?, ?, ?)`,
    ).run("head:1", 1, 1000, "test");
    db.prepare(
      `INSERT INTO ingestion_cursors (asserter, source, cursor_text, updated_at_ms)
       VALUES (?, ?, ?, ?)`,
    ).run("intent.from_scanner", "scanner", "cursor", 1000);
    db.prepare(
      `INSERT INTO claim_rebuild_runs (asserter, asserter_version, started_at_ms)
       VALUES (?, ?, ?)`,
    ).run("intent.from_scanner", 2, 1000);
    db.prepare(
      `INSERT INTO intent_units (
         id, intent_key, session_id, prompt_text, repository, cwd
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, "intent:1", "session:1", "edit file", "/repo", "/repo");
    db.prepare(
      `INSERT INTO intent_edits (
         id, edit_key, intent_unit_id, session_id, file_path
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(1, "edit:1", 1, "session:1", "src/index.ts");
    db.prepare(
      `INSERT INTO session_summaries (
         id, session_summary_key, session_id, repository, cwd, title, status,
         projection_hash, projected_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "ss:local:session:1",
      "session:1",
      "/repo",
      "/repo",
      "title",
      "active",
      "hash",
      1000,
    );
    db.prepare(
      `INSERT INTO session_summary_enrichments (
         session_summary_key, session_id, summary_text, summary_source,
         dirty, last_material_change_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("ss:local:session:1", "session:1", "stale llm", "llm", 1, 1000);
    db.prepare(
      `INSERT INTO session_summary_search_index (
         session_summary_key, session_id, corpus_key, source, priority,
         search_text, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ss:local:session:1",
      "session:1",
      "deterministic_summary",
      "deterministic",
      10,
      "summary text",
      1000,
    );
    db.prepare(
      `INSERT INTO intent_session_summaries (
         intent_unit_id, session_summary_id, membership_kind, source, score
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(1, 1, "primary", "heuristic", 1);
    db.prepare(
      `INSERT INTO code_provenance (
         repository, file_path, binding_level, intent_unit_id, session_summary_id,
         status, established_at_ms, verified_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("/repo", "src/index.ts", "file", 1, 1, "current", 1000, 1000);
    db.prepare(
      `INSERT INTO attempt_backoffs (
         scope_kind, scope_key, failure_count, updated_at_ms
       ) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    ).run(
      "session-summary-row",
      "ss:local:session:1",
      2,
      1000,
      "sync-target",
      "local",
      1,
      1000,
    );

    runMigrations(db);

    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM claims) AS claims,
           (SELECT COUNT(*) FROM evidence_refs) AS evidence_refs,
           (SELECT COUNT(*) FROM evidence_ref_paths) AS evidence_ref_paths,
           (SELECT COUNT(*) FROM claim_evidence) AS claim_evidence,
           (SELECT COUNT(*) FROM active_claims) AS active_claims,
           (SELECT COUNT(*) FROM ingestion_cursors) AS ingestion_cursors,
           (SELECT COUNT(*) FROM claim_rebuild_runs) AS claim_rebuild_runs,
           (SELECT COUNT(*) FROM intent_units) AS intent_units,
           (SELECT COUNT(*) FROM intent_edits) AS intent_edits,
           (SELECT COUNT(*) FROM session_summaries) AS session_summaries,
           (SELECT COUNT(*) FROM session_summary_enrichments) AS session_summary_enrichments,
           (SELECT COUNT(*) FROM session_summary_search_index) AS session_summary_search_index,
           (SELECT COUNT(*) FROM intent_session_summaries) AS intent_session_summaries,
           (SELECT COUNT(*) FROM code_provenance) AS code_provenance`,
      )
      .get() as Record<string, number>;

    expect(counts).toEqual({
      claims: 0,
      evidence_refs: 0,
      evidence_ref_paths: 0,
      claim_evidence: 0,
      active_claims: 0,
      ingestion_cursors: 0,
      claim_rebuild_runs: 0,
      intent_units: 0,
      intent_edits: 0,
      session_summaries: 0,
      session_summary_enrichments: 1,
      session_summary_search_index: 0,
      intent_session_summaries: 0,
      code_provenance: 0,
    });

    const preservedEnrichment = db
      .prepare(
        `SELECT session_summary_key, session_id, summary_text, summary_source, dirty
         FROM session_summary_enrichments`,
      )
      .get() as
      | {
          session_summary_key: string;
          session_id: string;
          summary_text: string | null;
          summary_source: string | null;
          dirty: number;
        }
      | undefined;
    expect(preservedEnrichment).toEqual({
      session_summary_key: "ss:local:session:1",
      session_id: "session:1",
      summary_text: "stale llm",
      summary_source: "llm",
      dirty: 1,
    });

    const backoffs = db
      .prepare(
        `SELECT scope_kind, scope_key
         FROM attempt_backoffs
         ORDER BY scope_kind ASC, scope_key ASC`,
      )
      .all() as Array<{ scope_kind: string; scope_key: string }>;
    expect(backoffs).toEqual([
      { scope_kind: "sync-target", scope_key: "local" },
    ]);

    const dataVersions = db
      .prepare(
        `SELECT component, version
         FROM data_versions
         ORDER BY component ASC`,
      )
      .all() as Array<{ component: string; version: number }>;
    const versionByComponent = new Map(
      dataVersions.map((row) => [row.component, row.version]),
    );
    for (const component of CLAIM_DERIVED_COMPONENTS) {
      expect(versionByComponent.get(component)).toBe(0);
    }
    expect(versionByComponent.get("scanner.raw")).toBe(
      targetDataVersion("scanner.raw"),
    );
    expect(getApplied(db).map((row) => row.id)).toEqual(
      MIGRATIONS.map((migration) => migration.id),
    );
  });

  it("upgrades a 0.1.9-style DB with old user_config schema and no claim tables", () => {
    const db = createExistingDb();
    db.exec(`
      CREATE TABLE user_config_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_name TEXT NOT NULL,
        snapshot_at_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        permissions JSON NOT NULL DEFAULT '{}',
        enabled_plugins JSON NOT NULL DEFAULT '[]',
        hooks JSON NOT NULL DEFAULT '[]',
        commands JSON NOT NULL DEFAULT '[]',
        rules JSON NOT NULL DEFAULT '[]',
        skills JSON NOT NULL DEFAULT '[]',
        plugin_hooks JSON NOT NULL DEFAULT '[]'
      )
    `);
    db.prepare(
      `INSERT INTO schema_migrations (id, name)
       VALUES (?, ?), (?, ?)`,
    ).run(1, "stamp1", 2, "stamp2");

    db.exec(SCHEMA_SQL);
    runMigrations(db);

    const userConfigCols = db
      .prepare("PRAGMA table_info(user_config_snapshots)")
      .all() as Array<{ name: string }>;
    expect(userConfigCols.map((col) => col.name)).toContain(
      "panopticon_allowed",
    );
    expect(userConfigCols.map((col) => col.name)).toContain(
      "panopticon_approvals",
    );
    expect(userConfigCols.map((col) => col.name)).toContain("memory_files");

    const claimEvidenceCols = db
      .prepare("PRAGMA table_info(claim_evidence)")
      .all() as Array<{ name: string }>;
    expect(claimEvidenceCols.map((col) => col.name)).toContain(
      "evidence_ref_id",
    );
    expect(claimEvidenceCols.map((col) => col.name)).not.toContain(
      "evidence_key",
    );
    expect(getApplied(db).map((row) => row.id)).toEqual(
      MIGRATIONS.map((migration) => migration.id),
    );
  });

  it("runs up() function migration", () => {
    const db = createExistingDb();
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)");

    const migrations: Migration[] = [
      {
        id: 1,
        name: "backfill_items",
        up: (d) => {
          d.exec("INSERT INTO items (val) VALUES ('hello')");
          d.exec("INSERT INTO items (val) VALUES ('world')");
        },
      },
    ];

    runMigrations(db, migrations);

    const rows = db
      .prepare("SELECT val FROM items ORDER BY id")
      .all() as Array<{
      val: string;
    }>;
    expect(rows).toEqual([{ val: "hello" }, { val: "world" }]);
    expect(getApplied(db)).toHaveLength(1);
  });

  it("runs multiple migrations in order", () => {
    const db = createExistingDb();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");

    const migrations: Migration[] = [
      { id: 1, name: "add_col_a", sql: "ALTER TABLE t ADD COLUMN a TEXT" },
      { id: 2, name: "add_col_b", sql: "ALTER TABLE t ADD COLUMN b TEXT" },
      {
        id: 3,
        name: "backfill",
        up: (d) => {
          // Depends on columns from migrations 1 and 2
          d.exec("INSERT INTO t (a, b) VALUES ('x', 'y')");
        },
      },
    ];

    runMigrations(db, migrations);

    const row = db.prepare("SELECT a, b FROM t").get() as {
      a: string;
      b: string;
    };
    expect(row).toEqual({ a: "x", b: "y" });
    expect(getApplied(db)).toHaveLength(3);
  });

  it("skips already-applied migrations", () => {
    const db = createExistingDb();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)");
    db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(
      1,
      "add_col_a",
    );

    const spy = vi.fn();
    const migrations: Migration[] = [
      { id: 1, name: "add_col_a", sql: "THIS WOULD FAIL IF RUN" },
      { id: 2, name: "second", up: spy },
    ];

    runMigrations(db, migrations);

    // Migration 1 was skipped, migration 2 ran
    expect(spy).toHaveBeenCalledOnce();
    const applied = getApplied(db);
    expect(applied).toHaveLength(2);
    expect(applied.map((r) => r.id)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe("runMigrations — error handling", () => {
  it("rolls back failed sql migration without recording it", () => {
    const db = createExistingDb();
    // Don't create the target table — ALTER TABLE will fail

    expect(() => runMigrations(db)).toThrow();
    expect(getApplied(db)).toHaveLength(0);
  });

  it("rolls back failed up() migration without recording it", () => {
    const db = createExistingDb();

    const migrations: Migration[] = [
      {
        id: 1,
        name: "will_fail",
        up: (d) => {
          d.exec("CREATE TABLE new_table (id INTEGER PRIMARY KEY)");
          d.exec("INVALID SQL THAT WILL FAIL");
        },
      },
    ];

    expect(() => runMigrations(db, migrations)).toThrow();

    // Transaction rolled back — table should not exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='new_table'",
      )
      .get();
    expect(tables).toBeUndefined();
    expect(getApplied(db)).toHaveLength(0);
  });

  it("applies earlier migrations even if a later one fails", () => {
    const db = createExistingDb();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");

    const migrations: Migration[] = [
      { id: 1, name: "good", sql: "ALTER TABLE t ADD COLUMN a TEXT" },
      { id: 2, name: "bad", sql: "ALTER TABLE nonexistent ADD COLUMN x TEXT" },
    ];

    expect(() => runMigrations(db, migrations)).toThrow();

    // Migration 1 committed, migration 2 rolled back
    const applied = getApplied(db);
    expect(applied).toHaveLength(1);
    expect(applied[0].id).toBe(1);

    // Column from migration 1 exists
    const cols = db.prepare("PRAGMA table_info(t)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("a");
  });
});

// ---------------------------------------------------------------------------
// Tests: idempotency
// ---------------------------------------------------------------------------

describe("runMigrations — idempotency", () => {
  it("calling twice on a fresh DB is safe", () => {
    const db = createDb();
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    runMigrations(db);

    expect(getApplied(db)).toHaveLength(MIGRATIONS.length);
  });

  it("calling twice on an existing DB is safe", () => {
    const db = createExistingDb();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");

    const spy = vi.fn((d: Database) => {
      d.exec("ALTER TABLE t ADD COLUMN a TEXT");
    });
    const migrations: Migration[] = [{ id: 1, name: "once", up: spy }];

    runMigrations(db, migrations);
    runMigrations(db, migrations);

    expect(spy).toHaveBeenCalledOnce();
    expect(getApplied(db)).toHaveLength(1);
  });

  it("handles empty migrations array", () => {
    const db = createDb();
    runMigrations(db, []);
    expect(getApplied(db)).toHaveLength(0);
  });
});
