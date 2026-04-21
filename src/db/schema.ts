import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { config } from "../config.js";
import { Database } from "./driver.js";
import { runMigrations } from "./migrations.js";

export { runMigrations } from "./migrations.js";

export const SCHEMA_SQL = `

-- ── OTLP tables ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS otel_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_ns INTEGER NOT NULL,
  observed_timestamp_ns INTEGER,
  severity_number INTEGER,
  severity_text TEXT,
  body TEXT,
  attributes JSON,
  resource_attributes JSON,
  session_id TEXT,
  prompt_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  sync_id TEXT DEFAULT (hex(randomblob(8)))
);

CREATE TABLE IF NOT EXISTS otel_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_ns INTEGER NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  metric_type TEXT,
  unit TEXT,
  attributes JSON,
  resource_attributes JSON,
  session_id TEXT,
  sync_id TEXT DEFAULT (hex(randomblob(8)))
);

CREATE TABLE IF NOT EXISTS otel_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind INTEGER,
  start_time_ns INTEGER NOT NULL,
  end_time_ns INTEGER NOT NULL,
  status_code INTEGER,
  status_message TEXT,
  attributes JSON,
  resource_attributes JSON,
  session_id TEXT,
  UNIQUE(trace_id, span_id)
);

-- ── Hook events ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  cwd TEXT,
  repository TEXT,
  tool_name TEXT,
  payload BLOB NOT NULL,
  user_prompt TEXT,
  file_path TEXT,
  command TEXT,
  plan TEXT,
  allowed_prompts TEXT,
  tool_result TEXT,
  target TEXT,
  sync_id TEXT DEFAULT (hex(randomblob(8)))
);

CREATE VIRTUAL TABLE IF NOT EXISTS hook_events_fts USING fts5(
  payload,
  content='',
  contentless_delete=1,
  tokenize='trigram'
);

-- ── Sessions ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS session_repositories (
  session_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  git_user_name TEXT,
  git_user_email TEXT,
  branch TEXT,
  UNIQUE(session_id, repository)
);

CREATE TABLE IF NOT EXISTS session_cwds (
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  UNIQUE(session_id, cwd)
);

-- ── Messages ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  ordinal         INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  timestamp_ms    INTEGER,
  has_thinking    INTEGER NOT NULL DEFAULT 0,
  has_tool_use    INTEGER NOT NULL DEFAULT 0,
  content_length  INTEGER NOT NULL DEFAULT 0,
  is_system       INTEGER NOT NULL DEFAULT 0,
  model           TEXT NOT NULL DEFAULT '',
  token_usage     TEXT NOT NULL DEFAULT '',
  context_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  has_context_tokens INTEGER NOT NULL DEFAULT 0,
  has_output_tokens  INTEGER NOT NULL DEFAULT 0,
  uuid            TEXT,
  parent_uuid     TEXT,
  sync_id         TEXT NOT NULL,
  UNIQUE(session_id, ordinal)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='',
  contentless_delete=1,
  tokenize='trigram'
);

-- ── Tool calls ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tool_calls (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id            INTEGER NOT NULL,
  session_id            TEXT NOT NULL,
  call_index            INTEGER NOT NULL DEFAULT 0,
  tool_name             TEXT NOT NULL,
  category              TEXT NOT NULL,
  tool_use_id           TEXT,
  input_json            TEXT,
  skill_name            TEXT,
  result_content_length INTEGER,
  result_content        TEXT,
  duration_ms           INTEGER,
  subagent_session_id   TEXT,
  sync_id               TEXT NOT NULL
);

-- ── Scanner tables ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scanner_turns (
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
  sync_id TEXT NOT NULL,
  UNIQUE(session_id, source, turn_index)
);

CREATE TABLE IF NOT EXISTS scanner_events (
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
);

CREATE TABLE IF NOT EXISTS scanner_file_watermarks (
  file_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  last_scanned_ms INTEGER NOT NULL,
  archived_size INTEGER DEFAULT 0
);

-- ── Model pricing ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS model_pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  input_per_m REAL NOT NULL,
  output_per_m REAL NOT NULL,
  cache_read_per_m REAL NOT NULL DEFAULT 0,
  cache_write_per_m REAL NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL
);

-- ── Config snapshots ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_config_snapshots (
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
  plugin_hooks JSON NOT NULL DEFAULT '[]',
  -- Panopticon's own permission allowlist + approvals (user-global)
  panopticon_allowed JSON NOT NULL DEFAULT 'null',
  panopticon_approvals JSON NOT NULL DEFAULT 'null',
  -- Claude Code memory files: { projectSlug: { relPath: content } }
  memory_files JSON NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS repo_config_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  cwd TEXT NOT NULL,
  session_id TEXT,
  snapshot_at_ms INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  hooks JSON NOT NULL DEFAULT '[]',
  mcp_servers JSON NOT NULL DEFAULT '[]',
  commands JSON NOT NULL DEFAULT '[]',
  agents JSON NOT NULL DEFAULT '[]',
  rules JSON NOT NULL DEFAULT '[]',
  local_hooks JSON NOT NULL DEFAULT '[]',
  local_mcp_servers JSON NOT NULL DEFAULT '[]',
  local_permissions JSON NOT NULL DEFAULT '{}',
  local_is_gitignored INTEGER NOT NULL DEFAULT 1,
  instructions JSON NOT NULL DEFAULT '[]'
);

-- ── Claims layer ────────────────────────────────────────────────────────────

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
);

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
);

CREATE TABLE IF NOT EXISTS claim_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL,
  evidence_ref_id INTEGER NOT NULL,
  detail JSON,
  role TEXT NOT NULL DEFAULT 'supporting'
);

CREATE TABLE IF NOT EXISTS active_claims (
  head_key TEXT PRIMARY KEY,
  claim_id INTEGER NOT NULL,
  selected_at_ms INTEGER NOT NULL,
  selection_reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_cursors (
  asserter TEXT NOT NULL,
  source TEXT NOT NULL,
  cursor_text TEXT NOT NULL DEFAULT '',
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (asserter, source)
);

CREATE TABLE IF NOT EXISTS claim_rebuild_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asserter TEXT NOT NULL,
  asserter_version TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  rows_emitted INTEGER NOT NULL DEFAULT 0,
  scope JSON
);

-- ── Intent projection ───────────────────────────────────────────────────────

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
);

CREATE VIRTUAL TABLE IF NOT EXISTS intent_units_fts USING fts5(
  prompt_text,
  content='',
  contentless_delete=1,
  tokenize='trigram'
);

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
);

-- ── Local session-summary projections ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS session_summaries (
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

CREATE TABLE IF NOT EXISTS intent_session_summaries (
  intent_unit_id INTEGER NOT NULL,
  session_summary_id INTEGER NOT NULL,
  membership_kind TEXT NOT NULL,
  source TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 1.0,
  reason_json TEXT,
  UNIQUE(intent_unit_id, session_summary_id)
);

CREATE TABLE IF NOT EXISTS code_provenance (
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
);

-- ── Sync watermarks ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS watermarks (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- ── Per-session sync state ─────────────────────────────────────────────────

DROP TABLE IF EXISTS pending_session_sync;

CREATE TABLE IF NOT EXISTS target_session_sync (
  session_id TEXT NOT NULL,
  target TEXT NOT NULL,
  confirmed INTEGER DEFAULT 0,
  sync_seq INTEGER DEFAULT 0,
  synced_seq INTEGER DEFAULT 0,
  wm_messages INTEGER DEFAULT 0,
  wm_tool_calls INTEGER DEFAULT 0,
  wm_scanner_turns INTEGER DEFAULT 0,
  wm_scanner_events INTEGER DEFAULT 0,
  wm_hook_events INTEGER DEFAULT 0,
  wm_otel_logs INTEGER DEFAULT 0,
  wm_otel_metrics INTEGER DEFAULT 0,
  wm_otel_spans INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, target)
);

-- ── Indexes ─────────────────────────────────────────────────────────────────

-- otel_logs
CREATE INDEX IF NOT EXISTS idx_logs_session ON otel_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_body ON otel_logs(body);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON otel_logs(timestamp_ns);
CREATE INDEX IF NOT EXISTS idx_logs_prompt ON otel_logs(prompt_id);

-- otel_metrics
CREATE INDEX IF NOT EXISTS idx_metrics_session ON otel_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON otel_metrics(name);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON otel_metrics(timestamp_ns);

-- otel_spans
CREATE INDEX IF NOT EXISTS idx_spans_session ON otel_spans(session_id);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON otel_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_start ON otel_spans(start_time_ns);

-- hook_events
CREATE INDEX IF NOT EXISTS idx_hooks_session ON hook_events(session_id);
CREATE INDEX IF NOT EXISTS idx_hooks_type ON hook_events(event_type);
CREATE INDEX IF NOT EXISTS idx_hooks_tool ON hook_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_hooks_ts ON hook_events(timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_hooks_file_path ON hook_events(file_path);
CREATE INDEX IF NOT EXISTS idx_hooks_target ON hook_events(target);

-- sessions
CREATE INDEX IF NOT EXISTS idx_sessions_target ON sessions(target);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_ms);
CREATE INDEX IF NOT EXISTS idx_sessions_sync_seq ON sessions(sync_seq);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_machine ON sessions(machine);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;

-- session_repositories
CREATE INDEX IF NOT EXISTS idx_session_repos_session ON session_repositories(session_id);
CREATE INDEX IF NOT EXISTS idx_session_repos_repo ON session_repositories(repository);

-- session_cwds
CREATE INDEX IF NOT EXISTS idx_session_cwds_session ON session_cwds(session_id);

-- messages
CREATE INDEX IF NOT EXISTS idx_messages_session_ordinal ON messages(session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role);

-- tool_calls
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_category ON tool_calls(category);
CREATE INDEX IF NOT EXISTS idx_tool_calls_skill ON tool_calls(skill_name)
  WHERE skill_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_calls_subagent ON tool_calls(subagent_session_id)
  WHERE subagent_session_id IS NOT NULL;

-- scanner_turns
CREATE INDEX IF NOT EXISTS idx_scanner_turns_session ON scanner_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_scanner_turns_ts ON scanner_turns(timestamp_ms);

-- scanner_events
CREATE INDEX IF NOT EXISTS idx_scanner_events_session ON scanner_events(session_id);
CREATE INDEX IF NOT EXISTS idx_scanner_events_type ON scanner_events(event_type);

-- model_pricing
CREATE INDEX IF NOT EXISTS idx_model_pricing_model ON model_pricing(model_id, updated_ms);

-- user_config_snapshots
CREATE INDEX IF NOT EXISTS idx_user_config_ts ON user_config_snapshots(snapshot_at_ms);
CREATE INDEX IF NOT EXISTS idx_user_config_device_hash ON user_config_snapshots(device_name, content_hash);

-- repo_config_snapshots
CREATE INDEX IF NOT EXISTS idx_repo_config_repo_ts ON repo_config_snapshots(repository, snapshot_at_ms);
CREATE INDEX IF NOT EXISTS idx_repo_config_session ON repo_config_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_repo_config_repo_hash ON repo_config_snapshots(repository, content_hash);

-- claims
CREATE INDEX IF NOT EXISTS idx_claims_head ON claims(head_key);
CREATE INDEX IF NOT EXISTS idx_claims_predicate_subject ON claims(predicate, subject_kind, subject);
CREATE INDEX IF NOT EXISTS idx_claims_observed ON claims(observed_at_ms);
CREATE INDEX IF NOT EXISTS idx_claims_asserter ON claims(asserter, observed_at_ms);

-- claim_evidence
CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim ON claim_evidence(claim_id);

-- active_claims
CREATE INDEX IF NOT EXISTS idx_active_claims_claim ON active_claims(claim_id);

-- intent_units
CREATE INDEX IF NOT EXISTS idx_intent_units_session ON intent_units(session_id);
CREATE INDEX IF NOT EXISTS idx_intent_units_repo ON intent_units(repository);
CREATE INDEX IF NOT EXISTS idx_intent_units_prompt_ts ON intent_units(prompt_ts_ms);

-- intent_edits
CREATE INDEX IF NOT EXISTS idx_intent_edits_unit ON intent_edits(intent_unit_id);
CREATE INDEX IF NOT EXISTS idx_intent_edits_session ON intent_edits(session_id);
CREATE INDEX IF NOT EXISTS idx_intent_edits_file ON intent_edits(file_path);

-- session_summaries
CREATE INDEX IF NOT EXISTS idx_session_summaries_repo ON session_summaries(repository);
CREATE INDEX IF NOT EXISTS idx_session_summaries_status ON session_summaries(status);
CREATE INDEX IF NOT EXISTS idx_session_summaries_last_ts ON session_summaries(last_intent_ts_ms);

-- intent_session_summaries
CREATE INDEX IF NOT EXISTS idx_intent_session_summaries_intent
  ON intent_session_summaries(intent_unit_id);
CREATE INDEX IF NOT EXISTS idx_intent_session_summaries_session_summary
  ON intent_session_summaries(session_summary_id);

-- code_provenance
CREATE INDEX IF NOT EXISTS idx_code_provenance_repo_file
  ON code_provenance(repository, file_path);
CREATE INDEX IF NOT EXISTS idx_code_provenance_session_summary
  ON code_provenance(session_summary_id);
CREATE INDEX IF NOT EXISTS idx_code_provenance_intent
  ON code_provenance(intent_unit_id);
CREATE INDEX IF NOT EXISTS idx_code_provenance_status
  ON code_provenance(status);

`;

const POST_MIGRATION_INDEX_SQL = `
-- claim_evidence
CREATE INDEX IF NOT EXISTS idx_claim_evidence_ref ON claim_evidence(evidence_ref_id);

-- evidence_refs
CREATE INDEX IF NOT EXISTS idx_evidence_refs_session ON evidence_refs(session_id);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_kind_sync ON evidence_refs(kind, sync_id);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_trace_span ON evidence_refs(trace_id, span_id);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_file ON evidence_refs(file_path);
`;

/**
 * Scanner data version. Increment when parser logic changes in ways that
 * affect stored data (new fields extracted, content formatting changes,
 * fork detection improvements, etc.). On startup, if the DB's user_version
 * is lower than this, a full resync is triggered automatically.
 */
export const SCANNER_DATA_VERSION = 2;

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

let _db: Database | null = null;
let _needsResync = false;

function registerCompressionFunctions(db: Database): void {
  db.function("decompress", (blob: unknown) =>
    blob ? gunzipSync(blob as Uint8Array).toString() : null,
  );
}

export function getDb(): Database {
  // If the db file was deleted (e.g. uninstall --purge) while this process
  // still holds a stale connection, drop it so we don't serve old data.
  if (_db && !fs.existsSync(config.dbPath)) {
    try {
      _db.close();
    } catch {}
    _db = null;
  }
  if (_db) return _db;

  // Don't auto-create the data directory — callers that need to bootstrap
  // the DB (install, initDb, hook handler) call ensureDataDir() first.
  if (!fs.existsSync(config.dataDir)) {
    throw new Error(
      `Panopticon data directory not found: ${config.dataDir}. Run "panopticon install" to set up.`,
    );
  }

  _db = new Database(config.dbPath);
  _db.pragma("auto_vacuum = INCREMENTAL");
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  registerCompressionFunctions(_db);
  _db.exec(SCHEMA_SQL);
  runMigrations(_db);
  _db.exec(POST_MIGRATION_INDEX_SQL);

  // Check data version for resync
  const currentVersion = (_db.pragma("user_version", { simple: true }) ??
    0) as number;
  if (currentVersion < SCANNER_DATA_VERSION) {
    _needsResync = true;
  } else {
    _needsResync = false;
  }

  return _db;
}

/** True when the DB was opened with a stale data version. */
export function needsResync(): boolean {
  if (!_db) {
    getDb();
  }
  return _needsResync;
}

/** Mark resync as complete and stamp the current data version. */
export function markResyncComplete(): void {
  _needsResync = false;
  const db = getDb();
  db.pragma(`user_version = ${SCANNER_DATA_VERSION}`);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
