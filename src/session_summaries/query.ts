import { config } from "../config.js";
import { getDb } from "../db/schema.js";
import { intentForCode } from "../intent/query.js";
import { resolveFilePathFromCwd } from "../paths.js";
import { rebuildSessionSummaryProjections } from "./project.js";

export interface SessionSummaryProjectionRow {
  session_summary_id: number;
  session_summary_key: string;
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
  summary_text: string | null;
  summary_search_text: string | null;
  summary_source: string | null;
  summary_runner: string | null;
  summary_model: string | null;
  summary_generated_at_ms: number | null;
  summary_dirty: boolean;
}

export interface SessionSummaryRow {
  session_id: string;
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
  summary_text: string | null;
  summary_search_text: string | null;
  summary_source: string | null;
  summary_runner: string | null;
  summary_model: string | null;
  summary_generated_at_ms: number | null;
  summary_dirty: boolean;
}

type SessionSummaryIntentRow = {
  intent_unit_id: number;
  prompt_text: string;
  prompt_ts_ms: number | null;
  session_id: string;
  membership_kind: string;
  score: number;
};

type SessionSummaryFileRow = {
  file_path: string;
  edit_count: number;
  landed_count: number;
};

interface SessionSummaryProjectionDetailResult {
  session_summary: SessionSummaryProjectionRow | null;
  intents: SessionSummaryIntentRow[];
  files: SessionSummaryFileRow[];
}

export interface SessionSummaryDetailResult {
  session_summary: SessionSummaryRow | null;
  intents: SessionSummaryIntentRow[];
  files: SessionSummaryFileRow[];
}

export interface WhyCodeResult {
  path: string;
  line: number | null;
  match_level: "span" | "file" | "none";
  status: "current" | "ambiguous" | "stale" | "none";
  confidence: number;
  repository: string | null;
  session_summary: {
    session_summary_id: number;
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
    session_summary_id: number | null;
    reason: string;
    confidence: number;
    status: string;
  }>;
}

export interface RecentWorkOnPathResult {
  path: string;
  repository: string | null;
  recent: Array<{
    session_summary_id: number | null;
    session_summary_title: string | null;
    intent_unit_id: number;
    prompt_text: string;
    intent_edit_id: number;
    timestamp_ms: number | null;
    status: string;
  }>;
}

export function listSessionSummaries(opts?: {
  repository?: string;
  cwd?: string;
  status?: "active" | "landed" | "mixed" | "abandoned";
  path?: string;
  since?: string;
  limit?: number;
  offset?: number;
}): SessionSummaryRow[] {
  return listSessionSummaryProjections(opts)
    .map((row) => toSessionSummaryRow(row))
    .filter((row): row is SessionSummaryRow => row !== null);
}

export function sessionSummaryDetail(opts: {
  session_id: string;
}): SessionSummaryDetailResult | null {
  if (!config.enableSessionSummaryProjections) return null;
  ensureSessionSummaryProjections();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id
       FROM session_summaries
       WHERE session_summary_key = ?`,
    )
    .get(sessionSummaryKeyForSession(opts.session_id)) as
    | { id: number }
    | undefined;
  if (!row) return null;

  const detail = getSessionSummaryProjectionDetail({
    session_summary_id: row.id,
  });
  if (!detail?.session_summary) return null;
  return {
    session_summary: toSessionSummaryRow(detail.session_summary),
    intents: detail.intents,
    files: detail.files,
  };
}

export function whyCode(opts: {
  path: string;
  line?: number;
  repository?: string;
}): WhyCodeResult {
  const normalizedPath = normalizeLookupPath(opts.path, opts.repository);
  const line = typeof opts.line === "number" ? opts.line : null;
  const history = intentForCode({ file_path: normalizedPath, limit: 10 });

  if (!config.enableSessionSummaryProjections) {
    return {
      path: normalizedPath,
      line,
      match_level: "none",
      status: history.length > 0 ? "stale" : "none",
      confidence: 0,
      repository: opts.repository ?? history[0]?.repository ?? null,
      session_summary: null,
      intent: null,
      edit: null,
      binding: null,
      evidence: { intent_for_code: history },
      related_candidates: [],
    };
  }

  ensureSessionSummaryProjections();
  const db = getDb();
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
              cp.session_summary_id,
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
              s.title AS session_summary_title,
              s.status AS session_summary_status
       FROM code_provenance cp
       LEFT JOIN intent_edits e ON e.id = cp.intent_edit_id
       LEFT JOIN intent_units u ON u.id = cp.intent_unit_id
       LEFT JOIN session_summaries s ON s.id = cp.session_summary_id
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
    session_summary_id: number | null;
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
    session_summary_title: string | null;
    session_summary_status: string | null;
  }>;

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
      session_summary: null,
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
      session_summary_id: candidate.session_summary_id,
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
    session_summary: preferred.session_summary_id
      ? {
          session_summary_id: preferred.session_summary_id,
          title: preferred.session_summary_title ?? "untitled session summary",
          status: preferred.session_summary_status ?? "unknown",
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
  const db = getDb();
  const normalizedPath = normalizeLookupPath(opts.path, opts.repository);
  const limit = opts.limit ?? 20;
  let rows: Array<{
    intent_edit_id: number;
    timestamp_ms: number | null;
    landed: number | null;
    landed_reason: string | null;
    intent_unit_id: number;
    prompt_text: string;
    session_summary_id: number | null;
    session_summary_title: string | null;
  }>;

  if (config.enableSessionSummaryProjections) {
    ensureSessionSummaryProjections();
    rows = db
      .prepare(
        `SELECT e.id AS intent_edit_id,
                e.timestamp_ms,
                e.landed,
                e.landed_reason,
                u.id AS intent_unit_id,
                u.prompt_text,
                s.id AS session_summary_id,
                s.title AS session_summary_title
         FROM intent_edits e
         JOIN intent_units u ON u.id = e.intent_unit_id
         LEFT JOIN intent_session_summaries iss
           ON iss.intent_unit_id = u.id
         LEFT JOIN session_summaries s ON s.id = iss.session_summary_id
         WHERE e.file_path = ?
         ORDER BY COALESCE(e.timestamp_ms, 0) DESC, e.id DESC
         LIMIT ?`,
      )
      .all(normalizedPath, limit) as typeof rows;
  } else {
    rows = db
      .prepare(
        `SELECT e.id AS intent_edit_id,
                e.timestamp_ms,
                e.landed,
                e.landed_reason,
                u.id AS intent_unit_id,
                u.prompt_text,
                NULL AS session_summary_id,
                NULL AS session_summary_title
         FROM intent_edits e
         JOIN intent_units u ON u.id = e.intent_unit_id
         WHERE e.file_path = ?
         ORDER BY COALESCE(e.timestamp_ms, 0) DESC, e.id DESC
         LIMIT ?`,
      )
      .all(normalizedPath, limit) as typeof rows;
  }

  return {
    path: normalizedPath,
    repository:
      opts.repository ?? lookupRepositoryForPath(normalizedPath) ?? null,
    recent: rows.map((row) => ({
      session_summary_id: row.session_summary_id,
      session_summary_title: row.session_summary_title,
      intent_unit_id: row.intent_unit_id,
      prompt_text: row.prompt_text,
      intent_edit_id: row.intent_edit_id,
      timestamp_ms: row.timestamp_ms,
      status: classifyEditStatus(row.landed, row.landed_reason),
    })),
  };
}

export function ensureSessionSummaryProjections(): void {
  if (!config.enableSessionSummaryProjections) return;
  const db = getDb();
  const intentCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM intent_units`).get() as { c: number }
  ).c;
  if (intentCount === 0) return;

  const sessionSummaryCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM session_summaries`).get() as {
      c: number;
    }
  ).c;
  const enrichmentCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM session_summary_enrichments`)
      .get() as {
      c: number;
    }
  ).c;
  const membershipCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM intent_session_summaries`).get() as {
      c: number;
    }
  ).c;
  if (
    sessionSummaryCount === 0 ||
    membershipCount === 0 ||
    enrichmentCount < sessionSummaryCount
  ) {
    rebuildSessionSummaryProjections();
  }
}

function listSessionSummaryProjections(opts?: {
  repository?: string;
  cwd?: string;
  status?: "active" | "landed" | "mixed" | "abandoned";
  path?: string;
  since?: string;
  limit?: number;
  offset?: number;
}): SessionSummaryProjectionRow[] {
  if (!config.enableSessionSummaryProjections) return [];
  ensureSessionSummaryProjections();
  const db = getDb();
  const params: unknown[] = [];
  let sql = `
    SELECT DISTINCT s.id AS session_summary_id,
           s.session_summary_key,
           s.title,
           s.status,
           s.repository,
           s.cwd,
           s.branch,
           s.worktree,
           s.actor,
           s.machine,
           s.origin_scope,
           s.first_intent_ts_ms,
           s.last_intent_ts_ms,
           s.intent_count,
           s.edit_count,
           s.landed_edit_count,
           s.open_edit_count,
           e.summary_text,
           e.summary_search_text,
           e.summary_source,
           e.summary_runner,
           e.summary_model,
           e.summary_generated_at_ms,
           COALESCE(e.dirty, 1) AS summary_dirty
    FROM session_summaries s
    LEFT JOIN session_summary_enrichments e
      ON e.session_summary_key = s.session_summary_key`;

  if (opts?.path) {
    sql += `
      INNER JOIN code_provenance cp
        ON cp.session_summary_id = s.id AND cp.file_path = ?`;
    params.push(normalizeLookupPath(opts.path, opts.repository));
  }

  const where: string[] = [];
  if (opts?.repository) {
    where.push("s.repository = ?");
    params.push(opts.repository);
  }
  if (opts?.cwd) {
    where.push("s.cwd = ?");
    params.push(opts.cwd);
  }
  if (opts?.status) {
    where.push("s.status = ?");
    params.push(opts.status);
  }
  if (opts?.since) {
    const sinceMs = parseSince(opts.since);
    if (sinceMs !== null) {
      where.push("COALESCE(s.last_intent_ts_ms, 0) >= ?");
      params.push(sinceMs);
    }
  }
  if (where.length > 0) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }

  sql += ` ORDER BY COALESCE(s.last_intent_ts_ms, 0) DESC, s.id DESC`;
  sql += ` LIMIT ? OFFSET ?`;
  params.push(opts?.limit ?? 20, opts?.offset ?? 0);

  return (
    db.prepare(sql).all(...params) as Array<{
      session_summary_id: number;
      session_summary_key: string;
      title: string;
      status: SessionSummaryProjectionRow["status"];
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
      summary_text: string | null;
      summary_search_text: string | null;
      summary_source: string | null;
      summary_runner: string | null;
      summary_model: string | null;
      summary_generated_at_ms: number | null;
      summary_dirty: number;
    }>
  ).map((row) => ({
    ...row,
    repository: emptyToNull(row.repository),
    summary_dirty: row.summary_dirty === 1,
  }));
}

function getSessionSummaryProjectionDetail(opts: {
  session_summary_id: number;
}): SessionSummaryProjectionDetailResult | null {
  if (!config.enableSessionSummaryProjections) return null;
  ensureSessionSummaryProjections();
  const db = getDb();
  const sessionSummary = db
    .prepare(
      `SELECT s.id AS session_summary_id,
              s.session_summary_key,
              s.title,
              s.status,
              s.repository,
              s.cwd,
              s.branch,
              s.worktree,
              s.actor,
              s.machine,
              s.origin_scope,
              s.first_intent_ts_ms,
              s.last_intent_ts_ms,
              s.intent_count,
              s.edit_count,
              s.landed_edit_count,
              s.open_edit_count,
              e.summary_text,
              e.summary_search_text,
              e.summary_source,
              e.summary_runner,
              e.summary_model,
              e.summary_generated_at_ms,
              COALESCE(e.dirty, 1) AS summary_dirty
       FROM session_summaries s
       LEFT JOIN session_summary_enrichments e
         ON e.session_summary_key = s.session_summary_key
       WHERE id = ?`,
    )
    .get(opts.session_summary_id) as
    | (Omit<SessionSummaryProjectionRow, "repository" | "summary_dirty"> & {
        repository: string | null;
        summary_dirty: number;
      })
    | undefined;
  if (!sessionSummary) return null;

  const intents = db
    .prepare(
      `SELECT u.id AS intent_unit_id,
              u.prompt_text,
              u.prompt_ts_ms,
              u.session_id,
              iss.membership_kind,
              iss.score
       FROM intent_session_summaries iss
       JOIN intent_units u ON u.id = iss.intent_unit_id
       WHERE iss.session_summary_id = ?
       ORDER BY COALESCE(u.prompt_ts_ms, 0) ASC, u.id ASC`,
    )
    .all(opts.session_summary_id) as SessionSummaryIntentRow[];

  const files = db
    .prepare(
      `SELECT e.file_path,
              COUNT(*) AS edit_count,
              SUM(CASE WHEN e.landed = 1 THEN 1 ELSE 0 END) AS landed_count
       FROM intent_session_summaries iss
       JOIN intent_edits e ON e.intent_unit_id = iss.intent_unit_id
       WHERE iss.session_summary_id = ?
       GROUP BY e.file_path
       ORDER BY edit_count DESC, e.file_path ASC`,
    )
    .all(opts.session_summary_id) as SessionSummaryFileRow[];

  return {
    session_summary: {
      ...sessionSummary,
      repository: emptyToNull(sessionSummary.repository),
      summary_dirty: sessionSummary.summary_dirty === 1,
    },
    intents,
    files,
  };
}

function normalizeLookupPath(filePath: string, repository?: string): string {
  return resolveFilePathFromCwd(filePath, repository ?? null);
}

function toSessionSummaryRow(
  row: SessionSummaryProjectionRow,
): SessionSummaryRow | null {
  const sessionId = parseSessionIdFromSummaryKey(row.session_summary_key);
  if (!sessionId) return null;
  return {
    session_id: sessionId,
    title: row.title,
    status: row.status,
    repository: row.repository,
    cwd: row.cwd,
    branch: row.branch,
    worktree: row.worktree,
    actor: row.actor,
    machine: row.machine,
    origin_scope: row.origin_scope,
    first_intent_ts_ms: row.first_intent_ts_ms,
    last_intent_ts_ms: row.last_intent_ts_ms,
    intent_count: row.intent_count,
    edit_count: row.edit_count,
    landed_edit_count: row.landed_edit_count,
    open_edit_count: row.open_edit_count,
    summary_text: row.summary_text,
    summary_search_text: row.summary_search_text,
    summary_source: row.summary_source,
    summary_runner: row.summary_runner,
    summary_model: row.summary_model,
    summary_generated_at_ms: row.summary_generated_at_ms,
    summary_dirty: row.summary_dirty,
  };
}

export function sessionSummaryKeyForSession(sessionId: string): string {
  return `ss:local:${sessionId}`;
}

function parseSessionIdFromSummaryKey(key: string): string | null {
  const prefix = "ss:local:";
  if (!key.startsWith(prefix)) return null;
  const sessionId = key.slice(prefix.length);
  return sessionId.length > 0 ? sessionId : null;
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
