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
    edit_count: number;
    current_edit_count: number;
    superseded_edit_count: number;
    reverted_edit_count: number;
    unknown_edit_count: number;
    timestamp_ms: number | null;
    status: "current" | "superseded" | "reverted" | "mixed" | "unknown";
  }>;
}

export interface FileOverviewResult {
  path: string;
  repository: string | null;
  summary: {
    intent_count: number;
    edit_count: number;
    session_summary_count: number;
    current_edit_count: number;
    superseded_edit_count: number;
    reverted_edit_count: number;
    unknown_edit_count: number;
    first_edit_ts_ms: number | null;
    last_edit_ts_ms: number | null;
  };
  current: {
    status: WhyCodeResult["status"];
    confidence: number;
    binding_level: "span" | "file" | "none";
    session_summary_id: number | null;
    session_summary_title: string | null;
    intent_unit_id: number | null;
    intent_edit_id: number | null;
    prompt_text: string | null;
    snippet_preview: string | null;
  };
  recent: RecentWorkOnPathResult["recent"];
  related_files: Array<{
    file_path: string;
    shared_intent_count: number;
    shared_session_summary_count: number;
    last_touched_ts_ms: number | null;
    last_status: "current" | "superseded" | "reverted" | "unknown";
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
  if (config.enableSessionSummaryProjections) {
    ensureSessionSummaryProjections();
  }
  const rows = db
    .prepare(
      `SELECT e.id AS intent_edit_id,
              e.timestamp_ms,
              e.landed,
              e.landed_reason,
              u.id AS intent_unit_id,
              u.prompt_text,
              u.repository,
              ${
                config.enableSessionSummaryProjections
                  ? `(SELECT iss.session_summary_id
                      FROM intent_session_summaries iss
                      WHERE iss.intent_unit_id = u.id
                      ORDER BY CASE iss.membership_kind
                                 WHEN 'primary' THEN 0
                                 ELSE 1
                               END ASC,
                               iss.score DESC,
                               iss.session_summary_id DESC
                      LIMIT 1) AS session_summary_id,
                     (SELECT s.title
                      FROM intent_session_summaries iss
                      JOIN session_summaries s ON s.id = iss.session_summary_id
                      WHERE iss.intent_unit_id = u.id
                      ORDER BY CASE iss.membership_kind
                                 WHEN 'primary' THEN 0
                                 ELSE 1
                               END ASC,
                               iss.score DESC,
                               iss.session_summary_id DESC
                      LIMIT 1) AS session_summary_title`
                  : `NULL AS session_summary_id,
                     NULL AS session_summary_title`
              }
       FROM intent_edits e
       JOIN intent_units u ON u.id = e.intent_unit_id
       WHERE e.file_path = ?
       ORDER BY COALESCE(e.timestamp_ms, 0) DESC, e.id DESC`,
    )
    .all(normalizedPath) as Array<{
    intent_edit_id: number;
    timestamp_ms: number | null;
    landed: number | null;
    landed_reason: string | null;
    intent_unit_id: number;
    prompt_text: string;
    repository: string | null;
    session_summary_id: number | null;
    session_summary_title: string | null;
  }>;

  const grouped = new Map<
    number,
    {
      session_summary_id: number | null;
      session_summary_title: string | null;
      intent_unit_id: number;
      prompt_text: string;
      repository: string | null;
      intent_edit_id: number;
      edit_count: number;
      current_edit_count: number;
      superseded_edit_count: number;
      reverted_edit_count: number;
      unknown_edit_count: number;
      timestamp_ms: number | null;
    }
  >();

  for (const row of rows) {
    const existing = grouped.get(row.intent_unit_id);
    const status = classifyEditStatus(row.landed, row.landed_reason);
    if (!existing) {
      grouped.set(row.intent_unit_id, {
        session_summary_id: row.session_summary_id,
        session_summary_title: row.session_summary_title,
        intent_unit_id: row.intent_unit_id,
        prompt_text: row.prompt_text,
        repository: row.repository,
        intent_edit_id: row.intent_edit_id,
        edit_count: 1,
        current_edit_count: status === "current" ? 1 : 0,
        superseded_edit_count: status === "superseded" ? 1 : 0,
        reverted_edit_count: status === "reverted" ? 1 : 0,
        unknown_edit_count: status === "unknown" ? 1 : 0,
        timestamp_ms: row.timestamp_ms,
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
        row.intent_edit_id > existing.intent_edit_id)
    ) {
      existing.intent_edit_id = row.intent_edit_id;
      existing.timestamp_ms = row.timestamp_ms;
      existing.session_summary_id = row.session_summary_id;
      existing.session_summary_title = row.session_summary_title;
      existing.repository = row.repository;
    }
  }

  const recent = [...grouped.values()]
    .sort(
      (a, b) =>
        (b.timestamp_ms ?? 0) - (a.timestamp_ms ?? 0) ||
        b.intent_edit_id - a.intent_edit_id,
    )
    .slice(0, limit);

  return {
    path: normalizedPath,
    repository:
      opts.repository ??
      recent[0]?.repository ??
      lookupRepositoryForPath(normalizedPath) ??
      null,
    recent: recent.map((row) => ({
      session_summary_id: row.session_summary_id,
      session_summary_title: row.session_summary_title,
      intent_unit_id: row.intent_unit_id,
      prompt_text: row.prompt_text,
      intent_edit_id: row.intent_edit_id,
      edit_count: row.edit_count,
      current_edit_count: row.current_edit_count,
      superseded_edit_count: row.superseded_edit_count,
      reverted_edit_count: row.reverted_edit_count,
      unknown_edit_count: row.unknown_edit_count,
      timestamp_ms: row.timestamp_ms,
      status: classifyAggregateEditStatus(row),
    })),
  };
}

export function fileOverview(opts: {
  path: string;
  repository?: string;
  recent_limit?: number;
  related_limit?: number;
}): FileOverviewResult {
  const normalizedPath = normalizeLookupPath(opts.path, opts.repository);
  const summary = loadFileOverviewSummary(normalizedPath);
  const current = whyCode({
    path: normalizedPath,
    repository: opts.repository,
  });
  const recent = recentWorkOnPath({
    path: normalizedPath,
    repository: opts.repository,
    limit: opts.recent_limit ?? 5,
  });
  const relatedFiles = loadRelatedFilesForPath(
    normalizedPath,
    opts.related_limit ?? 10,
  );

  return {
    path: normalizedPath,
    repository:
      opts.repository ??
      current.repository ??
      lookupRepositoryForPath(normalizedPath),
    summary,
    current: {
      status: current.status,
      confidence: current.confidence,
      binding_level: current.binding?.binding_level ?? "none",
      session_summary_id: current.session_summary?.session_summary_id ?? null,
      session_summary_title: current.session_summary?.title ?? null,
      intent_unit_id: current.intent?.intent_unit_id ?? null,
      intent_edit_id: current.edit?.intent_edit_id ?? null,
      prompt_text: current.intent?.prompt_text ?? null,
      snippet_preview: current.edit?.snippet_preview ?? null,
    },
    recent: recent.recent,
    related_files: relatedFiles,
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
  const membershipCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM intent_session_summaries`).get() as {
      c: number;
    }
  ).c;
  if (sessionSummaryCount === 0 || membershipCount === 0) {
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
           s.open_edit_count
    FROM session_summaries s`;

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
    }>
  ).map((row) => ({
    ...row,
    repository: emptyToNull(row.repository),
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
      `SELECT id AS session_summary_id,
              session_summary_key,
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
       FROM session_summaries
       WHERE id = ?`,
    )
    .get(opts.session_summary_id) as
    | (Omit<SessionSummaryProjectionRow, "repository"> & {
        repository: string | null;
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

function loadFileOverviewSummary(
  filePath: string,
): FileOverviewResult["summary"] {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS edit_count,
              COUNT(DISTINCT e.intent_unit_id) AS intent_count,
              COUNT(DISTINCT iss.session_summary_id) AS session_summary_count,
              SUM(CASE WHEN e.landed = 1 THEN 1 ELSE 0 END) AS current_edit_count,
              SUM(
                CASE
                  WHEN e.landed = 0
                   AND e.landed_reason IN ('overwritten_in_session', 'write_replaced')
                  THEN 1
                  ELSE 0
                END
              ) AS superseded_edit_count,
              SUM(
                CASE
                  WHEN e.landed = 0
                   AND e.landed_reason IN ('reverted_post_session', 'file_deleted')
                  THEN 1
                  ELSE 0
                END
              ) AS reverted_edit_count,
              SUM(
                CASE
                  WHEN e.landed IS NULL
                    OR (
                      e.landed = 0
                      AND (
                        e.landed_reason IS NULL
                        OR e.landed_reason NOT IN (
                          'overwritten_in_session',
                          'write_replaced',
                          'reverted_post_session',
                          'file_deleted'
                        )
                      )
                    )
                  THEN 1
                  ELSE 0
                END
              ) AS unknown_edit_count,
              MIN(COALESCE(e.timestamp_ms, u.prompt_ts_ms)) AS first_edit_ts_ms,
              MAX(COALESCE(e.timestamp_ms, u.prompt_ts_ms)) AS last_edit_ts_ms
       FROM intent_edits e
       JOIN intent_units u ON u.id = e.intent_unit_id
       LEFT JOIN intent_session_summaries iss
         ON iss.intent_unit_id = e.intent_unit_id
       WHERE e.file_path = ?`,
    )
    .get(filePath) as
    | {
        edit_count: number;
        intent_count: number;
        session_summary_count: number;
        current_edit_count: number | null;
        superseded_edit_count: number | null;
        reverted_edit_count: number | null;
        unknown_edit_count: number | null;
        first_edit_ts_ms: number | null;
        last_edit_ts_ms: number | null;
      }
    | undefined;

  return {
    intent_count: row?.intent_count ?? 0,
    edit_count: row?.edit_count ?? 0,
    session_summary_count: row?.session_summary_count ?? 0,
    current_edit_count: row?.current_edit_count ?? 0,
    superseded_edit_count: row?.superseded_edit_count ?? 0,
    reverted_edit_count: row?.reverted_edit_count ?? 0,
    unknown_edit_count: row?.unknown_edit_count ?? 0,
    first_edit_ts_ms: row?.first_edit_ts_ms ?? null,
    last_edit_ts_ms: row?.last_edit_ts_ms ?? null,
  };
}

function loadRelatedFilesForPath(
  filePath: string,
  limit: number,
): FileOverviewResult["related_files"] {
  const db = getDb();
  const rows = db
    .prepare(
      `WITH seed_intents AS (
         SELECT DISTINCT intent_unit_id
         FROM intent_edits
         WHERE file_path = ?
       ),
       seed_summaries AS (
         SELECT DISTINCT iss.session_summary_id
         FROM seed_intents si
         JOIN intent_session_summaries iss
           ON iss.intent_unit_id = si.intent_unit_id
         WHERE iss.session_summary_id IS NOT NULL
       ),
       related_by_intent AS (
         SELECT e.file_path,
                e.intent_unit_id,
                COALESCE(e.timestamp_ms, u.prompt_ts_ms) AS touched_ts_ms
         FROM seed_intents si
         JOIN intent_edits e ON e.intent_unit_id = si.intent_unit_id
         JOIN intent_units u ON u.id = e.intent_unit_id
         WHERE e.file_path != ?
       ),
       related_by_summary AS (
         SELECT e.file_path,
                iss.session_summary_id,
                COALESCE(e.timestamp_ms, u.prompt_ts_ms) AS touched_ts_ms
         FROM seed_summaries ss
         JOIN intent_session_summaries iss
           ON iss.session_summary_id = ss.session_summary_id
         JOIN intent_edits e ON e.intent_unit_id = iss.intent_unit_id
         JOIN intent_units u ON u.id = e.intent_unit_id
         WHERE e.file_path != ?
       ),
       intent_counts AS (
         SELECT file_path,
                COUNT(DISTINCT intent_unit_id) AS shared_intent_count,
                MAX(touched_ts_ms) AS last_intent_ts_ms
         FROM related_by_intent
         GROUP BY file_path
       ),
       summary_counts AS (
         SELECT file_path,
                COUNT(DISTINCT session_summary_id) AS shared_session_summary_count,
                MAX(touched_ts_ms) AS last_summary_ts_ms
         FROM related_by_summary
         GROUP BY file_path
       ),
       candidate_files AS (
         SELECT file_path FROM intent_counts
         UNION
         SELECT file_path FROM summary_counts
       ),
       latest_status AS (
         SELECT e.file_path,
                e.landed,
                e.landed_reason,
                COALESCE(e.timestamp_ms, u.prompt_ts_ms) AS touched_ts_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY e.file_path
                  ORDER BY COALESCE(e.timestamp_ms, u.prompt_ts_ms) DESC, e.id DESC
                ) AS rn
         FROM intent_edits e
         JOIN intent_units u ON u.id = e.intent_unit_id
         WHERE e.file_path IN (SELECT file_path FROM candidate_files)
       )
       SELECT cf.file_path,
              COALESCE(ic.shared_intent_count, 0) AS shared_intent_count,
              COALESCE(sc.shared_session_summary_count, 0)
                AS shared_session_summary_count,
              CASE
                WHEN ic.last_intent_ts_ms IS NULL
                 AND sc.last_summary_ts_ms IS NULL
                 AND ls.touched_ts_ms IS NULL
                THEN NULL
                ELSE MAX(
                  COALESCE(ic.last_intent_ts_ms, 0),
                  COALESCE(sc.last_summary_ts_ms, 0),
                  COALESCE(ls.touched_ts_ms, 0)
                )
              END AS last_touched_ts_ms,
              ls.landed,
              ls.landed_reason
       FROM candidate_files cf
       LEFT JOIN intent_counts ic ON ic.file_path = cf.file_path
       LEFT JOIN summary_counts sc ON sc.file_path = cf.file_path
       LEFT JOIN latest_status ls
         ON ls.file_path = cf.file_path
        AND ls.rn = 1
       ORDER BY shared_intent_count DESC,
                shared_session_summary_count DESC,
                last_touched_ts_ms DESC,
                cf.file_path ASC
       LIMIT ?`,
    )
    .all(filePath, filePath, filePath, limit) as Array<{
    file_path: string;
    shared_intent_count: number;
    shared_session_summary_count: number;
    last_touched_ts_ms: number | null;
    landed: number | null;
    landed_reason: string | null;
  }>;

  return rows.map((row) => ({
    file_path: row.file_path,
    shared_intent_count: row.shared_intent_count,
    shared_session_summary_count: row.shared_session_summary_count,
    last_touched_ts_ms: row.last_touched_ts_ms,
    last_status: classifyEditStatus(row.landed, row.landed_reason),
  }));
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

function classifyAggregateEditStatus(
  row: Pick<
    RecentWorkOnPathResult["recent"][number],
    | "current_edit_count"
    | "superseded_edit_count"
    | "reverted_edit_count"
    | "unknown_edit_count"
  >,
): RecentWorkOnPathResult["recent"][number]["status"] {
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
