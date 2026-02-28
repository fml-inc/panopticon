import { getDb } from "../db/schema.js";

export function watermarkKey(table: string, targetName: string): string {
  return `${table}:${targetName}`;
}

export function readWatermark(key: string): number | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return null;
  const n = parseInt(row.value, 10);
  return Number.isNaN(n) ? null : n;
}

export function writeWatermark(key: string, value: number): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

export function resetWatermarksForTarget(targetName: string): void {
  const db = getDb();
  db.prepare("DELETE FROM sync_state WHERE key LIKE ?").run(`%:${targetName}`);
}

export function resetWatermarks(): void {
  const db = getDb();
  // Delete both old-format keys (e.g. hook_events_last_id) and new per-target keys (e.g. hook_events_last_id:dev)
  db.prepare(
    "DELETE FROM sync_state WHERE key LIKE '%_last_id' OR key LIKE '%_last_id:%'",
  ).run();
}
