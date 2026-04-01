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

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  target TEXT,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  cwd TEXT,
  first_prompt TEXT,
  permission_mode TEXT,
  agent_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_target ON sessions(target);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_ms);

CREATE TABLE IF NOT EXISTS session_repositories (
  session_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  git_user_name TEXT,
  git_user_email TEXT,
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
  {
    version: 4,
    up: (db) => {
      db.exec("ALTER TABLE hook_events ADD COLUMN target TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_hooks_target ON hook_events(target)",
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          target TEXT,
          started_at_ms INTEGER,
          ended_at_ms INTEGER,
          cwd TEXT,
          first_prompt TEXT,
          permission_mode TEXT,
          agent_version TEXT
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_sessions_target ON sessions(target)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_ms)",
      );
    },
  },
  {
    version: 5,
    up: (db) => {
      const cols = db
        .prepare("PRAGMA table_info(session_repositories)")
        .all() as { name: string }[];
      if (!cols.some((c) => c.name === "git_user_name")) {
        db.exec(
          "ALTER TABLE session_repositories ADD COLUMN git_user_name TEXT",
        );
        db.exec(
          "ALTER TABLE session_repositories ADD COLUMN git_user_email TEXT",
        );
      }
    },
  },
  {
    version: 6,
    up: (db) => {
      // Add scanner columns to sessions table — both hooks and scanner
      // upsert by session_id with COALESCE, so either source can fill
      // in any field independently.
      db.exec(`
        ALTER TABLE sessions ADD COLUMN model TEXT;
        ALTER TABLE sessions ADD COLUMN cli_version TEXT;
        ALTER TABLE sessions ADD COLUMN scanner_file_path TEXT;
        ALTER TABLE sessions ADD COLUMN total_input_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN total_output_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN total_cache_read_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN total_cache_creation_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN total_reasoning_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN turn_count INTEGER DEFAULT 0;
      `);

      db.exec(`
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
          UNIQUE(session_id, source, turn_index)
        );
        CREATE INDEX IF NOT EXISTS idx_scanner_turns_session ON scanner_turns(session_id);
        CREATE INDEX IF NOT EXISTS idx_scanner_turns_ts ON scanner_turns(timestamp_ms);

        CREATE TABLE IF NOT EXISTS scanner_file_watermarks (
          file_path TEXT PRIMARY KEY,
          byte_offset INTEGER NOT NULL DEFAULT 0,
          last_scanned_ms INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      db.exec(`
        -- OTLP-sourced token columns (separate from scanner totals)
        ALTER TABLE sessions ADD COLUMN otel_input_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN otel_output_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN otel_cache_read_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN otel_cache_creation_tokens INTEGER DEFAULT 0;

        -- Model set (comma-separated, sessions can switch models)
        ALTER TABLE sessions ADD COLUMN models TEXT;

        -- Completeness indicators
        ALTER TABLE sessions ADD COLUMN has_hooks INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN has_otel INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN has_scanner INTEGER DEFAULT 0;
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS scanner_events (
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
          UNIQUE(session_id, source, event_type, timestamp_ms, tool_name)
        );
        CREATE INDEX IF NOT EXISTS idx_scanner_events_session ON scanner_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_scanner_events_type ON scanner_events(event_type);
      `);
    },
  },
  {
    version: 8,
    up: (db) => {
      // Replace single-row-per-model pricing with append-only time series.
      // Drop old OpenRouter data and recreate with autoincrement id.
      db.exec(`
        DROP TABLE IF EXISTS model_pricing;
        CREATE TABLE model_pricing (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model_id TEXT NOT NULL,
          input_per_m REAL NOT NULL,
          output_per_m REAL NOT NULL,
          cache_read_per_m REAL NOT NULL DEFAULT 0,
          cache_write_per_m REAL NOT NULL DEFAULT 0,
          updated_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_model_pricing_model ON model_pricing(model_id, updated_ms);
      `);
    },
  },
  {
    version: 9,
    up: (db) => {
      db.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_spans_session ON otel_spans(session_id);
        CREATE INDEX IF NOT EXISTS idx_spans_trace ON otel_spans(trace_id);
        CREATE INDEX IF NOT EXISTS idx_spans_start ON otel_spans(start_time_ns);

        CREATE TABLE IF NOT EXISTS session_summary_deltas (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          delta_index INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          from_turn INTEGER NOT NULL,
          to_turn INTEGER NOT NULL,
          content TEXT NOT NULL,
          method TEXT NOT NULL DEFAULT 'deterministic',
          UNIQUE(session_id, delta_index)
        );
        CREATE INDEX IF NOT EXISTS idx_summary_deltas_session ON session_summary_deltas(session_id);
      `);

      // ALTER TABLE columns added conditionally to handle DBs from
      // earlier development where these were part of migration v8.
      const addColumnIfMissing = (
        table: string,
        column: string,
        type: string,
      ) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[];
        if (!cols.some((c) => c.name === column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
      };

      addColumnIfMissing(
        "scanner_file_watermarks",
        "archived_size",
        "INTEGER DEFAULT 0",
      );
      addColumnIfMissing("scanner_turns", "summary", "TEXT");
      addColumnIfMissing("sessions", "summary", "TEXT");
      addColumnIfMissing("sessions", "summary_version", "INTEGER DEFAULT 0");
      addColumnIfMissing("sessions", "sync_dirty", "INTEGER DEFAULT 0");
    },
  },
  {
    version: 10,
    up: (db) => {
      // Drop the single-table version if it exists from an earlier dev build
      db.exec("DROP TABLE IF EXISTS config_snapshots");

      db.exec(`
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
          skills JSON NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_user_config_ts ON user_config_snapshots(snapshot_at_ms);
        CREATE INDEX IF NOT EXISTS idx_user_config_device_hash ON user_config_snapshots(device_name, content_hash);

        CREATE TABLE IF NOT EXISTS repo_config_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repository TEXT NOT NULL,
          cwd TEXT NOT NULL,
          session_id TEXT,
          snapshot_at_ms INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          -- project layer (.claude/settings.json)
          hooks JSON NOT NULL DEFAULT '[]',
          mcp_servers JSON NOT NULL DEFAULT '[]',
          commands JSON NOT NULL DEFAULT '[]',
          agents JSON NOT NULL DEFAULT '[]',
          rules JSON NOT NULL DEFAULT '[]',
          -- project local layer (.claude/settings.local.json)
          local_hooks JSON NOT NULL DEFAULT '[]',
          local_mcp_servers JSON NOT NULL DEFAULT '[]',
          local_permissions JSON NOT NULL DEFAULT '{}',
          local_is_gitignored INTEGER NOT NULL DEFAULT 1,
          -- instructions (CLAUDE.md files at all depths)
          instructions JSON NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_repo_config_repo_ts ON repo_config_snapshots(repository, snapshot_at_ms);
        CREATE INDEX IF NOT EXISTS idx_repo_config_session ON repo_config_snapshots(session_id);
        CREATE INDEX IF NOT EXISTS idx_repo_config_repo_hash ON repo_config_snapshots(repository, content_hash);
      `);
    },
  },
  {
    version: 11,
    up: (db) => {
      db.exec("ALTER TABLE session_repositories ADD COLUMN branch TEXT");
    },
  },
  {
    version: 12,
    up: (db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN sync_seq INTEGER DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_sessions_sync_seq ON sessions(sync_seq);
      `);
      // Seed sync_seq from rowid so existing sessions are picked up
      db.exec("UPDATE sessions SET sync_seq = rowid WHERE sync_seq = 0");
    },
  },
  {
    version: 13,
    up: (db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN tool_counts JSON DEFAULT '{}';
        ALTER TABLE sessions ADD COLUMN event_type_counts JSON DEFAULT '{}';
      `);
    },
  },
  {
    version: 14,
    up: (db) => {
      // cwd is redundant with session_cwds junction table
      db.exec("ALTER TABLE sessions DROP COLUMN cwd");
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
