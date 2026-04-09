import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "./driver.js";
import { MIGRATIONS, type Migration, runMigrations } from "./migrations.js";
import { SCHEMA_SQL } from "./schema.js";

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
