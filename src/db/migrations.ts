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

export interface Migration {
  id: number;
  name: string;
  /** Simple migrations: single SQL statement. */
  sql?: string;
  /** Complex migrations: function that receives the db handle. */
  up?: (db: Database) => void;
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
