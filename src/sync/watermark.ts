import path from "node:path";
import Database from "better-sqlite3";
import { config, ensureDataDir } from "../config.js";

const WATERMARK_DB_NAME = "sync-watermarks.db";

let _db: Database.Database | null = null;

function getWatermarkDb(): Database.Database {
  if (_db) return _db;

  ensureDataDir();
  const dbPath = path.join(config.dataDir, WATERMARK_DB_NAME);
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.exec(
    "CREATE TABLE IF NOT EXISTS watermarks (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
  );
  return _db;
}

export function closeWatermarkDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function watermarkKey(table: string, targetName: string): string {
  return `${table}:${targetName}`;
}

export function readWatermark(key: string): number {
  const db = getWatermarkDb();
  const row = db
    .prepare("SELECT value FROM watermarks WHERE key = ?")
    .get(key) as { value: number } | undefined;
  return row?.value ?? 0;
}

export function writeWatermark(key: string, value: number): void {
  const db = getWatermarkDb();
  db.prepare(
    "INSERT INTO watermarks (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

const SYNCED_TABLES = [
  "hook_events",
  "otel_logs",
  "otel_metrics",
  "scanner_turns",
  "scanner_events",
];

export function resetWatermarks(targetName?: string): void {
  const db = getWatermarkDb();
  if (targetName) {
    const stmt = db.prepare("DELETE FROM watermarks WHERE key = ?");
    for (const table of SYNCED_TABLES) {
      stmt.run(watermarkKey(table, targetName));
    }
  } else {
    db.prepare("DELETE FROM watermarks").run();
  }
}
