/**
 * Query helpers backing the intent_for_code / search_intent /
 * outcomes_for_intent MCP tools. Read-only.
 */
import { getDb } from "../db/schema.js";

// ── intent_for_code ────────────────────────────────────────────────────────

export interface IntentForCodeRow {
  intent_unit_id: number;
  prompt_text: string;
  prompt_ts_ms: number;
  session_id: string;
  repository: string | null;
  edit: {
    intent_edit_id: number;
    tool_name: string;
    timestamp_ms: number;
    landed: number | null; // 0 | 1 | null
    landed_reason: string | null;
    new_string_snippet: string | null;
  };
  status: "current" | "superseded" | "reverted" | "unknown";
}

/**
 * Given a file path, return the chronological prompt-history at that location:
 * every intent that touched the file, most recent first, annotated with
 * whether the inserted content is still in the file today.
 *
 * `status` summarizes:
 *   - 'current'    → landed=1 (snippet still present)
 *   - 'superseded' → landed=0 with reason indicating in-session overwrite
 *   - 'reverted'   → landed=0 with reason indicating post-session removal
 *   - 'unknown'    → landed IS NULL (not yet reconciled — open or fresh unit)
 */
export function intentForCode(opts: {
  file_path: string;
  limit?: number;
}): IntentForCodeRow[] {
  const db = getDb();
  const limit = opts.limit ?? 50;

  const rows = db
    .prepare(
      `SELECT u.id AS intent_unit_id,
              u.prompt_text,
              u.prompt_ts_ms,
              u.session_id,
              u.repository,
              e.id AS edit_id,
              e.tool_name,
              e.timestamp_ms,
              e.landed,
              e.landed_reason,
              e.new_string_snippet
       FROM intent_edits_v2 e
       JOIN intent_units_v2 u ON u.id = e.intent_unit_id
       WHERE e.file_path = ?
       ORDER BY e.timestamp_ms DESC
       LIMIT ?`,
    )
    .all(opts.file_path, limit) as Array<{
    intent_unit_id: number;
    prompt_text: string;
    prompt_ts_ms: number;
    session_id: string;
    repository: string | null;
    edit_id: number;
    tool_name: string;
    timestamp_ms: number;
    landed: number | null;
    landed_reason: string | null;
    new_string_snippet: string | null;
  }>;

  return rows.map((r) => ({
    intent_unit_id: r.intent_unit_id,
    prompt_text: r.prompt_text,
    prompt_ts_ms: r.prompt_ts_ms,
    session_id: r.session_id,
    repository: r.repository,
    edit: {
      intent_edit_id: r.edit_id,
      tool_name: r.tool_name,
      timestamp_ms: r.timestamp_ms,
      landed: r.landed,
      landed_reason: r.landed_reason,
      new_string_snippet: r.new_string_snippet,
    },
    status: classifyStatus(r.landed, r.landed_reason),
  }));
}

function classifyStatus(
  landed: number | null,
  reason: string | null,
): IntentForCodeRow["status"] {
  if (landed === null) return "unknown";
  if (landed === 1) return "current";
  if (reason === "overwritten_in_session" || reason === "write_replaced") {
    return "superseded";
  }
  if (reason === "reverted_post_session" || reason === "file_deleted") {
    return "reverted";
  }
  return "unknown";
}

// ── search_intent ──────────────────────────────────────────────────────────

export interface SearchIntentRow {
  intent_unit_id: number;
  prompt_text: string;
  prompt_ts_ms: number;
  session_id: string;
  repository: string | null;
  edit_count: number;
  landed_count: number | null;
  landed_ratio: number | null;
  files: Array<{
    file_path: string;
    landed: number | null;
    landed_reason: string | null;
  }>;
}

/**
 * FTS5 search over prompt_text. Defaults to `only_landed=true` (excludes units
 * with zero landed edits). When embeddings ship later, this same signature can
 * route to vector search behind the scenes.
 */
export function searchIntent(opts: {
  query: string;
  only_landed?: boolean;
  repository?: string;
  limit?: number;
  offset?: number;
}): SearchIntentRow[] {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const onlyLanded = opts.only_landed !== false; // default true

  const params: Record<string, unknown> = {
    q: opts.query,
    limit,
    offset,
  };

  let where = `intent_units_fts_v2 MATCH @q`;
  if (opts.repository) {
    where += ` AND u.repository = @repository`;
    params.repository = opts.repository;
  }
  if (onlyLanded) {
    // landed_count IS NOT NULL → reconciled
    // landed_count > 0 → at least one edit survived
    where += ` AND u.landed_count IS NOT NULL AND u.landed_count > 0`;
  }

  const units = db
    .prepare(
      `SELECT u.id AS intent_unit_id,
              u.prompt_text,
              u.prompt_ts_ms,
              u.session_id,
              u.repository,
              u.edit_count,
              u.landed_count
       FROM intent_units_fts_v2
       JOIN intent_units_v2 u ON u.id = intent_units_fts_v2.rowid
       WHERE ${where}
       ORDER BY rank
       LIMIT @limit OFFSET @offset`,
    )
    .all(params) as Array<{
    intent_unit_id: number;
    prompt_text: string;
    prompt_ts_ms: number;
    session_id: string;
    repository: string | null;
    edit_count: number;
    landed_count: number | null;
  }>;

  if (units.length === 0) return [];

  const ids = units.map((u) => u.intent_unit_id);
  const placeholders = ids.map(() => "?").join(",");
  const editRows = db
    .prepare(
      `SELECT intent_unit_id, file_path, landed, landed_reason
       FROM intent_edits_v2
       WHERE intent_unit_id IN (${placeholders})
       ORDER BY timestamp_ms ASC`,
    )
    .all(...ids) as Array<{
    intent_unit_id: number;
    file_path: string;
    landed: number | null;
    landed_reason: string | null;
  }>;

  const filesByUnit = new Map<
    number,
    Array<{
      file_path: string;
      landed: number | null;
      landed_reason: string | null;
    }>
  >();
  for (const r of editRows) {
    if (!filesByUnit.has(r.intent_unit_id)) {
      filesByUnit.set(r.intent_unit_id, []);
    }
    filesByUnit.get(r.intent_unit_id)!.push({
      file_path: r.file_path,
      landed: r.landed,
      landed_reason: r.landed_reason,
    });
  }

  return units.map((u) => ({
    intent_unit_id: u.intent_unit_id,
    prompt_text: u.prompt_text,
    prompt_ts_ms: u.prompt_ts_ms,
    session_id: u.session_id,
    repository: u.repository,
    edit_count: u.edit_count,
    landed_count: u.landed_count,
    landed_ratio:
      u.landed_count !== null && u.edit_count > 0
        ? u.landed_count / u.edit_count
        : null,
    files: filesByUnit.get(u.intent_unit_id) ?? [],
  }));
}

// ── outcomes_for_intent ────────────────────────────────────────────────────

export interface OutcomesForIntentResult {
  intent_unit_id: number;
  prompt_text: string;
  session_id: string;
  prompt_ts_ms: number;
  next_prompt_ts_ms: number | null;
  reconciled_at_ms: number | null;
  edit_count: number;
  landed_count: number | null;
  t0_session_end: {
    edits_survived: Array<{
      intent_edit_id: number;
      file_path: string;
      tool_name: string;
      reason: string | null;
    }>;
    edits_churned: Array<{
      intent_edit_id: number;
      file_path: string;
      tool_name: string;
      reason: string | null;
    }>;
    edits_unknown: Array<{
      intent_edit_id: number;
      file_path: string;
      tool_name: string;
    }>;
  };
}

export function outcomesForIntent(opts: {
  intent_unit_id: number;
}): OutcomesForIntentResult | null {
  const db = getDb();

  const unit = db
    .prepare(
      `SELECT id, prompt_text, session_id, prompt_ts_ms, next_prompt_ts_ms,
              reconciled_at_ms, edit_count, landed_count
       FROM intent_units_v2 WHERE id = ?`,
    )
    .get(opts.intent_unit_id) as
    | {
        id: number;
        prompt_text: string;
        session_id: string;
        prompt_ts_ms: number;
        next_prompt_ts_ms: number | null;
        reconciled_at_ms: number | null;
        edit_count: number;
        landed_count: number | null;
      }
    | undefined;
  if (!unit) return null;

  const edits = db
    .prepare(
      `SELECT id, file_path, tool_name, landed, landed_reason
       FROM intent_edits_v2
       WHERE intent_unit_id = ?
       ORDER BY timestamp_ms ASC, id ASC`,
    )
    .all(opts.intent_unit_id) as Array<{
    id: number;
    file_path: string;
    tool_name: string;
    landed: number | null;
    landed_reason: string | null;
  }>;

  const survived: OutcomesForIntentResult["t0_session_end"]["edits_survived"] =
    [];
  const churned: OutcomesForIntentResult["t0_session_end"]["edits_churned"] =
    [];
  const unknown: OutcomesForIntentResult["t0_session_end"]["edits_unknown"] =
    [];

  for (const e of edits) {
    if (e.landed === null) {
      unknown.push({
        intent_edit_id: e.id,
        file_path: e.file_path,
        tool_name: e.tool_name,
      });
    } else if (e.landed === 1) {
      survived.push({
        intent_edit_id: e.id,
        file_path: e.file_path,
        tool_name: e.tool_name,
        reason: e.landed_reason,
      });
    } else {
      churned.push({
        intent_edit_id: e.id,
        file_path: e.file_path,
        tool_name: e.tool_name,
        reason: e.landed_reason,
      });
    }
  }

  return {
    intent_unit_id: unit.id,
    prompt_text: unit.prompt_text,
    session_id: unit.session_id,
    prompt_ts_ms: unit.prompt_ts_ms,
    next_prompt_ts_ms: unit.next_prompt_ts_ms,
    reconciled_at_ms: unit.reconciled_at_ms,
    edit_count: unit.edit_count,
    landed_count: unit.landed_count,
    t0_session_end: {
      edits_survived: survived,
      edits_churned: churned,
      edits_unknown: unknown,
    },
  };
}

// ── diff_intent_projection_v1_vs_v2 ────────────────────────────────────────

export interface IntentProjectionDiffResult {
  unitCounts: { v1: number; v2: number };
  editCounts: { v1: number; v2: number };
  unitsOnlyInV1: Array<{
    session_id: string;
    seq: number;
    prompt_text: string;
  }>;
  unitsOnlyInV2: Array<{
    session_id: string;
    seq: number;
    prompt_text: string;
  }>;
  mismatches: Array<{
    session_id: string;
    seq: number;
    promptTextEqual: boolean;
    promptTsEqual: boolean;
    repositoryEqual: boolean;
    editCountEqual: boolean;
    landedCountEqual: boolean;
    fileSetEqual: boolean;
    v1: {
      prompt_text: string;
      prompt_ts_ms: number | null;
      repository: string | null;
      edit_count: number;
      landed_count: number | null;
      files: string[];
    };
    v2: {
      prompt_text: string;
      prompt_ts_ms: number | null;
      repository: string | null;
      edit_count: number;
      landed_count: number | null;
      files: string[];
    };
  }>;
}

interface IntentProjectionUnit {
  session_id: string;
  prompt_text: string;
  prompt_ts_ms: number | null;
  repository: string | null;
  edit_count: number;
  landed_count: number | null;
  files: string[];
}

export function diffIntentProjectionV1VsV2(opts?: {
  session_id?: string;
  limit?: number;
  shared_sessions_only?: boolean;
}): IntentProjectionDiffResult {
  const _db = getDb();
  const limit = opts?.limit ?? 100;
  const sessionFilter = opts?.session_id ? "WHERE session_id = ?" : "";
  const params = opts?.session_id ? [opts.session_id] : [];

  const v1 = loadIntentProjectionUnits(
    "intent_units",
    "intent_edits",
    sessionFilter,
    params,
  );
  const v2 = loadIntentProjectionUnits(
    "intent_units_v2",
    "intent_edits_v2",
    sessionFilter,
    params,
  );

  const sessions = opts?.shared_sessions_only
    ? new Set<string>([...v1.keys()].filter((sessionId) => v2.has(sessionId)))
    : new Set<string>([...v1.keys(), ...v2.keys()]);
  const unitsOnlyInV1: IntentProjectionDiffResult["unitsOnlyInV1"] = [];
  const unitsOnlyInV2: IntentProjectionDiffResult["unitsOnlyInV2"] = [];
  const mismatches: IntentProjectionDiffResult["mismatches"] = [];

  for (const sessionId of [...sessions].sort()) {
    const left = v1.get(sessionId) ?? [];
    const right = v2.get(sessionId) ?? [];
    const max = Math.max(left.length, right.length);
    for (let i = 0; i < max; i += 1) {
      const a = left[i];
      const b = right[i];
      const seq = i + 1;
      if (a && !b) {
        if (unitsOnlyInV1.length < limit) {
          unitsOnlyInV1.push({
            session_id: sessionId,
            seq,
            prompt_text: a.prompt_text,
          });
        }
        continue;
      }
      if (!a && b) {
        if (unitsOnlyInV2.length < limit) {
          unitsOnlyInV2.push({
            session_id: sessionId,
            seq,
            prompt_text: b.prompt_text,
          });
        }
        continue;
      }
      if (!a || !b) continue;
      const promptTextEqual = a.prompt_text === b.prompt_text;
      const promptTsEqual = a.prompt_ts_ms === b.prompt_ts_ms;
      const repositoryEqual = a.repository === b.repository;
      const editCountEqual = a.edit_count === b.edit_count;
      const landedCountEqual = a.landed_count === b.landed_count;
      const fileSetEqual = sameArray(a.files, b.files);
      if (
        !promptTextEqual ||
        !promptTsEqual ||
        !repositoryEqual ||
        !editCountEqual ||
        !landedCountEqual ||
        !fileSetEqual
      ) {
        if (mismatches.length < limit) {
          mismatches.push({
            session_id: sessionId,
            seq,
            promptTextEqual,
            promptTsEqual,
            repositoryEqual,
            editCountEqual,
            landedCountEqual,
            fileSetEqual,
            v1: a,
            v2: b,
          });
        }
      }
    }
  }

  return {
    unitCounts: {
      v1: [...v1.values()].reduce((sum, rows) => sum + rows.length, 0),
      v2: [...v2.values()].reduce((sum, rows) => sum + rows.length, 0),
    },
    editCounts: {
      v1: countProjectionEdits("intent_edits", opts?.session_id),
      v2: countProjectionEdits("intent_edits_v2", opts?.session_id),
    },
    unitsOnlyInV1,
    unitsOnlyInV2,
    mismatches,
  };
}

function loadIntentProjectionUnits(
  unitsTable: "intent_units" | "intent_units_v2",
  editsTable: "intent_edits" | "intent_edits_v2",
  sessionFilter: string,
  params: unknown[],
): Map<string, IntentProjectionUnit[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT u.id,
              u.session_id,
              u.prompt_text,
              u.prompt_ts_ms,
              u.repository,
              u.edit_count,
              u.landed_count
       FROM ${unitsTable} u
       ${sessionFilter}
       ORDER BY u.session_id ASC, u.prompt_ts_ms ASC, u.id ASC`,
    )
    .all(...params) as Array<{
    id: number;
    session_id: string;
    prompt_text: string;
    prompt_ts_ms: number | null;
    repository: string | null;
    edit_count: number;
    landed_count: number | null;
  }>;

  const result = new Map<string, IntentProjectionUnit[]>();
  const fileStmt = db.prepare(
    `SELECT file_path
     FROM ${editsTable}
     WHERE intent_unit_id = ?
     ORDER BY file_path ASC, id ASC`,
  );
  for (const row of rows) {
    const files = (fileStmt.all(row.id) as Array<{ file_path: string }>).map(
      (entry) => entry.file_path,
    );
    const list = result.get(row.session_id) ?? [];
    list.push({
      session_id: row.session_id,
      prompt_text: row.prompt_text,
      prompt_ts_ms: row.prompt_ts_ms,
      repository: row.repository,
      edit_count: row.edit_count,
      landed_count: row.landed_count,
      files,
    });
    result.set(row.session_id, list);
  }
  return result;
}

function countProjectionEdits(
  table: "intent_edits" | "intent_edits_v2",
  sessionId?: string,
): number {
  const db = getDb();
  if (sessionId) {
    return (
      db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as { c: number }
    ).c;
  }
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  ).c;
}

function sameArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}
