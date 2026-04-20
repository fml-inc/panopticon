/**
 * Schema migration system for panopticon's embedded SQLite database.
 *
 * ## Conventions
 *
 * 1. SCHEMA_SQL in schema.ts is ALWAYS the latest desired schema.
 *    It uses CREATE TABLE IF NOT EXISTS, making it idempotent.
 *
 * 2. When adding a column: update the CREATE TABLE in SCHEMA_SQL
 *    AND add a migration here with ALTER TABLE ADD COLUMN.
 *    Both must exist. SCHEMA_SQL handles fresh DBs; migrations
 *    handle existing DBs.
 *
 * 3. When adding a new table: add it to SCHEMA_SQL. No migration
 *    needed (CREATE TABLE IF NOT EXISTS handles it).
 *
 * 4. When adding an index: add it to SCHEMA_SQL. No migration
 *    needed (CREATE INDEX IF NOT EXISTS handles it).
 *
 * 5. For complex changes (data backfill, column rename via rebuild,
 *    virtual table recreation): add an `up` function migration.
 *    Update SCHEMA_SQL to reflect the final state.
 *
 * 6. Never reorder or remove migrations. Only append.
 *
 * 7. Migration IDs are sequential integers starting from 1.
 *
 * 8. No down migrations. This is an embedded app — users always
 *    upgrade forward. Rolling back means reinstalling.
 */

import type { Database } from "./driver.js";
import {
  buildMessageSyncId,
  buildScannerEventSyncId,
  buildScannerTurnSyncId,
  buildToolCallSyncId,
} from "./sync-ids.js";

export interface Migration {
  id: number;
  name: string;
  /** Simple migrations: single SQL statement. */
  sql?: string;
  /** Complex migrations: function that receives the db handle. */
  up?: (db: Database) => void;
}

function backfillScannerEventSyncIds(db: Database): void {
  const eventRows = db
    .prepare(
      `SELECT id, session_id, source
       FROM scanner_events
       ORDER BY session_id, source, id`,
    )
    .all() as Array<{
    id: number;
    session_id: string;
    source: string;
  }>;

  const updateEvent = db.prepare(
    "UPDATE scanner_events SET sync_id = ? WHERE id = ?",
  );

  let currentSessionId: string | null = null;
  let currentSource: string | null = null;
  let eventIndex = 0;
  for (const row of eventRows) {
    if (row.session_id !== currentSessionId || row.source !== currentSource) {
      currentSessionId = row.session_id;
      currentSource = row.source;
      eventIndex = 0;
    }
    updateEvent.run(
      buildScannerEventSyncId(row.session_id, row.source, eventIndex),
      row.id,
    );
    eventIndex += 1;
  }
}

function rebuildScannerEventsWithEventIndex(db: Database): void {
  const scannerEventsTableExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scanner_events'",
    )
    .get();
  if (!scannerEventsTableExists) return;

  const eventCols = db
    .prepare("PRAGMA table_info(scanner_events)")
    .all() as Array<{
    name: string;
  }>;
  const hasEventIndex = eventCols.some((col) => col.name === "event_index");
  if (hasEventIndex) {
    backfillScannerEventSyncIds(db);
    return;
  }

  db.exec(`
    CREATE TABLE scanner_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      content TEXT,
      metadata JSON,
      sync_id TEXT NOT NULL,
      UNIQUE(session_id, source, event_index)
    )
  `);

  const rows = db
    .prepare(
      `SELECT id, session_id, source, event_type, timestamp_ms, tool_name,
              tool_input, tool_output, content, metadata
       FROM scanner_events
       ORDER BY session_id, source, id`,
    )
    .all() as Array<{
    id: number;
    session_id: string;
    source: string;
    event_type: string;
    timestamp_ms: number;
    tool_name: string | null;
    tool_input: string | null;
    tool_output: string | null;
    content: string | null;
    metadata: string | null;
  }>;

  const insert = db.prepare(
    `INSERT INTO scanner_events_new
       (id, session_id, source, event_index, event_type, timestamp_ms, tool_name,
        tool_input, tool_output, content, metadata, sync_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let currentSessionId: string | null = null;
  let currentSource: string | null = null;
  let eventIndex = 0;
  for (const row of rows) {
    if (row.session_id !== currentSessionId || row.source !== currentSource) {
      currentSessionId = row.session_id;
      currentSource = row.source;
      eventIndex = 0;
    }
    insert.run(
      row.id,
      row.session_id,
      row.source,
      eventIndex,
      row.event_type,
      row.timestamp_ms,
      row.tool_name,
      row.tool_input,
      row.tool_output,
      row.content,
      row.metadata,
      buildScannerEventSyncId(row.session_id, row.source, eventIndex),
    );
    eventIndex += 1;
  }

  db.exec("DROP TABLE scanner_events");
  db.exec("ALTER TABLE scanner_events_new RENAME TO scanner_events");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_scanner_events_session ON scanner_events(session_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_scanner_events_type ON scanner_events(event_type)",
  );
}

// ---------------------------------------------------------------------------
// Migration registry — append only, never reorder or remove
// ---------------------------------------------------------------------------

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "add_plugin_hooks_to_user_config",
    sql: "ALTER TABLE user_config_snapshots ADD COLUMN plugin_hooks JSON NOT NULL DEFAULT '[]'",
  },
  {
    id: 2,
    name: "remove_sessions_sync_watermark",
    up: (db) => {
      // sync_seq is per-session, not globally monotonic — the old watermark
      // was poisoned by a long-running session. Sessions now sync by
      // comparing against target_session_sync instead of a global cursor.
      const exists = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='watermarks'",
        )
        .get();
      if (exists) {
        db.exec("DELETE FROM watermarks WHERE key LIKE 'sessions:%'");
      }
    },
  },
  {
    id: 3,
    name: "drop_session_summary_deltas",
    // #115 (Apr 2) replaced delta summaries with a single sessions.summary
    // column but left the table in the schema and never wrote to it. The
    // prune/MCP/e2e references have been cleaned up; this migration removes
    // the dead table for DBs that were created before the rewrite.
    sql: "DROP TABLE IF EXISTS session_summary_deltas",
  },
  {
    id: 4,
    name: "add_panopticon_perms_and_memory_to_user_config",
    // Track panopticon's own allowlist/approvals and Claude Code memory files
    // inside user_config_snapshots so sync captures their history.
    up: (db) => {
      db.exec(
        "ALTER TABLE user_config_snapshots ADD COLUMN panopticon_allowed JSON NOT NULL DEFAULT 'null'",
      );
      db.exec(
        "ALTER TABLE user_config_snapshots ADD COLUMN panopticon_approvals JSON NOT NULL DEFAULT 'null'",
      );
      db.exec(
        "ALTER TABLE user_config_snapshots ADD COLUMN memory_files JSON NOT NULL DEFAULT '{}'",
      );
    },
  },
  {
    id: 5,
    name: "add_claims_and_intent_index_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS claims (
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
          asserter_version TEXT NOT NULL,
          machine TEXT NOT NULL DEFAULT 'local',
          sync_id TEXT DEFAULT (hex(randomblob(8)))
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS claim_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          claim_id INTEGER NOT NULL,
          evidence_key TEXT NOT NULL,
          detail JSON,
          role TEXT NOT NULL DEFAULT 'supporting'
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS active_claims (
          head_key TEXT PRIMARY KEY,
          claim_id INTEGER NOT NULL,
          selected_at_ms INTEGER NOT NULL,
          selection_reason TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS ingestion_cursors (
          asserter TEXT NOT NULL,
          source TEXT NOT NULL,
          cursor_text TEXT NOT NULL DEFAULT '',
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (asserter, source)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS claim_rebuild_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asserter TEXT NOT NULL,
          asserter_version TEXT NOT NULL,
          started_at_ms INTEGER NOT NULL,
          finished_at_ms INTEGER,
          rows_emitted INTEGER NOT NULL DEFAULT 0,
          scope JSON
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS intent_units (
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
        )
      `);
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS intent_units_fts USING fts5(
          prompt_text,
          content='',
          contentless_delete=1,
          tokenize='trigram'
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS intent_edits (
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
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_claims_head ON claims(head_key)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_claims_predicate_subject ON claims(predicate, subject_kind, subject)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_claims_observed ON claims(observed_at_ms)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_claims_asserter ON claims(asserter, observed_at_ms)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim ON claim_evidence(claim_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_claim_evidence_key ON claim_evidence(evidence_key)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_active_claims_claim ON active_claims(claim_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_intent_units_session ON intent_units(session_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_intent_units_repo ON intent_units(repository)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_intent_units_prompt_ts ON intent_units(prompt_ts_ms)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_intent_edits_unit ON intent_edits(intent_unit_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_intent_edits_session ON intent_edits(session_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_intent_edits_file ON intent_edits(file_path)",
      );
    },
  },
  {
    id: 6,
    name: "add_messages_sync_id",
    up: (db) => {
      const messagesTableExists = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'",
        )
        .get();
      if (!messagesTableExists) return;

      const hasSyncId = (
        db.prepare("PRAGMA table_info(messages)").all() as Array<{
          name: string;
        }>
      ).some((col) => col.name === "sync_id");
      if (!hasSyncId) {
        db.exec("ALTER TABLE messages ADD COLUMN sync_id TEXT");
      }

      const rows = db
        .prepare("SELECT id, session_id, ordinal, uuid FROM messages")
        .all() as Array<{
        id: number;
        session_id: string;
        ordinal: number;
        uuid: string | null;
      }>;

      const update = db.prepare("UPDATE messages SET sync_id = ? WHERE id = ?");
      for (const row of rows) {
        update.run(
          buildMessageSyncId(row.session_id, row.ordinal, row.uuid),
          row.id,
        );
      }
    },
  },
  {
    id: 7,
    name: "add_tool_calls_call_index_and_durable_sync_id",
    up: (db) => {
      const toolCallsTableExists = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_calls'",
        )
        .get();
      if (!toolCallsTableExists) return;

      const toolCallCols = db
        .prepare("PRAGMA table_info(tool_calls)")
        .all() as Array<{
        name: string;
      }>;
      const hasCallIndex = toolCallCols.some(
        (col) => col.name === "call_index",
      );
      if (!hasCallIndex) {
        db.exec(
          "ALTER TABLE tool_calls ADD COLUMN call_index INTEGER NOT NULL DEFAULT 0",
        );
      }

      const rows = db
        .prepare(
          `SELECT tc.id, tc.message_id, tc.tool_use_id, m.sync_id as message_sync_id
           FROM tool_calls tc
           LEFT JOIN messages m ON m.id = tc.message_id
           ORDER BY tc.message_id, tc.id`,
        )
        .all() as Array<{
        id: number;
        message_id: number;
        tool_use_id: string | null;
        message_sync_id: string | null;
      }>;

      const update = db.prepare(
        "UPDATE tool_calls SET call_index = ?, sync_id = ? WHERE id = ?",
      );
      let currentMessageId: number | null = null;
      let callIndex = 0;
      for (const row of rows) {
        if (row.message_id !== currentMessageId) {
          currentMessageId = row.message_id;
          callIndex = 0;
        }
        const messageSyncId =
          row.message_sync_id || `orphan-msg|${row.message_id}`;
        update.run(
          callIndex,
          buildToolCallSyncId(messageSyncId, callIndex, row.tool_use_id),
          row.id,
        );
        callIndex += 1;
      }
    },
  },
  {
    id: 8,
    name: "backfill_scanner_turn_and_event_sync_ids",
    up: (db) => {
      const scannerTurnsTableExists = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scanner_turns'",
        )
        .get();
      if (scannerTurnsTableExists) {
        const turnCols = db
          .prepare("PRAGMA table_info(scanner_turns)")
          .all() as Array<{
          name: string;
        }>;
        const hasTurnSyncId = turnCols.some((col) => col.name === "sync_id");
        if (!hasTurnSyncId) {
          db.exec("ALTER TABLE scanner_turns ADD COLUMN sync_id TEXT");
        }

        const turnRows = db
          .prepare(
            "SELECT id, session_id, source, turn_index FROM scanner_turns",
          )
          .all() as Array<{
          id: number;
          session_id: string;
          source: string;
          turn_index: number;
        }>;

        const updateTurn = db.prepare(
          "UPDATE scanner_turns SET sync_id = ? WHERE id = ?",
        );
        for (const row of turnRows) {
          updateTurn.run(
            buildScannerTurnSyncId(row.session_id, row.source, row.turn_index),
            row.id,
          );
        }
      }

      const scannerEventsTableExists = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scanner_events'",
        )
        .get();
      if (!scannerEventsTableExists) return;

      const eventCols = db
        .prepare("PRAGMA table_info(scanner_events)")
        .all() as Array<{
        name: string;
      }>;
      const hasEventSyncId = eventCols.some((col) => col.name === "sync_id");
      if (!hasEventSyncId) {
        db.exec("ALTER TABLE scanner_events ADD COLUMN sync_id TEXT");
      }
      backfillScannerEventSyncIds(db);
    },
  },
  {
    id: 9,
    name: "rebuild_scanner_events_with_event_index",
    up: (db) => {
      rebuildScannerEventsWithEventIndex(db);
    },
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Apply pending schema migrations to the database.
 *
 * On a fresh database (where SCHEMA_SQL just created all tables with all
 * columns), the `schema_migrations` table won't exist yet. In that case
 * we stamp all migrations as applied without executing them — SCHEMA_SQL
 * already reflects the final state.
 *
 * On an existing database, unapplied migrations run sequentially inside
 * transactions.
 */
export function runMigrations(
  db: Database,
  migrations: Migration[] = MIGRATIONS,
): void {
  const trackingExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  if (!trackingExists) {
    // No tracking table could mean:
    //   a) Truly fresh DB — SCHEMA_SQL just created all tables with all columns
    //   b) Pre-migration-system DB — tables existed before migrations were added,
    //      and CREATE TABLE IF NOT EXISTS didn't add new columns
    //
    // Distinguish by checking for existing data. A fresh DB has no rows yet.
    let hasData = false;
    try {
      hasData = !!db.prepare("SELECT 1 FROM sessions LIMIT 1").get();
    } catch {
      // sessions table doesn't exist — definitely a fresh/test DB
    }

    if (!hasData) {
      // Fresh database: SCHEMA_SQL already created everything.
      // Stamp all migrations as applied without executing them.
      const stamp = db.prepare(
        "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
      );
      for (const m of migrations) {
        stamp.run(m.id, m.name);
      }
      return;
    }
    // Pre-migration-system DB: fall through to run migrations normally
  }

  // Existing database: run unapplied migrations sequentially
  const applied = new Set(
    (
      db.prepare("SELECT id FROM schema_migrations").all() as Array<{
        id: number;
      }>
    ).map((r) => r.id),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const run = db.transaction(() => {
      if (migration.sql) {
        db.exec(migration.sql);
      } else if (migration.up) {
        migration.up(db);
      }
      db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(
        migration.id,
        migration.name,
      );
    });
    run();
  }
}
