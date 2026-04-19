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
       FROM intent_edits e
       JOIN intent_units u ON u.id = e.intent_unit_id
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

  let where = `intent_units_fts MATCH @q`;
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
       FROM intent_units_fts
       JOIN intent_units u ON u.id = intent_units_fts.rowid
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
       FROM intent_edits
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
       FROM intent_units WHERE id = ?`,
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
       FROM intent_edits
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
