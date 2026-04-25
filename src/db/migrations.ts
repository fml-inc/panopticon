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
 * 5a. Because boot runs SCHEMA_SQL before runMigrations(), any migration
 *    that touches a table which SCHEMA_SQL may already have created must be
 *    safe against the latest schema shape. Guard ALTER TABLE and legacy
 *    indexes with schema checks instead of assuming historical columns exist.
 *
 * 6. Never reorder or remove migrations. Only append.
 *
 * 7. Migration IDs are sequential integers starting from 1.
 *
 * 8. No down migrations. This is an embedded app — users always
 *    upgrade forward. Rolling back means reinstalling.
 */

import {
  ALL_DATA_COMPONENTS,
  CLAIM_DERIVED_COMPONENTS,
  ensureDataVersionsTable,
  markDataComponentsStaleInDb,
  SESSION_SUMMARY_PROJECTION_COMPONENT,
} from "./data-versions.js";
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

function tableExists(db: Database, table: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).some((col) => col.name === column);
}

function tableHasRows(db: Database, table: string): boolean {
  if (!tableExists(db, table)) return false;
  return !!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
}

function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  columnSql: string,
): void {
  if (tableHasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
}

function createIndexIfColumnsExist(
  db: Database,
  table: string,
  columns: string[],
  sql: string,
): void {
  if (!columns.every((column) => tableHasColumn(db, table, column))) return;
  db.exec(sql);
}

function ensureEvidenceRefSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      session_id TEXT,
      sync_id TEXT,
      repository TEXT,
      file_path TEXT,
      trace_id TEXT,
      span_id TEXT,
      locator_json TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_ref_paths (
      evidence_ref_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      UNIQUE(evidence_ref_id, file_path)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_evidence_refs_session ON evidence_refs(session_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_evidence_refs_kind_sync ON evidence_refs(kind, sync_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_evidence_refs_trace_span ON evidence_refs(trace_id, span_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_evidence_refs_file ON evidence_refs(file_path)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_evidence_ref_paths_ref ON evidence_ref_paths(evidence_ref_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_evidence_ref_paths_file ON evidence_ref_paths(file_path)",
  );
}

function rebuildClaimEvidenceWithRefsOnly(db: Database): void {
  if (tableExists(db, "claim_evidence")) {
    db.exec("DROP TABLE claim_evidence");
  }
  db.exec(`
    CREATE TABLE claim_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id INTEGER NOT NULL,
      evidence_ref_id INTEGER NOT NULL,
      detail JSON,
      role TEXT NOT NULL DEFAULT 'supporting'
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim ON claim_evidence(claim_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_claim_evidence_ref ON claim_evidence(evidence_ref_id)",
  );
}

function rebuildClaimTablesWithIntegerAsserterVersions(db: Database): void {
  if (tableExists(db, "claims")) {
    db.exec("DROP TABLE claims");
  }
  db.exec(`
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

  if (tableExists(db, "active_claims")) {
    db.exec("DROP TABLE active_claims");
  }
  db.exec(`
    CREATE TABLE active_claims (
      head_key TEXT PRIMARY KEY,
      claim_id INTEGER NOT NULL,
      selected_at_ms INTEGER NOT NULL,
      selection_reason TEXT NOT NULL
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_active_claims_claim ON active_claims(claim_id)",
  );

  if (tableExists(db, "claim_rebuild_runs")) {
    db.exec("DROP TABLE claim_rebuild_runs");
  }
  db.exec(`
    CREATE TABLE claim_rebuild_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asserter TEXT NOT NULL,
      asserter_version INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      rows_emitted INTEGER NOT NULL DEFAULT 0,
      scope JSON
    )
  `);
}

function deleteAllRowsIfTableExists(db: Database, table: string): void {
  if (!tableExists(db, table)) return;
  db.exec(`DELETE FROM ${table}`);
}

function resetDerivedStateForEvidenceRefCutover(db: Database): void {
  ensureEvidenceRefSchema(db);
  ensureDataVersionsTable(db);
  rebuildClaimEvidenceWithRefsOnly(db);

  // Claim/projection tables are disposable derived state. Rebuild them from
  // raw scanner session files plus preserved hook/OTel tables after reparse.
  deleteAllRowsIfTableExists(db, "code_provenance");
  deleteAllRowsIfTableExists(db, "intent_session_summaries");
  deleteAllRowsIfTableExists(db, "session_summaries");
  deleteAllRowsIfTableExists(db, "intent_edits");
  deleteAllRowsIfTableExists(db, "intent_units_fts");
  deleteAllRowsIfTableExists(db, "intent_units");
  deleteAllRowsIfTableExists(db, "active_claims");
  deleteAllRowsIfTableExists(db, "claims");
  deleteAllRowsIfTableExists(db, "evidence_ref_paths");
  deleteAllRowsIfTableExists(db, "evidence_refs");
  deleteAllRowsIfTableExists(db, "ingestion_cursors");
  deleteAllRowsIfTableExists(db, "claim_rebuild_runs");

  // Force the startup scanner loop to rebuild from raw data after upgrade.
  markDataComponentsStaleInDb(db, ALL_DATA_COMPONENTS);
}

function resetClaimDerivedStateForAsserterVersionIntegerCutover(
  db: Database,
): void {
  ensureEvidenceRefSchema(db);
  ensureDataVersionsTable(db);
  rebuildClaimEvidenceWithRefsOnly(db);
  rebuildClaimTablesWithIntegerAsserterVersions(db);

  deleteAllRowsIfTableExists(db, "code_provenance");
  deleteAllRowsIfTableExists(db, "intent_session_summaries");
  deleteAllRowsIfTableExists(db, "session_summaries");
  deleteAllRowsIfTableExists(db, "intent_edits");
  deleteAllRowsIfTableExists(db, "intent_units_fts");
  deleteAllRowsIfTableExists(db, "intent_units");
  deleteAllRowsIfTableExists(db, "evidence_ref_paths");
  deleteAllRowsIfTableExists(db, "evidence_refs");
  deleteAllRowsIfTableExists(db, "ingestion_cursors");
  deleteAllRowsIfTableExists(db, "claim_rebuild_runs");

  markDataComponentsStaleInDb(db, CLAIM_DERIVED_COMPONENTS);
}

function addScannerFileWatermarkSessionIdAndForceReparse(db: Database): void {
  if (!tableExists(db, "scanner_file_watermarks")) {
    return;
  }

  addColumnIfMissing(
    db,
    "scanner_file_watermarks",
    "session_id",
    "session_id TEXT",
  );

  if (!tableHasRows(db, "scanner_file_watermarks")) {
    return;
  }

  ensureDataVersionsTable(db);
  // Let startup rebuild scanner state from raw files instead of trying to
  // infer watermark session IDs from possibly incomplete historical rows.
  markDataComponentsStaleInDb(db, ALL_DATA_COMPONENTS);
}

function resetSessionSummaryProjectionStorage(db: Database): void {
  if (tableExists(db, "code_provenance")) {
    db.exec("DROP TABLE code_provenance");
  }
  if (tableExists(db, "intent_session_summaries")) {
    db.exec("DROP TABLE intent_session_summaries");
  }
  if (tableExists(db, "session_summary_search_index")) {
    db.exec("DROP TABLE session_summary_search_index");
  }
  if (tableExists(db, "session_summary_enrichments")) {
    db.exec("DROP TABLE session_summary_enrichments");
  }
  if (tableExists(db, "session_summaries")) {
    db.exec("DROP TABLE session_summaries");
  }

  db.exec(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_summary_key TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
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
      summary_text TEXT,
      projection_hash TEXT NOT NULL,
      projected_at_ms INTEGER NOT NULL,
      source_last_seen_at_ms INTEGER,
      reason_json TEXT
    )
  `);
  db.exec(`
    CREATE TABLE session_summary_enrichments (
      session_summary_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      summary_text TEXT,
      summary_source TEXT NOT NULL DEFAULT 'deterministic',
      summary_runner TEXT,
      summary_model TEXT,
      summary_version INTEGER NOT NULL DEFAULT 1,
      summary_generated_at_ms INTEGER,
      projection_hash TEXT,
      summary_input_hash TEXT,
      summary_policy_hash TEXT,
      enriched_input_hash TEXT,
      enriched_message_count INTEGER,
      dirty INTEGER NOT NULL DEFAULT 1,
      dirty_reason_json TEXT,
      last_material_change_at_ms INTEGER,
      last_attempted_at_ms INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `);
  db.exec(`
    CREATE TABLE session_summary_search_index (
      session_summary_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      corpus_key TEXT NOT NULL,
      source TEXT NOT NULL,
      priority INTEGER NOT NULL,
      search_text TEXT NOT NULL,
      dirty INTEGER NOT NULL DEFAULT 0,
      projection_hash TEXT,
      enriched_input_hash TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_summary_key, corpus_key)
    )
  `);
  db.exec(`
    CREATE TABLE intent_session_summaries (
      intent_unit_id INTEGER NOT NULL,
      session_summary_id INTEGER NOT NULL,
      membership_kind TEXT NOT NULL,
      source TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 1.0,
      reason_json TEXT,
      UNIQUE(intent_unit_id, session_summary_id)
    )
  `);
  db.exec(`
    CREATE TABLE code_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository TEXT NOT NULL DEFAULT '',
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
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summaries_repo
      ON session_summaries(repository)
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_summaries_session
      ON session_summaries(session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summaries_status
      ON session_summaries(status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summaries_last_ts
      ON session_summaries(last_intent_ts_ms)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summary_enrichments_dirty
      ON session_summary_enrichments(dirty, last_material_change_at_ms)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summary_enrichments_session
      ON session_summary_enrichments(session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summary_search_index_session
      ON session_summary_search_index(session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summary_search_index_source_priority
      ON session_summary_search_index(source, priority)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_intent_session_summaries_intent
      ON intent_session_summaries(intent_unit_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_intent_session_summaries_session_summary
      ON intent_session_summaries(session_summary_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_code_provenance_repo_file
      ON code_provenance(repository, file_path)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_code_provenance_session_summary
      ON code_provenance(session_summary_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_code_provenance_intent
      ON code_provenance(intent_unit_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_code_provenance_status
      ON code_provenance(status)
  `);

  ensureDataVersionsTable(db);
  markDataComponentsStaleInDb(db, [SESSION_SUMMARY_PROJECTION_COMPONENT]);
}

function rebuildSessionsTableWithoutLegacySummary(db: Database): void {
  if (!tableExists(db, "sessions")) return;
  if (
    !tableHasColumn(db, "sessions", "summary") &&
    !tableHasColumn(db, "sessions", "summary_version")
  ) {
    return;
  }

  // One-time unreleased-branch cleanup: released v0.2.10 still has the legacy
  // sessions.summary columns, but none of the intermediate PR-only summary
  // table shapes shipped, so we rebuild directly to the final sessions schema.
  const sessionValueExpr = (column: string, fallbackSql = "NULL"): string => {
    return tableHasColumn(db, "sessions", column) ? column : fallbackSql;
  };

  db.exec(`
    CREATE TABLE sessions_new (
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
    )
  `);

  db.exec(`
    INSERT INTO sessions_new (
      session_id, target, started_at_ms, ended_at_ms, cwd, first_prompt,
      permission_mode, agent_version, model, cli_version, scanner_file_path,
      total_input_tokens, total_output_tokens, total_cache_read_tokens,
      total_cache_creation_tokens, total_reasoning_tokens, turn_count,
      otel_input_tokens, otel_output_tokens, otel_cache_read_tokens,
      otel_cache_creation_tokens, models, has_hooks, has_otel, has_scanner,
      sync_dirty, sync_seq, tool_counts, hook_tool_counts, event_type_counts,
      hook_event_type_counts, project, machine, message_count,
      user_message_count, parent_session_id, relationship_type, is_automated,
      created_at
    )
    SELECT
      ${sessionValueExpr("session_id")},
      ${sessionValueExpr("target")},
      ${sessionValueExpr("started_at_ms", "NULL")},
      ${sessionValueExpr("ended_at_ms", "NULL")},
      ${sessionValueExpr("cwd")},
      ${sessionValueExpr("first_prompt")},
      ${sessionValueExpr("permission_mode")},
      ${sessionValueExpr("agent_version")},
      ${sessionValueExpr("model")},
      ${sessionValueExpr("cli_version")},
      ${sessionValueExpr("scanner_file_path")},
      ${sessionValueExpr("total_input_tokens", "0")},
      ${sessionValueExpr("total_output_tokens", "0")},
      ${sessionValueExpr("total_cache_read_tokens", "0")},
      ${sessionValueExpr("total_cache_creation_tokens", "0")},
      ${sessionValueExpr("total_reasoning_tokens", "0")},
      ${sessionValueExpr("turn_count", "0")},
      ${sessionValueExpr("otel_input_tokens", "0")},
      ${sessionValueExpr("otel_output_tokens", "0")},
      ${sessionValueExpr("otel_cache_read_tokens", "0")},
      ${sessionValueExpr("otel_cache_creation_tokens", "0")},
      ${sessionValueExpr("models")},
      ${sessionValueExpr("has_hooks", "0")},
      ${sessionValueExpr("has_otel", "0")},
      ${sessionValueExpr("has_scanner", "0")},
      ${sessionValueExpr("sync_dirty", "0")},
      ${sessionValueExpr("sync_seq", "0")},
      ${sessionValueExpr("tool_counts", "'{}'")},
      ${sessionValueExpr("hook_tool_counts", "'{}'")},
      ${sessionValueExpr("event_type_counts", "'{}'")},
      ${sessionValueExpr("hook_event_type_counts", "'{}'")},
      ${sessionValueExpr("project")},
      ${sessionValueExpr("machine", "'local'")},
      ${sessionValueExpr("message_count", "0")},
      ${sessionValueExpr("user_message_count", "0")},
      ${sessionValueExpr("parent_session_id")},
      ${sessionValueExpr("relationship_type", "''")},
      ${sessionValueExpr("is_automated", "0")},
      ${sessionValueExpr("created_at", "NULL")}
    FROM sessions
  `);

  db.exec("DROP TABLE sessions");
  db.exec("ALTER TABLE sessions_new RENAME TO sessions");

  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_target ON sessions(target)");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_scanner_file_target
      ON sessions(scanner_file_path, target)
      WHERE scanner_file_path IS NOT NULL
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_ms)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_sync_seq ON sessions(sync_seq)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_machine ON sessions(machine)",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)
      WHERE parent_session_id IS NOT NULL
  `);
}

// ---------------------------------------------------------------------------
// Migration registry — append only, never reorder or remove
// ---------------------------------------------------------------------------

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "add_plugin_hooks_to_user_config",
    up: (db) => {
      addColumnIfMissing(
        db,
        "user_config_snapshots",
        "plugin_hooks",
        "plugin_hooks JSON NOT NULL DEFAULT '[]'",
      );
    },
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
    // #115 (Apr 2) replaced delta summaries with a single legacy sessions.summary
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
      addColumnIfMissing(
        db,
        "user_config_snapshots",
        "panopticon_allowed",
        "panopticon_allowed JSON NOT NULL DEFAULT 'null'",
      );
      addColumnIfMissing(
        db,
        "user_config_snapshots",
        "panopticon_approvals",
        "panopticon_approvals JSON NOT NULL DEFAULT 'null'",
      );
      addColumnIfMissing(
        db,
        "user_config_snapshots",
        "memory_files",
        "memory_files JSON NOT NULL DEFAULT '{}'",
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
          asserter_version INTEGER NOT NULL,
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
          asserter_version INTEGER NOT NULL,
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
      createIndexIfColumnsExist(
        db,
        "claim_evidence",
        ["evidence_key"],
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
      if (!hasSyncId)
        addColumnIfMissing(db, "messages", "sync_id", "sync_id TEXT");

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
      if (!hasCallIndex)
        addColumnIfMissing(
          db,
          "tool_calls",
          "call_index",
          "call_index INTEGER NOT NULL DEFAULT 0",
        );

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
        if (!hasTurnSyncId)
          addColumnIfMissing(db, "scanner_turns", "sync_id", "sync_id TEXT");

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
      if (!hasEventSyncId)
        addColumnIfMissing(db, "scanner_events", "sync_id", "sync_id TEXT");
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
  {
    id: 10,
    name: "add_evidence_ref_schema",
    up: (db) => {
      ensureEvidenceRefSchema(db);
    },
  },
  {
    id: 11,
    name: "reset_derived_state_for_evidence_ref_cutover",
    up: (db) => {
      resetDerivedStateForEvidenceRefCutover(db);
    },
  },
  {
    id: 12,
    name: "add_evidence_ref_paths_and_reset_derived_state",
    up: (db) => {
      resetDerivedStateForEvidenceRefCutover(db);
    },
  },
  {
    id: 13,
    name: "convert_asserter_versions_to_integer_and_reset_claim_state",
    up: (db) => {
      resetClaimDerivedStateForAsserterVersionIntegerCutover(db);
    },
  },
  {
    id: 14,
    name: "add_session_id_to_scanner_file_watermarks",
    up: (db) => {
      addScannerFileWatermarkSessionIdAndForceReparse(db);
    },
  },
  {
    id: 15,
    name: "flatten_session_summary_projection_storage",
    up: (db) => {
      if (!tableExists(db, "session_summaries")) {
        return;
      }
      resetSessionSummaryProjectionStorage(db);
    },
  },
  {
    id: 16,
    name: "restore_session_summary_dirty_index",
    up: (db) => {
      if (!tableExists(db, "session_summary_enrichments")) {
        return;
      }
      db.exec(`
        DROP INDEX IF EXISTS idx_session_summary_enrichments_refresh
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_summary_enrichments_dirty
          ON session_summary_enrichments(dirty, last_material_change_at_ms)
      `);
    },
  },
  {
    id: 17,
    name: "drop_legacy_sessions_summary_columns",
    up: (db) => {
      rebuildSessionsTableWithoutLegacySummary(db);
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
