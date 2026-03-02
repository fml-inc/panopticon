import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { config, ensureDataDir } from "../config.js";

const SCHEMA_SQL = `
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
  span_id TEXT
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
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  cwd TEXT,
  repository TEXT,
  tool_name TEXT,
  payload BLOB NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS hook_events_fts USING fts5(
  payload,
  content='',
  contentless_delete=1,
  tokenize='trigram'
);

CREATE INDEX IF NOT EXISTS idx_logs_session ON otel_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_body ON otel_logs(body);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON otel_logs(timestamp_ns);
CREATE INDEX IF NOT EXISTS idx_logs_prompt ON otel_logs(prompt_id);
CREATE INDEX IF NOT EXISTS idx_metrics_session ON otel_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON otel_metrics(name);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON otel_metrics(timestamp_ns);
CREATE INDEX IF NOT EXISTS idx_hooks_session ON hook_events(session_id);
CREATE INDEX IF NOT EXISTS idx_hooks_type ON hook_events(event_type);
CREATE INDEX IF NOT EXISTS idx_hooks_tool ON hook_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_hooks_ts ON hook_events(timestamp_ms);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  cost REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id);

CREATE TABLE IF NOT EXISTS session_labels (
  session_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_summaries (
  session_id  TEXT PRIMARY KEY,
  summary     TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  query TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  group_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  chat_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Materialized-style view that correctly deduplicates Gemini (cumulative MAX) vs Claude (per-request SUM).
-- Widget queries should SELECT from v_resolved_tokens instead of raw otel_metrics for cost/token data.
DROP VIEW IF EXISTS v_resolved_tokens;
CREATE VIEW v_resolved_tokens AS
  -- Gemini: cumulative counters → MAX per (session, model, token_type)
  SELECT session_id,
         COALESCE(json_extract(attributes, '$.model'), json_extract(attributes, '$."gen_ai.response.model"')) as model,
         COALESCE(json_extract(attributes, '$.type'), json_extract(attributes, '$."gen_ai.token.type"')) as token_type,
         MAX(value) as tokens,
         MAX(timestamp_ns) as timestamp_ns
  FROM otel_metrics
  WHERE name IN ('gemini_cli.token.usage', 'gen_ai.client.token.usage')
  GROUP BY session_id, model, token_type
UNION ALL
  -- Claude: per-request values → SUM per (session, model, token_type)
  SELECT session_id,
         COALESCE(json_extract(attributes, '$.model'), json_extract(attributes, '$."gen_ai.response.model"')) as model,
         COALESCE(json_extract(attributes, '$.type'), json_extract(attributes, '$."gen_ai.token.type"')) as token_type,
         SUM(value) as tokens,
         MAX(timestamp_ns) as timestamp_ns
  FROM otel_metrics
  WHERE name = 'claude_code.token.usage'
  GROUP BY session_id, model, token_type;
`;

let _db: Database.Database | null = null;

function registerCompressionFunctions(db: Database.Database): void {
  db.function("decompress", (blob: Buffer | null) =>
    blob ? gunzipSync(blob).toString() : null,
  );
}

export function getDb(): Database.Database {
  if (_db) return _db;

  ensureDataDir();
  _db = new Database(config.dbPath);
  _db.pragma("auto_vacuum = INCREMENTAL");
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  registerCompressionFunctions(_db);
  _db.exec(SCHEMA_SQL);

  // Migrate existing widgets tables that lack new columns
  for (const col of [
    "ALTER TABLE widgets ADD COLUMN group_name TEXT",
    "ALTER TABLE widgets ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE widgets ADD COLUMN chat_id TEXT",
  ]) {
    try {
      _db.exec(col);
    } catch {}
  }

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
