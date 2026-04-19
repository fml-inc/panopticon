/**
 * Reconcile landed-vs-churn for intent edits.
 *
 * Two checks, run in order on every closed intent_unit in a session:
 *
 *   1. Within-session churn — walk the session's edits in time order. For each
 *      file, if a later edit/Write replaces or supersedes an earlier edit's
 *      inserted content, mark the earlier one landed=0 ('overwritten_in_session'
 *      or 'write_replaced').
 *
 *   2. Post-session disk check — for any edit not already marked overwritten,
 *      read the file from disk and check whether the inserted snippet is
 *      still present. Marks 'present_in_file' / 'reverted_post_session' /
 *      'file_deleted'.
 *
 * Idempotent: only processes intent_units whose `reconciled_at_ms IS NULL`,
 * and stamps it on completion. Safe to call repeatedly (every Stop) — a
 * post-session backfill could re-clear the column to re-run later.
 */
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { getDb } from "../db/schema.js";

interface IntentEditRow {
  id: number;
  intent_unit_id: number;
  hook_event_id: number;
  multi_edit_index: number;
  timestamp_ms: number;
  file_path: string;
  tool_name: string;
  new_string_hash: string;
  new_string_snippet: string | null;
  new_string_len: number;
  landed: number | null;
  landed_reason: string | null;
}

interface IntentUnitRow {
  id: number;
  session_id: string;
  next_prompt_ts_ms: number | null;
}

type LandedReason =
  | "present_in_file"
  | "overwritten_in_session"
  | "write_replaced"
  | "file_deleted"
  | "reverted_post_session";

/**
 * Reconcile every closed, unreconciled intent unit in a session.
 *
 * "Closed" = next_prompt_ts_ms IS NOT NULL (the prompt has been superseded by
 * another prompt, or the session has ended via Stop/SessionEnd which calls
 * closeOpenIntentUnits).
 */
export function reconcileSessionIntents(sessionId: string): void {
  const db = getDb();

  const units = db
    .prepare(
      `SELECT id, session_id, next_prompt_ts_ms
       FROM intent_units
       WHERE session_id = ?
         AND next_prompt_ts_ms IS NOT NULL
         AND reconciled_at_ms IS NULL`,
    )
    .all(sessionId) as IntentUnitRow[];
  if (units.length === 0) return;

  const now = Date.now();

  for (const unit of units) {
    reconcileUnit(unit.id);
    db.prepare(
      `UPDATE intent_units
       SET reconciled_at_ms = ?,
           landed_count = (
             SELECT COALESCE(SUM(CASE WHEN landed = 1 THEN 1 ELSE 0 END), 0)
             FROM intent_edits WHERE intent_unit_id = ?
           )
       WHERE id = ?`,
    ).run(now, unit.id, unit.id);
  }
}

/**
 * Re-run reconciliation for a single intent unit, ignoring the
 * reconciled_at_ms gate. Useful for backfills.
 */
export function reconcileIntentUnit(intentUnitId: number): void {
  const db = getDb();
  reconcileUnit(intentUnitId);
  db.prepare(
    `UPDATE intent_units
     SET reconciled_at_ms = ?,
         landed_count = (
           SELECT COALESCE(SUM(CASE WHEN landed = 1 THEN 1 ELSE 0 END), 0)
           FROM intent_edits WHERE intent_unit_id = ?
         )
     WHERE id = ?`,
  ).run(Date.now(), intentUnitId, intentUnitId);
}

function reconcileUnit(unitId: number): void {
  const db = getDb();

  // Pull this unit's edits AND every later edit in the same session that
  // touches the same files — so we can detect cross-unit overwrites.
  const ownEdits = db
    .prepare(
      `SELECT id, intent_unit_id, hook_event_id, timestamp_ms, file_path,
              multi_edit_index,
              tool_name, new_string_hash, new_string_snippet, new_string_len,
              landed, landed_reason
       FROM intent_edits
       WHERE intent_unit_id = ?
       ORDER BY timestamp_ms ASC, id ASC`,
    )
    .all(unitId) as IntentEditRow[];
  if (ownEdits.length === 0) return;

  const sessionId = (
    db
      .prepare(`SELECT session_id FROM intent_units WHERE id = ?`)
      .get(unitId) as { session_id: string }
  ).session_id;

  const filePaths = [...new Set(ownEdits.map((e) => e.file_path))];

  // All edits in this session for these files, ordered by time
  const placeholders = filePaths.map(() => "?").join(",");
  const allEditsForFiles = db
    .prepare(
      `SELECT id, intent_unit_id, hook_event_id, timestamp_ms, file_path,
              multi_edit_index,
              tool_name, new_string_hash, new_string_snippet, new_string_len,
              landed, landed_reason
       FROM intent_edits
       WHERE session_id = ? AND file_path IN (${placeholders})
       ORDER BY timestamp_ms ASC, id ASC`,
    )
    .all(sessionId, ...filePaths) as IntentEditRow[];

  const verdicts = new Map<number, { landed: 0 | 1; reason: LandedReason }>();

  for (const edit of ownEdits) {
    const verdict = decideForEdit(edit, allEditsForFiles);
    verdicts.set(edit.id, verdict);
  }

  const now = Date.now();
  const update = db.prepare(
    `UPDATE intent_edits
     SET landed = ?, landed_reason = ?, landed_checked_at_ms = ?
     WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const [id, v] of verdicts) {
      update.run(v.landed, v.reason, now, id);
    }
  });
  tx();
}

/**
 * Apply the verdict heuristics for one edit.
 *
 * Order:
 *   1. A later Write to the same file is a wholesale replacement → check if
 *      the snippet survives in the Write's content. If not, write_replaced.
 *   2. A later Edit with old_string containing this edit's new_string_snippet
 *      → overwritten_in_session.
 *   3. Disk check on the current file:
 *      - file missing → file_deleted
 *      - snippet present → present_in_file
 *      - snippet absent → reverted_post_session
 */
function decideForEdit(
  edit: IntentEditRow,
  allEditsForFiles: IntentEditRow[],
): { landed: 0 | 1; reason: LandedReason } {
  const snippet = edit.new_string_snippet ?? "";

  // Edits to the same file that happened after this one
  const later = allEditsForFiles.filter(
    (e) =>
      e.file_path === edit.file_path &&
      (e.timestamp_ms > edit.timestamp_ms ||
        (e.timestamp_ms === edit.timestamp_ms && e.id > edit.id)),
  );

  for (const next of later) {
    if (next.tool_name === "Write") {
      // Wholesale replacement — fetch its new_string and check if our snippet
      // survives in it. If yes, defer to disk check; if no, write_replaced.
      const writeContent = fetchEditNewString(next);
      if (writeContent !== null && snippet && !writeContent.includes(snippet)) {
        return { landed: 0, reason: "write_replaced" };
      }
    } else if (next.tool_name === "Edit" || next.tool_name === "MultiEdit") {
      // Check whether any of the next call's old_strings contains our snippet
      const oldStrings = fetchOldStrings(next);
      if (snippet && oldStrings.some((os) => os.includes(snippet))) {
        return { landed: 0, reason: "overwritten_in_session" };
      }
    }
  }

  // Disk check
  const fileContent = readFileSafe(edit.file_path);
  if (fileContent === null) {
    return { landed: 0, reason: "file_deleted" };
  }
  if (!snippet) {
    // Empty snippet (e.g. an Edit that deleted text — new_string was "").
    // Treat as landed if the file still exists; nothing better to do.
    return { landed: 1, reason: "present_in_file" };
  }
  if (fileContent.includes(snippet)) {
    return { landed: 1, reason: "present_in_file" };
  }
  return { landed: 0, reason: "reverted_post_session" };
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Pull the new_string from a hook_events payload for the given intent_edit.
 * For MultiEdit, returns the indexed sub-edit's new_string. For Write,
 * returns tool_input.content.
 */
function fetchEditNewString(edit: IntentEditRow): string | null {
  const payload = decodePayload(edit.hook_event_id);
  if (!payload) return null;
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  if (!toolInput) return null;

  if (edit.tool_name === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : null;
  }
  if (edit.tool_name === "Edit") {
    return typeof toolInput.new_string === "string"
      ? toolInput.new_string
      : null;
  }
  if (edit.tool_name === "MultiEdit") {
    const edits = toolInput.edits;
    if (!Array.isArray(edits)) return null;
    const sub = edits[edit.multi_edit_index] as
      | { new_string?: unknown }
      | undefined;
    return typeof sub?.new_string === "string" ? sub.new_string : null;
  }
  return null;
}

/**
 * For a later Edit/MultiEdit event, return all old_string values so we can
 * check whether any of them contain the prior edit's new_string.
 */
function fetchOldStrings(edit: IntentEditRow): string[] {
  const payload = decodePayload(edit.hook_event_id);
  if (!payload) return [];
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  if (!toolInput) return [];

  if (edit.tool_name === "Edit") {
    return typeof toolInput.old_string === "string"
      ? [toolInput.old_string]
      : [];
  }
  if (edit.tool_name === "MultiEdit") {
    const edits = toolInput.edits;
    if (!Array.isArray(edits)) return [];
    return (edits as Array<{ old_string?: unknown }>)
      .map((e) => e.old_string)
      .filter((v): v is string => typeof v === "string");
  }
  return [];
}

function decodePayload(hookEventId: number): Record<string, unknown> | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT payload FROM hook_events WHERE id = ?`)
    .get(hookEventId) as { payload: Buffer } | undefined;
  if (!row) return null;
  try {
    const json = gunzipSync(row.payload).toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
