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
    edit_count: number;
    current_edit_count: number;
    superseded_edit_count: number;
    reverted_edit_count: number;
    unknown_edit_count: number;
    tool_name: string;
    timestamp_ms: number;
    landed: number | null; // 0 | 1 | null
    landed_reason: string | null;
    new_string_snippet: string | null;
  };
  status: "current" | "superseded" | "reverted" | "mixed" | "unknown";
}

/**
 * Given a file path, return the chronological prompt-history at that location:
 * one row per intent that touched the file, most recent first, annotated with
 * aggregated edit outcomes and the latest representative edit/snippet.
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
  const limit = opts.limit ?? 50;
  const rows = collectIntentForCodeRows(opts.file_path, limit);

  return rows.map((r) => ({
    intent_unit_id: r.intent_unit_id,
    prompt_text: r.prompt_text,
    prompt_ts_ms: r.prompt_ts_ms,
    session_id: r.session_id,
    repository: r.repository,
    edit: {
      intent_edit_id: r.edit_id,
      edit_count: r.edit_count,
      current_edit_count: r.current_edit_count,
      superseded_edit_count: r.superseded_edit_count,
      reverted_edit_count: r.reverted_edit_count,
      unknown_edit_count: r.unknown_edit_count,
      tool_name: r.tool_name,
      timestamp_ms: r.timestamp_ms ?? r.prompt_ts_ms,
      landed: r.landed,
      landed_reason: r.landed_reason,
      new_string_snippet: r.new_string_snippet,
    },
    status: classifyAggregateStatus(r),
  }));
}

interface IntentForCodeCandidateRow {
  intent_unit_id: number;
  prompt_text: string;
  prompt_ts_ms: number;
  session_id: string;
  repository: string | null;
  edit_id: number;
  tool_name: string;
  timestamp_ms: number | null;
  landed: number | null;
  landed_reason: string | null;
  new_string_snippet: string | null;
}

interface IntentForCodeGroupedRow extends IntentForCodeCandidateRow {
  edit_count: number;
  current_edit_count: number;
  superseded_edit_count: number;
  reverted_edit_count: number;
  unknown_edit_count: number;
}

function collectIntentForCodeRows(
  filePath: string,
  limit: number,
): IntentForCodeGroupedRow[] {
  const candidateLimit = Math.max(limit * 20, 200);
  const normalized = loadIntentForCodeRowsFromFileSubjects(
    filePath,
    candidateLimit,
  );
  const legacy = loadIntentForCodeRowsLegacy(filePath, candidateLimit);
  const byEditId = new Map<number, IntentForCodeCandidateRow>();

  for (const row of [...normalized, ...legacy]) {
    if (!byEditId.has(row.edit_id)) {
      byEditId.set(row.edit_id, row);
    }
  }

  const grouped = new Map<number, IntentForCodeGroupedRow>();
  for (const row of byEditId.values()) {
    const key = row.intent_unit_id;
    const existing = grouped.get(key);
    const status = classifyStatus(row.landed, row.landed_reason);
    if (!existing) {
      grouped.set(key, {
        ...row,
        edit_count: 1,
        current_edit_count: status === "current" ? 1 : 0,
        superseded_edit_count: status === "superseded" ? 1 : 0,
        reverted_edit_count: status === "reverted" ? 1 : 0,
        unknown_edit_count: status === "unknown" ? 1 : 0,
      });
      continue;
    }
    existing.edit_count += 1;
    if (status === "current") existing.current_edit_count += 1;
    else if (status === "superseded") existing.superseded_edit_count += 1;
    else if (status === "reverted") existing.reverted_edit_count += 1;
    else existing.unknown_edit_count += 1;
    if (
      (row.timestamp_ms ?? 0) > (existing.timestamp_ms ?? 0) ||
      ((row.timestamp_ms ?? 0) === (existing.timestamp_ms ?? 0) &&
        row.edit_id > existing.edit_id)
    ) {
      existing.edit_id = row.edit_id;
      existing.tool_name = row.tool_name;
      existing.timestamp_ms = row.timestamp_ms;
      existing.landed = row.landed;
      existing.landed_reason = row.landed_reason;
      existing.new_string_snippet = row.new_string_snippet;
    }
  }

  return [...grouped.values()]
    .sort(
      (a, b) =>
        (b.timestamp_ms ?? 0) - (a.timestamp_ms ?? 0) || b.edit_id - a.edit_id,
    )
    .slice(0, limit);
}

function loadIntentForCodeRowsFromFileSubjects(
  filePath: string,
  limit: number,
): IntentForCodeCandidateRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT DISTINCT
              u.id AS intent_unit_id,
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
       FROM active_claims ac_file
       JOIN claims c_file ON c_file.id = ac_file.claim_id
       JOIN claims c_touch
         ON c_touch.subject_kind = 'edit'
        AND c_touch.predicate = 'edit/touches-file'
        AND c_touch.value_text = c_file.subject
       JOIN active_claims ac_touch ON ac_touch.claim_id = c_touch.id
       JOIN intent_edits e ON e.edit_key = c_touch.subject
       JOIN intent_units u ON u.id = e.intent_unit_id
       WHERE c_file.subject_kind = 'file'
         AND c_file.predicate = 'file/path'
         AND c_file.value_text = ?
       ORDER BY COALESCE(e.timestamp_ms, 0) DESC, e.id DESC
       LIMIT ?`,
    )
    .all(filePath, limit) as IntentForCodeCandidateRow[];
}

function loadIntentForCodeRowsLegacy(
  filePath: string,
  limit: number,
): IntentForCodeCandidateRow[] {
  const db = getDb();
  return db
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
       ORDER BY COALESCE(e.timestamp_ms, 0) DESC, e.id DESC
       LIMIT ?`,
    )
    .all(filePath, limit) as IntentForCodeCandidateRow[];
}

function classifyStatus(
  landed: number | null,
  reason: string | null,
): "current" | "superseded" | "reverted" | "unknown" {
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

function classifyAggregateStatus(
  row: Pick<
    IntentForCodeGroupedRow,
    | "current_edit_count"
    | "superseded_edit_count"
    | "reverted_edit_count"
    | "unknown_edit_count"
  >,
): IntentForCodeRow["status"] {
  type AtomicStatus = "current" | "superseded" | "reverted" | "unknown";
  const nonZero = [
    row.current_edit_count > 0 ? "current" : null,
    row.superseded_edit_count > 0 ? "superseded" : null,
    row.reverted_edit_count > 0 ? "reverted" : null,
    row.unknown_edit_count > 0 ? "unknown" : null,
  ].filter((value): value is AtomicStatus => value !== null);

  if (nonZero.length === 0) return "unknown";
  if (nonZero.length > 1) return "mixed";
  return nonZero[0];
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
