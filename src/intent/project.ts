import { performance } from "node:perf_hooks";
import { config } from "../config.js";
import { getDb } from "../db/schema.js";
import { resolveFilePathFromCwd } from "../paths.js";
import { rebuildSessionSummaryProjections } from "../session_summaries/project.js";
import { loadActiveEdits, loadActiveIntents } from "./claimViews.js";

export function rebuildIntentProjection(opts?: { sessionId?: string }): {
  intents: number;
  edits: number;
  sessionSummaries: number;
  memberships: number;
  provenance: number;
  activeIntentsLoaded: number;
  activeEditsLoaded: number;
  activeLoadMs: number;
} {
  const db = getDb();
  const loadStartedAt = performance.now();
  const activeIntents = loadActiveIntents(opts);
  const activeEdits = loadActiveEdits(opts);
  const activeLoadMs = performance.now() - loadStartedAt;
  const intents = new Map(
    [...activeIntents].filter(([, intent]) => {
      if (!intent.sessionId) return false;
      if (opts?.sessionId && intent.sessionId !== opts.sessionId) return false;
      // Active claims already encode source precedence per subject. The
      // projector should not discard scanner-only intents just because the
      // session later gained some hook coverage.
      return true;
    }),
  );
  const edits = new Map(
    [...activeEdits].filter(([, edit]) => {
      if (!edit.intentKey) return false;
      const intent = intents.get(edit.intentKey);
      if (!intent?.sessionId) return false;
      // For hook-backed sessions, trust hook prompt boundaries, but keep
      // scanner-backed edits that attach to those surviving intents. This is
      // required for targets like Codex where hooks may only observe Bash
      // while the scanner sees structured file edits such as apply_patch.
      return true;
    }),
  );

  const tx = db.transaction(() => {
    if (opts?.sessionId) {
      db.prepare(
        `DELETE FROM intent_units_fts
         WHERE rowid IN (
           SELECT id FROM intent_units WHERE session_id = ?
         )`,
      ).run(opts.sessionId);
      db.prepare(`DELETE FROM intent_edits WHERE session_id = ?`).run(
        opts.sessionId,
      );
      db.prepare(`DELETE FROM intent_units WHERE session_id = ?`).run(
        opts.sessionId,
      );
    } else {
      db.prepare(`DELETE FROM intent_units_fts`).run();
      db.prepare(`DELETE FROM intent_edits`).run();
      db.prepare(`DELETE FROM intent_units`).run();
    }

    const intentRows = [...intents.values()].sort(
      (a, b) =>
        (a.promptTsMs ?? 0) - (b.promptTsMs ?? 0) ||
        a.intentKey.localeCompare(b.intentKey),
    );
    const unitStmt = db.prepare(
      `INSERT INTO intent_units
       (intent_key, session_id, prompt_text, prompt_ts_ms, next_prompt_ts_ms,
        edit_count, landed_count, reconciled_at_ms, cwd, repository)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ftsStmt = db.prepare(
      `INSERT INTO intent_units_fts(rowid, prompt_text) VALUES (?, ?)`,
    );
    const editStmt = db.prepare(
      `INSERT INTO intent_edits
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
      {
        edits: number;
        landed: number;
        unresolved: number;
        latestTimestampMs: number | null;
      }
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
        latestTimestampMs: null,
      };
      stat.edits += 1;
      if (landed === 1) stat.landed += 1;
      if (landed === null) stat.unresolved += 1;
      if (
        typeof edit.timestampMs === "number" &&
        (stat.latestTimestampMs === null ||
          edit.timestampMs > stat.latestTimestampMs)
      ) {
        stat.latestTimestampMs = edit.timestampMs;
      }
      stats.set(edit.intentKey, stat);
    }

    const updateStmt = db.prepare(
      `UPDATE intent_units
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
        latestTimestampMs: null,
      };
      const isClosed = intent.closedAtMs != null;
      const landedCount = !isClosed || stat.unresolved > 0 ? null : stat.landed;
      const reconciledAtMs =
        isClosed && stat.edits > 0 && stat.unresolved === 0
          ? Math.max(intent.closedAtMs ?? 0, stat.latestTimestampMs ?? 0)
          : null;
      updateStmt.run(stat.edits, landedCount, reconciledAtMs, unitId);
    }
  });
  tx();

  const local = config.enableSessionSummaryProjections
    ? rebuildSessionSummaryProjections(opts)
    : {
        sessionSummaries: 0,
        memberships: 0,
        provenance: 0,
      };

  return {
    intents: intents.size,
    edits: edits.size,
    activeIntentsLoaded: activeIntents.size,
    activeEditsLoaded: activeEdits.size,
    activeLoadMs,
    ...local,
  };
}

function normalizeFilePath(filePath: string, cwd: string | null): string {
  return resolveFilePathFromCwd(filePath, cwd);
}
