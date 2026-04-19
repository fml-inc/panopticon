import path from "node:path";
import { getDb } from "../db/schema.js";
import { loadActiveEdits, loadActiveIntents } from "./claimViews.js";

export function rebuildIntentProjection(opts?: { sessionId?: string }): {
  intents: number;
  edits: number;
} {
  const db = getDb();
  const hookBackedSessions = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT session_id
           FROM hook_events
           WHERE event_type = 'UserPromptSubmit'
           ${opts?.sessionId ? "AND session_id = ?" : ""}`,
        )
        .all(...(opts?.sessionId ? [opts.sessionId] : [])) as Array<{
        session_id: string;
      }>
    ).map((row) => row.session_id),
  );
  const intents = new Map(
    [...loadActiveIntents()].filter(([, intent]) => {
      if (!intent.sessionId) return false;
      if (opts?.sessionId && intent.sessionId !== opts.sessionId) return false;
      if (!hookBackedSessions.has(intent.sessionId)) return true;
      return intent.promptTsSource === "hook";
    }),
  );
  const edits = new Map(
    [...loadActiveEdits()].filter(([, edit]) => {
      if (!edit.intentKey) return false;
      const intent = intents.get(edit.intentKey);
      if (!intent?.sessionId) return false;
      if (!hookBackedSessions.has(intent.sessionId)) return true;
      return edit.timestampSource === "hook";
    }),
  );

  const tx = db.transaction(() => {
    if (opts?.sessionId) {
      const rows = db
        .prepare(`SELECT id FROM intent_units_v2 WHERE session_id = ?`)
        .all(opts.sessionId) as Array<{ id: number }>;
      const ids = rows.map((row) => row.id);
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(
          `DELETE FROM intent_units_fts_v2 WHERE rowid IN (${placeholders})`,
        ).run(...ids);
      }
      db.prepare(`DELETE FROM intent_edits_v2 WHERE session_id = ?`).run(
        opts.sessionId,
      );
      db.prepare(`DELETE FROM intent_units_v2 WHERE session_id = ?`).run(
        opts.sessionId,
      );
    } else {
      db.prepare(`DELETE FROM intent_units_fts_v2`).run();
      db.prepare(`DELETE FROM intent_edits_v2`).run();
      db.prepare(`DELETE FROM intent_units_v2`).run();
    }

    const intentRows = [...intents.values()].sort(
      (a, b) =>
        (a.promptTsMs ?? 0) - (b.promptTsMs ?? 0) ||
        a.intentKey.localeCompare(b.intentKey),
    );
    const unitStmt = db.prepare(
      `INSERT INTO intent_units_v2
       (intent_key, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms,
        edit_count, landed_count, reconciled_at_ms, cwd, repository)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ftsStmt = db.prepare(
      `INSERT INTO intent_units_fts_v2(rowid, prompt_text) VALUES (?, ?)`,
    );
    const editStmt = db.prepare(
      `INSERT INTO intent_edits_v2
       (edit_key, intent_unit_id, session_id, timestamp_ms, file_path,
        tool_name, multi_edit_index, new_string_hash, new_string_snippet,
        landed, landed_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const unitIds = new Map<string, number>();
    for (const intent of intentRows) {
      unitStmt.run(
        intent.intentKey,
        intent.sessionId ?? null,
        intent.promptText ?? "",
        intent.promptTsMs ?? null,
        intent.closedAtMs ?? null,
        0,
        null,
        null,
        intent.cwd ?? null,
        intent.repository ?? null,
      );
      const row = db.prepare(`SELECT last_insert_rowid() AS id`).get() as {
        id: number;
      };
      unitIds.set(intent.intentKey, row.id);
      ftsStmt.run(row.id, intent.promptText ?? "");
    }

    const stats = new Map<
      string,
      { edits: number; landed: number; unresolved: number }
    >();
    for (const edit of edits.values()) {
      if (!edit.intentKey || !edit.filePath) continue;
      const unitId = unitIds.get(edit.intentKey);
      if (!unitId) continue;
      const intent = intents.get(edit.intentKey);
      const sessionId = intent?.sessionId ?? null;
      const landed =
        edit.landedStatus === "landed"
          ? 1
          : edit.landedStatus === "churned"
            ? 0
            : null;
      editStmt.run(
        edit.editKey,
        unitId,
        sessionId,
        edit.timestampMs ?? null,
        normalizeFilePath(edit.filePath, intent?.cwd ?? null),
        edit.toolName ?? null,
        edit.multiEditIndex ?? 0,
        edit.newStringHash ?? null,
        edit.newStringSnippet ?? null,
        landed,
        edit.landedReason ?? null,
      );
      const stat = stats.get(edit.intentKey) ?? {
        edits: 0,
        landed: 0,
        unresolved: 0,
      };
      stat.edits += 1;
      if (landed === 1) stat.landed += 1;
      if (landed === null) stat.unresolved += 1;
      stats.set(edit.intentKey, stat);
    }

    const updateStmt = db.prepare(
      `UPDATE intent_units_v2
       SET edit_count = ?, landed_count = ?, reconciled_at_ms = ?
       WHERE id = ?`,
    );
    for (const intent of intentRows) {
      const unitId = unitIds.get(intent.intentKey);
      if (!unitId) continue;
      const stat = stats.get(intent.intentKey) ?? {
        edits: 0,
        landed: 0,
        unresolved: 0,
      };
      const isClosed = intent.closedAtMs != null;
      const landedCount = !isClosed || stat.unresolved > 0 ? null : stat.landed;
      const reconciledAtMs =
        isClosed && stat.edits > 0 && stat.unresolved === 0 ? Date.now() : null;
      updateStmt.run(stat.edits, landedCount, reconciledAtMs, unitId);
    }
  });
  tx();

  return {
    intents: intents.size,
    edits: edits.size,
  };
}

function normalizeFilePath(filePath: string, cwd: string | null): string {
  if (path.isAbsolute(filePath) || !cwd) return filePath;
  return path.resolve(cwd, filePath);
}
