import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { SCHEMA_SQL } from "./schema.js";

function makeTempDb(): { db: Database.Database; cleanup: () => void } {
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

function createDb(): Database.Database {
  const { db, cleanup } = makeTempDb();
  cleanups.push(cleanup);
  return db;
}

describe("runMigrations", () => {
  it("stamps all migrations on a fresh DB without executing them", () => {
    const db = createDb();
    db.exec(SCHEMA_SQL);
    runMigrations(db);

    const rows = db
      .prepare("SELECT id, name FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: number; name: string }>;

    expect(rows.length).toBe(MIGRATIONS.length);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(rows[i].id).toBe(MIGRATIONS[i].id);
      expect(rows[i].name).toBe(MIGRATIONS[i].name);
    }
  });

  it("runs migrations on an existing DB missing a column", () => {
    const db = createDb();

    // Create a user_config_snapshots table WITHOUT plugin_hooks
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

    // Pre-create schema_migrations to simulate an existing DB
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    runMigrations(db);

    // Verify migration ran: plugin_hooks column should exist
    const cols = db
      .prepare("PRAGMA table_info(user_config_snapshots)")
      .all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("plugin_hooks");

    // Verify migration was recorded
    const applied = db
      .prepare("SELECT id FROM schema_migrations")
      .all() as Array<{ id: number }>;
    expect(applied.map((r) => r.id)).toContain(1);
  });

  it("is idempotent — calling twice is safe", () => {
    const db = createDb();
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    runMigrations(db);

    const rows = db
      .prepare("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: number }>;
    expect(rows.length).toBe(MIGRATIONS.length);
  });

  it("skips already-applied migrations on existing DBs", () => {
    const db = createDb();

    // Simulate an existing DB that already has migration #1 applied
    db.exec(`
      CREATE TABLE user_config_snapshots (
        id INTEGER PRIMARY KEY,
        plugin_hooks JSON NOT NULL DEFAULT '[]'
      )
    `);
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(
      1,
      "add_plugin_hooks_to_user_config",
    );

    // Should not throw — migration #1 is skipped
    runMigrations(db);

    const rows = db
      .prepare("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: number }>;
    expect(rows.length).toBe(1);
  });

  it("rolls back failed migrations without recording them", () => {
    const db = createDb();

    // Create schema_migrations to indicate an existing DB
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Don't create user_config_snapshots — migration #1 will fail
    // because the table doesn't exist

    expect(() => runMigrations(db)).toThrow();

    // Verify the failed migration was NOT recorded
    const rows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{
      id: number;
    }>;
    expect(rows.length).toBe(0);
  });
});
