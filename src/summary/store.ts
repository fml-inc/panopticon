import { getDb } from "../db/schema.js";

export interface SummaryDelta {
  sessionId: string;
  deltaIndex: number;
  createdAtMs: number;
  fromTurn: number;
  toTurn: number;
  content: string;
  method: string;
}

export function insertSummaryDelta(delta: SummaryDelta): void {
  const db = getDb();
  db.prepare(
    `
    INSERT OR IGNORE INTO session_summary_deltas
      (session_id, delta_index, created_at_ms, from_turn, to_turn, content, method)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    delta.sessionId,
    delta.deltaIndex,
    delta.createdAtMs,
    delta.fromTurn,
    delta.toTurn,
    delta.content,
    delta.method,
  );
}

export function readSummaryDeltas(sessionId: string): SummaryDelta[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT session_id, delta_index, created_at_ms, from_turn, to_turn, content, method FROM session_summary_deltas WHERE session_id = ? ORDER BY delta_index",
    )
    .all(sessionId) as Array<{
    session_id: string;
    delta_index: number;
    created_at_ms: number;
    from_turn: number;
    to_turn: number;
    content: string;
    method: string;
  }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    deltaIndex: r.delta_index,
    createdAtMs: r.created_at_ms,
    fromTurn: r.from_turn,
    toTurn: r.to_turn,
    content: r.content,
    method: r.method,
  }));
}

export function getSessionSummaryVersion(sessionId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT summary_version FROM sessions WHERE session_id = ?")
    .get(sessionId) as { summary_version: number } | undefined;
  return row?.summary_version ?? 0;
}

export function updateSessionSummary(
  sessionId: string,
  summary: string,
  version: number,
): void {
  const db = getDb();
  db.prepare(
    "UPDATE sessions SET summary = ?, summary_version = ?, sync_dirty = 1 WHERE session_id = ?",
  ).run(summary, version, sessionId);
}

export function deleteSummaryDeltas(sessionId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM session_summary_deltas WHERE session_id = ?").run(
    sessionId,
  );
}
