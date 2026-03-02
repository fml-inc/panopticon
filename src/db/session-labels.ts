import { getDb } from "./schema.js";

export interface SessionLabel {
  session_id: string;
  name: string;
  created_at: number;
}

export function getSessionLabel(sessionId: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT name FROM session_labels WHERE session_id = ?")
    .get(sessionId) as { name: string } | undefined;
  return row?.name ?? null;
}

export function setSessionLabel(sessionId: string, name: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "INSERT INTO session_labels (session_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET name = excluded.name",
  ).run(sessionId, name, now);
}

export function deleteSessionLabel(sessionId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM session_labels WHERE session_id = ?").run(sessionId);
}

export function searchSessionLabels(query: string): SessionLabel[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM session_labels WHERE name LIKE ? ORDER BY created_at DESC",
    )
    .all(`%${query}%`) as SessionLabel[];
}
