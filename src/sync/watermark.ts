import { getDb } from "../db/schema.js";
import { TABLE_SYNC_REGISTRY } from "./registry.js";

export function watermarkKey(table: string, targetName: string): string {
  return `${table}:${targetName}`;
}

export function readWatermark(key: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM watermarks WHERE key = ?")
    .get(key) as { value: number } | undefined;
  return row?.value ?? 0;
}

export function writeWatermark(key: string, value: number): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO watermarks (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function resetWatermarks(targetName?: string): void {
  const db = getDb();
  if (targetName) {
    const stmt = db.prepare("DELETE FROM watermarks WHERE key = ?");
    for (const desc of TABLE_SYNC_REGISTRY) {
      stmt.run(watermarkKey(desc.table, targetName));
    }
  } else {
    db.prepare("DELETE FROM watermarks").run();
  }
}
