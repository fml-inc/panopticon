import { getDb } from "./schema.js";

export interface SessionSummary {
  session_id: string;
  summary: string;
  event_count: number;
  created_at: number;
  updated_at: number;
}

export function getSessionSummary(sessionId: string): SessionSummary | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM session_summaries WHERE session_id = ?")
    .get(sessionId) as SessionSummary | undefined;
  return row ?? null;
}

export function setSessionSummary(
  sessionId: string,
  summary: string,
  eventCount: number,
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO session_summaries (session_id, summary, event_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, event_count = excluded.event_count, updated_at = excluded.updated_at`,
  ).run(sessionId, summary, eventCount, now, now);
}

export function deleteSessionSummary(sessionId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(
    sessionId,
  );
}
