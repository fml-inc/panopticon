import Database from "better-sqlite3";
import { gunzipSync } from "node:zlib";
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
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  registerCompressionFunctions(_db);
  _db.exec(SCHEMA_SQL);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
