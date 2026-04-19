import { getDb } from "../db/schema.js";
import { intentForCode } from "../intent/query.js";
import { resolveFilePathFromCwd } from "../paths.js";
import { rebuildLocalWorkProjections } from "./project.js";

export interface WorkstreamRow {
  workstream_id: number;
  workstream_key: string;
  title: string;
  status: "active" | "landed" | "mixed" | "abandoned";
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: string | null;
  actor: string | null;
  machine: string;
  origin_scope: string;
  first_intent_ts_ms: number | null;
  last_intent_ts_ms: number | null;
  intent_count: number;
  edit_count: number;
  landed_edit_count: number;
  open_edit_count: number;
}

export interface WorkstreamDetailResult {
  workstream: WorkstreamRow | null;
  intents: Array<{
    intent_unit_id: number;
    prompt_text: string;
    prompt_ts_ms: number | null;
    session_id: string;
    membership_kind: string;
    score: number;
  }>;
  files: Array<{
    file_path: string;
    edit_count: number;
    landed_count: number;
  }>;
}

export interface WhyCodeResult {
  path: string;
  line: number | null;
  match_level: "span" | "file" | "none";
  status: "current" | "ambiguous" | "stale" | "none";
  confidence: number;
  repository: string | null;
  workstream: {
    workstream_id: number;
    title: string;
    status: string;
  } | null;
  intent: {
    intent_unit_id: number;
    prompt_text: string;
    session_id: string;
    prompt_ts_ms: number | null;
  } | null;
  edit: {
    intent_edit_id: number | null;
    file_path: string;
    tool_name: string | null;
    timestamp_ms: number | null;
    landed: number | null;
    landed_reason: string | null;
    snippet_preview: string | null;
  } | null;
  binding: {
    binding_level: "span" | "file" | "none";
    start_line: number | null;
    end_line: number | null;
    symbol_kind: string | null;
    symbol_name: string | null;
  } | null;
  evidence: {
    intent_for_code: ReturnType<typeof intentForCode>;
  };
  related_candidates: Array<{
    intent_unit_id: number;
    workstream_id: number | null;
    reason: string;
    confidence: number;
    status: string;
  }>;
}

export interface RecentWorkOnPathResult {
  path: string;
  repository: string | null;
  recent: Array<{
    workstream_id: number | null;
    workstream_title: string | null;
    intent_unit_id: number;
    prompt_text: string;
    intent_edit_id: number;
    timestamp_ms: number | null;
    status: string;
  }>;
}

export function listWorkstreams(opts?: {
  repository?: string;
  cwd?: string;
  status?: "active" | "landed" | "mixed" | "abandoned";
  path?: string;
  since?: string;
  limit?: number;
  offset?: number;
}): WorkstreamRow[] {
  ensureLocalWorkProjections();
  const db = getDb();
  const params: unknown[] = [];
  let sql = `
    SELECT DISTINCT w.id AS workstream_id,
           w.workstream_key,
           w.title,
           w.status,
           w.repository,
           w.cwd,
           w.branch,
           w.worktree,
           w.actor,
           w.machine,
           w.origin_scope,
           w.first_intent_ts_ms,
           w.last_intent_ts_ms,
           w.intent_count,
           w.edit_count,
           w.landed_edit_count,
           w.open_edit_count
    FROM workstreams w`;

  if (opts?.path) {
    sql += `
      INNER JOIN code_provenance cp
        ON cp.workstream_id = w.id AND cp.file_path = ?`;
    params.push(normalizeLookupPath(opts.path, opts.repository));
  }

  const where: string[] = [];
  if (opts?.repository) {
    where.push("w.repository = ?");
    params.push(opts.repository);
  }
  if (opts?.cwd) {
    where.push("w.cwd = ?");
    params.push(opts.cwd);
  }
  if (opts?.status) {
    where.push("w.status = ?");
    params.push(opts.status);
  }
  if (opts?.since) {
    const sinceMs = parseSince(opts.since);
    if (sinceMs !== null) {
      where.push("COALESCE(w.last_intent_ts_ms, 0) >= ?");
      params.push(sinceMs);
    }
  }
  if (where.length > 0) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }
  sql += ` ORDER BY COALESCE(w.last_intent_ts_ms, 0) DESC, w.id DESC`;
  sql += ` LIMIT ? OFFSET ?`;
  params.push(opts?.limit ?? 20, opts?.offset ?? 0);

  return (
    db.prepare(sql).all(...params) as Array<{
      workstream_id: number;
      workstream_key: string;
      title: string;
      status: WorkstreamRow["status"];
      repository: string | null;
      cwd: string | null;
      branch: string | null;
      worktree: string | null;
      actor: string | null;
      machine: string;
      origin_scope: string;
      first_intent_ts_ms: number | null;
      last_intent_ts_ms: number | null;
      intent_count: number;
      edit_count: number;
      landed_edit_count: number;
      open_edit_count: number;
    }>
  ).map((row) => ({
    ...row,
    repository: emptyToNull(row.repository),
  }));
}

export function workstreamDetail(opts: {
  workstream_id: number;
}): WorkstreamDetailResult | null {
  ensureLocalWorkProjections();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id AS workstream_id,
              workstream_key,
              title,
              status,
              repository,
              cwd,
              branch,
              worktree,
              actor,
              machine,
              origin_scope,
              first_intent_ts_ms,
              last_intent_ts_ms,
              intent_count,
              edit_count,
              landed_edit_count,
              open_edit_count
       FROM workstreams
       WHERE id = ?`,
    )
    .get(opts.workstream_id) as
    | (Omit<WorkstreamRow, "repository"> & { repository: string | null })
    | undefined;
  if (!row) return null;

  const intents = db
    .prepare(
      `SELECT u.id AS intent_unit_id,
              u.prompt_text,
              u.prompt_ts_ms,
              u.session_id,
              iw.membership_kind,
              iw.score
       FROM intent_workstreams iw
       JOIN intent_units u ON u.id = iw.intent_unit_id
       WHERE iw.workstream_id = ?
       ORDER BY COALESCE(u.prompt_ts_ms, 0) ASC, u.id ASC`,
    )
    .all(opts.workstream_id) as WorkstreamDetailResult["intents"];

  const files = db
    .prepare(
      `SELECT e.file_path,
              COUNT(*) AS edit_count,
              SUM(CASE WHEN e.landed = 1 THEN 1 ELSE 0 END) AS landed_count
       FROM intent_workstreams iw
       JOIN intent_edits e ON e.intent_unit_id = iw.intent_unit_id
       WHERE iw.workstream_id = ?
       GROUP BY e.file_path
       ORDER BY edit_count DESC, e.file_path ASC`,
    )
    .all(opts.workstream_id) as WorkstreamDetailResult["files"];

  return {
    workstream: {
      ...row,
      repository: emptyToNull(row.repository),
    },
    intents,
    files,
  };
}

export function whyCode(opts: {
  path: string;
  line?: number;
  repository?: string;
}): WhyCodeResult {
  ensureLocalWorkProjections();
  const db = getDb();
  const normalizedPath = normalizeLookupPath(opts.path, opts.repository);
  const line = typeof opts.line === "number" ? opts.line : null;
  const candidates = db
    .prepare(
      `SELECT cp.repository,
              cp.file_path,
              cp.binding_level,
              cp.start_line,
              cp.end_line,
              cp.symbol_kind,
              cp.symbol_name,
              cp.intent_unit_id,
              cp.intent_edit_id,
              cp.workstream_id,
              cp.status,
              cp.confidence,
              cp.snippet_preview,
              e.tool_name,
              e.timestamp_ms,
              e.landed,
              e.landed_reason,
              u.prompt_text,
              u.session_id,
              u.prompt_ts_ms,
              w.title AS workstream_title,
              w.status AS workstream_status
       FROM code_provenance cp
       LEFT JOIN intent_edits e ON e.id = cp.intent_edit_id
       LEFT JOIN intent_units u ON u.id = cp.intent_unit_id
       LEFT JOIN workstreams w ON w.id = cp.workstream_id
       WHERE cp.file_path = ?
       ORDER BY CASE cp.status
                  WHEN 'current' THEN 0
                  WHEN 'ambiguous' THEN 1
                  ELSE 2
                END ASC,
                cp.confidence DESC,
                cp.established_at_ms DESC,
                cp.id DESC`,
    )
    .all(normalizedPath) as Array<{
    repository: string | null;
    file_path: string;
    binding_level: "span" | "file";
    start_line: number | null;
    end_line: number | null;
    symbol_kind: string | null;
    symbol_name: string | null;
    intent_unit_id: number;
    intent_edit_id: number | null;
    workstream_id: number | null;
    status: "current" | "ambiguous" | "stale";
    confidence: number;
    snippet_preview: string | null;
    tool_name: string | null;
    timestamp_ms: number | null;
    landed: number | null;
    landed_reason: string | null;
    prompt_text: string;
    session_id: string;
    prompt_ts_ms: number | null;
    workstream_title: string | null;
    workstream_status: string | null;
  }>;

  const history = intentForCode({ file_path: normalizedPath, limit: 10 });
  const preferred =
    (line !== null
      ? candidates.find(
          (candidate) =>
            candidate.binding_level === "span" &&
            candidate.start_line !== null &&
            candidate.end_line !== null &&
            line >= candidate.start_line &&
            line <= candidate.end_line &&
            candidate.status !== "stale",
        )
      : undefined) ??
    candidates.find((candidate) => candidate.status !== "stale");

  if (!preferred) {
    return {
      path: normalizedPath,
      line,
      match_level: "none",
      status: history.length > 0 ? "stale" : "none",
      confidence: 0,
      repository: opts.repository ?? history[0]?.repository ?? null,
      workstream: null,
      intent: null,
      edit: null,
      binding: null,
      evidence: { intent_for_code: history },
      related_candidates: [],
    };
  }

  const relatedCandidates = candidates
    .filter(
      (candidate) =>
        candidate.intent_edit_id !== preferred.intent_edit_id ||
        candidate.intent_unit_id !== preferred.intent_unit_id,
    )
    .slice(0, 5)
    .map((candidate) => ({
      intent_unit_id: candidate.intent_unit_id,
      workstream_id: candidate.workstream_id,
      reason:
        candidate.status === "ambiguous"
          ? "same file with ambiguous binding"
          : "same file touched recently",
      confidence: candidate.confidence,
      status: candidate.status,
    }));

  return {
    path: normalizedPath,
    line,
    match_level:
      preferred.binding_level === "span" &&
      line !== null &&
      preferred.start_line !== null &&
      preferred.end_line !== null &&
      line >= preferred.start_line &&
      line <= preferred.end_line
        ? "span"
        : preferred.binding_level,
    status: preferred.status,
    confidence: preferred.confidence,
    repository: emptyToNull(preferred.repository) ?? opts.repository ?? null,
    workstream: preferred.workstream_id
      ? {
          workstream_id: preferred.workstream_id,
          title: preferred.workstream_title ?? "untitled workstream",
          status: preferred.workstream_status ?? "unknown",
        }
      : null,
    intent: {
      intent_unit_id: preferred.intent_unit_id,
      prompt_text: preferred.prompt_text,
      session_id: preferred.session_id,
      prompt_ts_ms: preferred.prompt_ts_ms,
    },
    edit: {
      intent_edit_id: preferred.intent_edit_id,
      file_path: preferred.file_path,
      tool_name: preferred.tool_name,
      timestamp_ms: preferred.timestamp_ms,
      landed: preferred.landed,
      landed_reason: preferred.landed_reason,
      snippet_preview: preferred.snippet_preview,
    },
    binding: {
      binding_level: preferred.binding_level,
      start_line: preferred.start_line,
      end_line: preferred.end_line,
      symbol_kind: preferred.symbol_kind,
      symbol_name: preferred.symbol_name,
    },
    evidence: {
      intent_for_code: history,
    },
    related_candidates: relatedCandidates,
  };
}

export function recentWorkOnPath(opts: {
  path: string;
  repository?: string;
  limit?: number;
}): RecentWorkOnPathResult {
  ensureLocalWorkProjections();
  const db = getDb();
  const normalizedPath = normalizeLookupPath(opts.path, opts.repository);
  const limit = opts.limit ?? 20;
  const rows = db
    .prepare(
      `SELECT e.id AS intent_edit_id,
              e.timestamp_ms,
              e.landed,
              e.landed_reason,
              u.id AS intent_unit_id,
              u.prompt_text,
              w.id AS workstream_id,
              w.title AS workstream_title
       FROM intent_edits e
       JOIN intent_units u ON u.id = e.intent_unit_id
       LEFT JOIN intent_workstreams iw ON iw.intent_unit_id = u.id
       LEFT JOIN workstreams w ON w.id = iw.workstream_id
       WHERE e.file_path = ?
       ORDER BY COALESCE(e.timestamp_ms, 0) DESC, e.id DESC
       LIMIT ?`,
    )
    .all(normalizedPath, limit) as Array<{
    intent_edit_id: number;
    timestamp_ms: number | null;
    landed: number | null;
    landed_reason: string | null;
    intent_unit_id: number;
    prompt_text: string;
    workstream_id: number | null;
    workstream_title: string | null;
  }>;

  return {
    path: normalizedPath,
    repository:
      opts.repository ?? lookupRepositoryForPath(normalizedPath) ?? null,
    recent: rows.map((row) => ({
      workstream_id: row.workstream_id,
      workstream_title: row.workstream_title,
      intent_unit_id: row.intent_unit_id,
      prompt_text: row.prompt_text,
      intent_edit_id: row.intent_edit_id,
      timestamp_ms: row.timestamp_ms,
      status: classifyEditStatus(row.landed, row.landed_reason),
    })),
  };
}

function ensureLocalWorkProjections(): void {
  const db = getDb();
  const intentCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM intent_units`).get() as { c: number }
  ).c;
  if (intentCount === 0) return;
  const workstreamCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM workstreams`).get() as { c: number }
  ).c;
  const provenanceCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM code_provenance`).get() as {
      c: number;
    }
  ).c;
  if (workstreamCount === 0 || provenanceCount === 0) {
    rebuildLocalWorkProjections();
  }
}

function normalizeLookupPath(filePath: string, repository?: string): string {
  return resolveFilePathFromCwd(filePath, repository ?? null);
}

function lookupRepositoryForPath(filePath: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT repository
       FROM code_provenance
       WHERE file_path = ?
         AND repository IS NOT NULL
         AND repository != ''
       ORDER BY CASE status
                  WHEN 'current' THEN 0
                  WHEN 'ambiguous' THEN 1
                  ELSE 2
                END ASC,
                confidence DESC,
                verified_at_ms DESC,
                id DESC
       LIMIT 1`,
    )
    .get(filePath) as { repository: string | null } | undefined;
  return emptyToNull(row?.repository ?? null);
}

function parseSince(since: string): number | null {
  const trimmed = since.trim();
  if (!trimmed) return null;
  const rel = /^(\d+)([smhd])$/.exec(trimmed);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2];
    const unitMs =
      unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
    return Date.now() - amount * unitMs;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function emptyToNull(value: string | null): string | null {
  return value === "" ? null : value;
}

function classifyEditStatus(
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
