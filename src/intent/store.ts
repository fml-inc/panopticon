/**
 * Storage helpers for the intent index (intent_units / intent_edits).
 *
 * Schema is sync-agnostic: every row gets a `local_uuid` so a future fml-based
 * sync layer can ship facts to a shared store using stable cross-machine IDs.
 */
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../db/schema.js";

const SNIPPET_LEN = 200;

export interface OpenIntentUnit {
  id: number;
  session_id: string;
  prompt_ts_ms: number;
}

export interface IntentEditInput {
  intent_unit_id: number;
  session_id: string;
  hook_event_id: number;
  multi_edit_index: number;
  timestamp_ms: number;
  file_path: string;
  tool_name: string; // 'Edit' | 'Write' | 'MultiEdit'
  new_string: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Find the open intent unit (no next_prompt_ts_ms yet) for a session.
 * There should be at most one — UserPromptSubmit always closes the prior open
 * unit before opening a new one.
 */
export function getOpenIntentUnit(sessionId: string): OpenIntentUnit | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, session_id, prompt_ts_ms
       FROM intent_units
       WHERE session_id = ? AND next_prompt_ts_ms IS NULL
       ORDER BY prompt_ts_ms DESC
       LIMIT 1`,
    )
    .get(sessionId) as
    | {
        id: number;
        session_id: string;
        prompt_ts_ms: number;
      }
    | undefined;
  return row ?? null;
}

/**
 * Open a new intent unit for a UserPromptSubmit. Closes any prior open unit
 * in the same session by stamping its next_prompt_ts_ms.
 *
 * Returns the new intent_unit row id, or null if the prompt text was empty.
 */
export function openIntentUnit(args: {
  session_id: string;
  prompt_event_id: number;
  prompt_text: string;
  prompt_ts_ms: number;
  cwd?: string | null;
  repository?: string | null;
}): number | null {
  if (!args.prompt_text || args.prompt_text.trim() === "") return null;
  const db = getDb();

  const tx = db.transaction(() => {
    // Close any prior open unit in this session
    db.prepare(
      `UPDATE intent_units
       SET next_prompt_ts_ms = ?
       WHERE session_id = ? AND next_prompt_ts_ms IS NULL`,
    ).run(args.prompt_ts_ms, args.session_id);

    const uuid = randomUUID();
    db.prepare(
      `INSERT INTO intent_units
         (local_uuid, session_id, prompt_event_id, prompt_text, prompt_ts_ms,
          cwd, repository)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuid,
      args.session_id,
      args.prompt_event_id,
      args.prompt_text,
      args.prompt_ts_ms,
      args.cwd ?? null,
      args.repository ?? null,
    );
    const { id } = db.prepare("SELECT last_insert_rowid() as id").get() as {
      id: number;
    };
    db.prepare(
      "INSERT INTO intent_units_fts(rowid, prompt_text) VALUES (?, ?)",
    ).run(id, args.prompt_text);
    return id;
  });
  return tx();
}

/**
 * Append one intent_edit row. Bumps the parent intent_unit's edit_count.
 */
export function insertIntentEdit(input: IntentEditInput): number {
  const db = getDb();
  const snippet = input.new_string.slice(0, SNIPPET_LEN);
  const hash = sha256Hex(input.new_string);
  const uuid = randomUUID();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO intent_edits
         (local_uuid, intent_unit_id, session_id, hook_event_id, multi_edit_index,
          timestamp_ms, file_path, tool_name,
          new_string_hash, new_string_snippet, new_string_len)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuid,
      input.intent_unit_id,
      input.session_id,
      input.hook_event_id,
      input.multi_edit_index,
      input.timestamp_ms,
      input.file_path,
      input.tool_name,
      hash,
      snippet,
      input.new_string.length,
    );
    const { id } = db.prepare("SELECT last_insert_rowid() as id").get() as {
      id: number;
    };
    db.prepare(
      `UPDATE intent_units SET edit_count = edit_count + 1 WHERE id = ?`,
    ).run(input.intent_unit_id);
    return id;
  });
  return tx();
}

/**
 * Mark every open intent unit in a session as closed at the given timestamp.
 * Called on Stop / SessionEnd so we don't leave dangling open units.
 */
export function closeOpenIntentUnits(
  sessionId: string,
  timestampMs: number,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE intent_units
     SET next_prompt_ts_ms = ?
     WHERE session_id = ? AND next_prompt_ts_ms IS NULL`,
  ).run(timestampMs, sessionId);
}
