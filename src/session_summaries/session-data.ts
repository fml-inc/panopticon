import { getDb } from "../db/schema.js";

export interface SessionSummaryIntentRow {
  intent_unit_id: number;
  session_id: string;
  prompt_text: string;
  prompt_ts_ms: number | null;
  next_prompt_ts_ms: number | null;
  repository: string | null;
  cwd: string | null;
}

export interface SessionSummaryEditRow {
  intent_edit_id: number;
  intent_unit_id: number;
  session_id: string;
  file_path: string;
  tool_name: string | null;
  timestamp_ms: number | null;
  landed: number | null;
  landed_reason: string | null;
  new_string_hash: string | null;
  new_string_snippet: string | null;
}

export function loadSessionSummaryIntentRows(
  sessionId: string,
): SessionSummaryIntentRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id AS intent_unit_id, session_id, prompt_text, prompt_ts_ms,
              next_prompt_ts_ms, repository, cwd
       FROM intent_units
       WHERE session_id = ?
       ORDER BY COALESCE(prompt_ts_ms, 0) ASC, id ASC`,
    )
    .all(sessionId) as SessionSummaryIntentRow[];
}

export function loadSessionSummaryEditRows(
  sessionId: string,
): SessionSummaryEditRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id AS intent_edit_id, intent_unit_id, session_id, file_path,
              tool_name, timestamp_ms, landed, landed_reason,
              new_string_hash, new_string_snippet
       FROM intent_edits
       WHERE session_id = ?
       ORDER BY COALESCE(timestamp_ms, 0) ASC, id ASC`,
    )
    .all(sessionId) as SessionSummaryEditRow[];
}

export function summarizeFiles(
  edits: Pick<SessionSummaryEditRow, "file_path" | "landed">[],
): Array<{ filePath: string; editCount: number; landedCount: number }> {
  const files = new Map<
    string,
    { filePath: string; editCount: number; landedCount: number }
  >();
  for (const edit of edits) {
    const current = files.get(edit.file_path) ?? {
      filePath: edit.file_path,
      editCount: 0,
      landedCount: 0,
    };
    current.editCount += 1;
    if (edit.landed === 1) current.landedCount += 1;
    files.set(edit.file_path, current);
  }
  return [...files.values()].sort(
    (a, b) => b.editCount - a.editCount || a.filePath.localeCompare(b.filePath),
  );
}

export function summarizeTools(
  edits: Pick<SessionSummaryEditRow, "tool_name">[],
): string[] {
  const counts = new Map<string, number>();
  for (const edit of edits) {
    if (!edit.tool_name) continue;
    counts.set(edit.tool_name, (counts.get(edit.tool_name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([toolName]) => toolName);
}
