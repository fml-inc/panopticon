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

CREATE TABLE IF NOT EXISTS session_repositories (
  session_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  UNIQUE(session_id, repository)
);
CREATE INDEX IF NOT EXISTS idx_session_repos_session ON session_repositories(session_id);
CREATE INDEX IF NOT EXISTS idx_session_repos_repo ON session_repositories(repository);

CREATE TABLE IF NOT EXISTS session_cwds (
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  UNIQUE(session_id, cwd)
);
CREATE INDEX IF NOT EXISTS idx_session_cwds_session ON session_cwds(session_id);

CREATE TABLE IF NOT EXISTS model_pricing (
  model_id TEXT PRIMARY KEY,
  input_per_m REAL NOT NULL,
  output_per_m REAL NOT NULL,
  cache_read_per_m REAL NOT NULL DEFAULT 0,
  cache_write_per_m REAL NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);

`;

let _db: Database.Database | null = null;

function registerCompressionFunctions(db: Database.Database): void {
  db.function("decompress", (blob: Buffer | null) =>
    blob ? gunzipSync(blob).toString() : null,
  );
}

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      // Extract frequently-queried fields from compressed payloads into columns
      db.exec("ALTER TABLE hook_events ADD COLUMN user_prompt TEXT");
      db.exec("ALTER TABLE hook_events ADD COLUMN file_path TEXT");
      db.exec("ALTER TABLE hook_events ADD COLUMN command TEXT");
      db.exec("ALTER TABLE hook_events ADD COLUMN plan TEXT");
      db.exec("ALTER TABLE hook_events ADD COLUMN allowed_prompts TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_hooks_file_path ON hook_events(file_path)",
      );

      // Backfill existing rows from compressed payloads
      db.exec(`
        UPDATE hook_events
        SET user_prompt = json_extract(decompress(payload), '$.prompt')
        WHERE event_type = 'UserPromptSubmit' AND user_prompt IS NULL
      `);
      db.exec(`
        UPDATE hook_events
        SET file_path = json_extract(decompress(payload), '$.tool_input.file_path')
        WHERE tool_name IN ('Write', 'Edit', 'Read') AND file_path IS NULL
      `);
      db.exec(`
        UPDATE hook_events
        SET command = json_extract(decompress(payload), '$.tool_input.command')
        WHERE tool_name = 'Bash' AND command IS NULL
      `);
      db.exec(`
        UPDATE hook_events
        SET plan = json_extract(decompress(payload), '$.tool_input.plan'),
            allowed_prompts = json_extract(decompress(payload), '$.tool_input.allowedPrompts')
        WHERE tool_name = 'ExitPlanMode' AND event_type = 'PreToolUse' AND plan IS NULL
      `);
    },
  },
  {
    version: 3,
    up(db: Database.Database) {
      db.exec("ALTER TABLE hook_events ADD COLUMN tool_result TEXT");
    },
  },
];

function runMigrations(db: Database.Database): void {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  for (const m of migrations) {
    if (m.version > currentVersion) {
      m.up(db);
      db.prepare(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
      ).run(String(m.version));
    }
  }
}

export function getDb(): Database.Database {
  if (_db) return _db;

  ensureDataDir();
  _db = new Database(config.dbPath);
  _db.pragma("auto_vacuum = INCREMENTAL");
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  registerCompressionFunctions(_db);
  _db.exec(SCHEMA_SQL);
  runMigrations(_db);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
