import { getDb, needsSessionSummaryProjectionRebuild } from "../db/schema.js";
import { intentForCode } from "../intent/query.js";
import {
  canonicalizeRepoFilePath,
  isObservedAbsolutePath,
  resolveCanonicalFilePath,
  resolveRepositoryRootForPath,
} from "../paths.js";
import { sessionSummaryLastActivitySql } from "./activity.js";
import {
  type SessionSummaryStaleReason,
  selectSessionSummaryDisplay,
} from "./display.js";
import { invalidSessionSummaryEnrichmentReason } from "./enrichment-quality.js";
import { getSessionSummaryRunnerPolicy } from "./policy.js";
import {
  buildSessionSummaryPreview,
  rankSessionSummaryPreviewFiles,
  type SessionSummaryPreview,
  type SessionSummaryPreviewFile,
} from "./preview.js";
import { rebuildSessionSummaryProjections } from "./project.js";
import { SESSION_SUMMARY_SEARCH_CORPUS } from "./search-index.js";

export interface SessionSummaryProjectionRow {
  session_summary_id: number;
  session_summary_key: string;
  session_id: string;
  target: string | null;
  title: string;
  status: "active" | "landed" | "mixed" | "read-only" | "unlanded";
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
  projection_hash: string;
  projected_at_ms: number;
  source_last_seen_at_ms: number | null;
  summary_source: "deterministic" | null;
  enriched_summary_text: string | null;
  enriched_search_text: string | null;
  enrichment_source: "llm" | null;
  enrichment_runner: string | null;
  enrichment_model: string | null;
  enrichment_summary_version: number | null;
  enrichment_current_summary_version: number;
  enrichment_stale: boolean;
  enrichment_stale_reasons: SessionSummaryStaleReason[];
  enrichment_invalid_reason: string | null;
  enrichment_generated_at_ms: number | null;
  enrichment_dirty: boolean;
}

export interface SessionSummaryRow {
  session_id: string;
  target: string | null;
  title: string;
  status: "active" | "landed" | "mixed" | "read-only" | "unlanded";
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
  projection_hash: string;
  projected_at_ms: number;
  source_last_seen_at_ms: number | null;
  summary_source: "deterministic" | null;
  enriched_summary_text: string | null;
  enriched_search_text: string | null;
  enrichment_source: "llm" | null;
  enrichment_runner: string | null;
  enrichment_model: string | null;
  enrichment_summary_version: number | null;
  enrichment_current_summary_version: number;
  enrichment_stale: boolean;
  enrichment_stale_reasons: SessionSummaryStaleReason[];
  enrichment_invalid_reason: string | null;
  enrichment_generated_at_ms: number | null;
  enrichment_dirty: boolean;
  preview: SessionSummaryPreview;
}

type RawSessionSummaryProjectionRow = Omit<
  SessionSummaryProjectionRow,
  | "repository"
  | "summary_source"
  | "enrichment_source"
  | "enrichment_dirty"
  | "enrichment_current_summary_version"
  | "enrichment_stale"
  | "enrichment_stale_reasons"
  | "enrichment_invalid_reason"
> & {
  repository: string | null;
  summary_source: string | null;
  enrichment_source: string | null;
  enrichment_dirty: number;
  enrichment_policy_hash: string | null;
};

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
  current_edit_count: number;
  superseded_edit_count: number;
  reverted_edit_count: number;
  unknown_edit_count: number;
  intent_count: number;
  last_touched_ms: number | null;
};

interface SessionSummaryProjectionDetailResult {
  session_summary: SessionSummaryProjectionRow | null;
  intents: SessionSummaryIntentRow[];
  files: SessionSummaryFileRow[];
}

export interface SessionSummaryDetailResult {
  session_summary: SessionSummaryRow | null;
  preview: SessionSummaryPreview | null;
  intents: SessionSummaryIntentRow[];
  files: SessionSummaryFileRow[];
}

const SESSION_SUMMARY_PROJECTION_SELECT = `
  s.id AS session_summary_id,
  s.session_summary_key,
  s.session_id,
  sess.target AS target,
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
  s.summary_text AS summary_text,
  s.projection_hash,
  s.projected_at_ms,
  s.source_last_seen_at_ms,
  'deterministic' AS summary_source,
  COALESCE(
    esummary.search_text,
    CASE
      WHEN e.summary_source = 'llm' THEN e.summary_text
      ELSE NULL
    END
  ) AS enriched_summary_text,
  COALESCE(
    esearch.search_text,
    CASE
      WHEN e.summary_source = 'llm' THEN e.summary_text
      ELSE NULL
    END
  ) AS enriched_search_text,
  CASE
    WHEN e.summary_source = 'llm' AND e.summary_text IS NOT NULL THEN 'llm'
    ELSE NULL
  END AS enrichment_source,
  e.summary_runner AS enrichment_runner,
  e.summary_model AS enrichment_model,
  e.summary_version AS enrichment_summary_version,
  e.summary_policy_hash AS enrichment_policy_hash,
  e.summary_generated_at_ms AS enrichment_generated_at_ms,
  COALESCE(e.dirty, 0) AS enrichment_dirty`;

const SESSION_SUMMARY_PROJECTION_JOINS = `
  LEFT JOIN sessions sess ON sess.session_id = s.session_id
  LEFT JOIN session_summary_enrichments e
    ON e.session_summary_key = s.session_summary_key
  LEFT JOIN session_summary_search_index esummary
    ON esummary.session_summary_key = s.session_summary_key
   AND esummary.corpus_key = '${SESSION_SUMMARY_SEARCH_CORPUS.llmSummary}'
  LEFT JOIN session_summary_search_index esearch
    ON esearch.session_summary_key = s.session_summary_key
   AND esearch.corpus_key = '${SESSION_SUMMARY_SEARCH_CORPUS.llmSearch}'`;

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
  status?: "active" | "landed" | "mixed" | "read-only" | "unlanded";
  path?: string;
  since?: string;
  limit?: number;
  offset?: number;
}): SessionSummaryRow[] {
  const rows = listSessionSummaryProjections(opts);
  const previewFilesBySummaryId = loadSessionSummaryPreviewFiles(rows, 3);
  return rows
    .map((row) =>
      toSessionSummaryRow(
        row,
        previewFilesBySummaryId.get(row.session_summary_id) ?? [],
      ),
    )
    .filter((row): row is SessionSummaryRow => row !== null);
}

export function sessionSummaryDetail(opts: {
  session_id: string;
}): SessionSummaryDetailResult | null {
  ensureSessionSummaryProjections();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id
       FROM session_summaries
       WHERE session_id = ?`,
    )
    .get(opts.session_id) as { id: number } | undefined;
  if (!row) return null;

  const detail = getSessionSummaryProjectionDetail({
    session_summary_id: row.id,
  });
  if (!detail?.session_summary) return null;
  const previewFiles =
    loadSessionSummaryPreviewFiles([detail.session_summary], 3).get(
      detail.session_summary.session_summary_id,
    ) ?? [];
  const sessionSummary = toSessionSummaryRow(
    detail.session_summary,
    previewFiles,
  );
  return {
    session_summary: sessionSummary,
    preview: sessionSummary?.preview ?? null,
    intents: detail.intents,
    files: detail.files,
  };
}

export function listRecentSessionSummaryPreviewsForCwd(opts: {
  cwdCandidates: string[];
  currentSessionId?: string | null;
  sinceMs?: number | null;
  untilMs?: number | null;
  limit?: number;
}): SessionSummaryPreview[] {
  if (opts.cwdCandidates.length === 0) return [];

  const db = getDb();
  const cwdPlaceholders = opts.cwdCandidates.map(() => "?").join(", ");
  const activityExpr = sessionSummaryLastActivitySql();
  const useSinceMs =
    typeof opts.sinceMs === "number" && Number.isFinite(opts.sinceMs);
  const useUntilMs =
    typeof opts.untilMs === "number" && Number.isFinite(opts.untilMs);
  const params: unknown[] = [
    ...opts.cwdCandidates,
    ...opts.cwdCandidates,
    opts.currentSessionId ?? "",
  ];
  if (useSinceMs) params.push(opts.sinceMs);
  if (useUntilMs) params.push(opts.untilMs);
  params.push(opts.limit ?? 5);
  const rows = (
    db
      .prepare(
        `WITH matched_sessions AS (
           SELECT session_id
           FROM session_summaries
           WHERE cwd IN (${cwdPlaceholders})
           UNION
           SELECT session_id
           FROM session_cwds
           WHERE cwd IN (${cwdPlaceholders})
         )
         SELECT ${SESSION_SUMMARY_PROJECTION_SELECT}
         FROM matched_sessions m
         JOIN session_summaries s
           ON s.session_id = m.session_id
         ${SESSION_SUMMARY_PROJECTION_JOINS}
         WHERE s.session_id != ?
         AND COALESCE(sess.is_automated, 0) != 1
         ${useSinceMs ? `AND ${activityExpr} >= ?` : ""}
         ${useUntilMs ? `AND ${activityExpr} <= ?` : ""}
         ORDER BY ${activityExpr} DESC,
                  s.id DESC
         LIMIT ?`,
      )
      .all(...params) as RawSessionSummaryProjectionRow[]
  ).map((row) => toSessionSummaryProjectionRow(row));

  const previewFilesBySummaryId = loadSessionSummaryPreviewFiles(rows, 3);
  return rows.map((row) =>
    buildSessionSummaryPreview(
      row,
      previewFilesBySummaryId.get(row.session_summary_id) ?? [],
    ),
  );
}

const PROMPT_RELEVANCE_TERM_LIMIT = 10;
// Lowest weight a structurally-strong term can have (a bare numeric id, e.g.
// a PR number). The gate requires >=1 strong term to match, so this is the
// effective single-term floor — keep MIN_SCORE at or below it.
const PROMPT_RELEVANCE_MIN_SCORE = 16;
// Strict default for the generic (non-identifier) path. Callers loosen it
// to 3 only for specific mid-session prompts; first prompts keep this.
const PROMPT_RELEVANCE_DEFAULT_MIN_COUNT = 4;
const PROMPT_RELEVANCE_STOPWORDS = new Set([
  "about",
  "actually",
  "after",
  "again",
  "also",
  "and",
  "anything",
  "are",
  "before",
  "but",
  "can",
  "confirm",
  "could",
  "did",
  "does",
  "for",
  "from",
  "have",
  "how",
  "just",
  "into",
  "let",
  "lets",
  "like",
  "make",
  "more",
  "much",
  "not",
  "now",
  "old",
  "our",
  "see",
  "should",
  "that",
  "the",
  "then",
  "there",
  "this",
  "too",
  "use",
  "using",
  "want",
  "was",
  "what",
  "when",
  "where",
  "with",
  "would",
  "yes",
  "you",
]);
interface PromptSearchTerm {
  term: string;
  weight: number;
  strong: boolean;
}

export function listRelevantSessionSummaryPreviewsForPrompt(opts: {
  prompt: string;
  cwdCandidates?: string[];
  repository?: string | null;
  currentSessionId?: string | null;
  excludeSessionIds?: string[];
  sinceMs?: number | null;
  untilMs?: number | null;
  limit?: number;
  minScore?: number;
  // Min distinct generic terms for the non-identifier path. Scope-aware:
  // vague first-in-session prompts use a stricter value (they only match
  // ambient repo vocabulary), specific mid-session prompts a looser one.
  minMatchCount?: number;
}): SessionSummaryPreview[] {
  const terms = tokenizePromptForSummarySearch(opts.prompt);
  if (terms.length === 0) return [];

  const cwdCandidates = [
    ...new Set(
      (opts.cwdCandidates ?? []).filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    ),
  ];
  const repository =
    typeof opts.repository === "string" && opts.repository.length > 0
      ? opts.repository
      : null;
  const excludeSessionIds = [
    ...new Set(
      (opts.excludeSessionIds ?? []).filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    ),
  ];
  const useSinceMs =
    typeof opts.sinceMs === "number" && Number.isFinite(opts.sinceMs);
  const useUntilMs =
    typeof opts.untilMs === "number" && Number.isFinite(opts.untilMs);

  const db = getDb();
  const activityExpr = sessionSummaryLastActivitySql();
  const searchTextExpr = `LOWER(
    COALESCE(esearch.search_text, '') || ' ' ||
    COALESCE(esummary.search_text, '') || ' ' ||
    COALESCE(e.summary_text, '') || ' ' ||
    COALESCE(s.summary_text, '') || ' ' ||
    COALESCE(s.title, '') || ' ' ||
    COALESCE(sess.first_prompt, '')
  )`;
  const cwdPlaceholders = cwdCandidates.map(() => "?").join(", ");
  const cwdMatchExpr =
    cwdCandidates.length > 0
      ? `(s.cwd IN (${cwdPlaceholders})
          OR EXISTS (
            SELECT 1
            FROM session_cwds sc
            WHERE sc.session_id = s.session_id
              AND sc.cwd IN (${cwdPlaceholders})
          ))`
      : "0";
  const repositoryMatchExpr = repository ? "s.repository = ?" : "0";
  const scopeFilter =
    cwdCandidates.length > 0 || repository
      ? "AND (prompt_cwd_match = 1 OR prompt_repository_match = 1)"
      : "";
  const excludeFilter =
    excludeSessionIds.length > 0
      ? `AND session_id NOT IN (${excludeSessionIds.map(() => "?").join(", ")})`
      : "";
  const matchScoreSql = terms
    .map(
      (term) =>
        `CASE WHEN prompt_search_text LIKE ? ESCAPE '\\' THEN ${term.weight} ELSE 0 END`,
    )
    .join(" + ");
  const matchCountSql = terms
    .map(
      () => "CASE WHEN prompt_search_text LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END",
    )
    .join(" + ");
  const strongMatchCountSql = terms
    .map(
      (term) =>
        `CASE WHEN prompt_search_text LIKE ? ESCAPE '\\' THEN ${
          term.strong ? 1 : 0
        } ELSE 0 END`,
    )
    .join(" + ");
  const matchWhereSql = terms
    .map(() => "prompt_search_text LIKE ? ESCAPE '\\'")
    .join(" OR ");

  const cteParams: unknown[] = [];
  if (cwdCandidates.length > 0) {
    cteParams.push(...cwdCandidates, ...cwdCandidates);
  }
  if (repository) cteParams.push(repository);
  const matchParams = terms.map((term) => buildPromptLikePattern(term.term));
  const params: unknown[] = [
    ...cteParams,
    ...matchParams,
    ...matchParams,
    ...matchParams,
    opts.currentSessionId ?? "",
    ...excludeSessionIds,
  ];
  if (useSinceMs) params.push(opts.sinceMs);
  if (useUntilMs) params.push(opts.untilMs);
  params.push(
    ...matchParams,
    opts.minScore ?? PROMPT_RELEVANCE_MIN_SCORE,
    opts.minMatchCount ?? PROMPT_RELEVANCE_DEFAULT_MIN_COUNT,
    opts.limit ?? 5,
  );

  const rows = (
    db
      .prepare(
        `WITH candidates AS (
           SELECT ${SESSION_SUMMARY_PROJECTION_SELECT},
                  COALESCE(sess.is_automated, 0) AS prompt_is_automated,
                  CASE WHEN ${cwdMatchExpr} THEN 1 ELSE 0 END AS prompt_cwd_match,
                  CASE WHEN ${repositoryMatchExpr} THEN 1 ELSE 0 END AS prompt_repository_match,
                  ${activityExpr} AS prompt_activity_ms,
                  ${searchTextExpr} AS prompt_search_text
           FROM session_summaries s
           ${SESSION_SUMMARY_PROJECTION_JOINS}
         )
         SELECT *,
                (${matchScoreSql}) AS prompt_match_score,
                (${matchCountSql}) AS prompt_match_count,
                (${strongMatchCountSql}) AS prompt_strong_match_count
         FROM candidates
         WHERE session_id != ?
           ${excludeFilter}
           AND prompt_is_automated != 1
           ${useSinceMs ? "AND prompt_activity_ms >= ?" : ""}
           ${useUntilMs ? "AND prompt_activity_ms <= ?" : ""}
           ${scopeFilter}
           AND (${matchWhereSql})
           AND prompt_match_score >= ?
           -- Precision gate. Fire only when the overlap is specific enough
           -- to likely be the same work: either a structurally-specific
           -- term (identifier / numeric id) matched, OR a broad topical
           -- match strong enough that coincidence is unlikely. A
           -- 2-generic-word overlap — the dominant low-utility injection
           -- in the LLM-judge eval — no longer qualifies, and the generic
           -- path needs >= N distinct terms (scope-aware: 4 for vague
           -- first prompts, 3 mid-session) that carry real weight on
           -- average (>= 6 each), which excludes thin coincidences like
           -- add/app/mode/todo while keeping substantive topical overlap.
           AND (prompt_strong_match_count > 0
                OR (prompt_match_count >= ?
                    AND prompt_match_score >= prompt_match_count * 6))
         ORDER BY prompt_match_score DESC,
                  prompt_cwd_match DESC,
                  prompt_repository_match DESC,
                  prompt_activity_ms DESC,
                  session_summary_id DESC
         LIMIT ?`,
      )
      .all(...params) as RawSessionSummaryProjectionRow[]
  ).map((row) => toSessionSummaryProjectionRow(row));

  const previewFilesBySummaryId = loadSessionSummaryPreviewFiles(rows, 3);
  return rows.map((row) =>
    buildSessionSummaryPreview(
      row,
      previewFilesBySummaryId.get(row.session_summary_id) ?? [],
    ),
  );
}

function tokenizePromptForSummarySearch(prompt: string): PromptSearchTerm[] {
  const terms = prompt.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  const seen = new Map<string, number>();
  for (const [index, term] of terms.entries()) {
    const normalized = term.replace(/^-+|-+$/g, "");
    if (normalized.length < 3 || PROMPT_RELEVANCE_STOPWORDS.has(normalized)) {
      continue;
    }
    if (!seen.has(normalized)) seen.set(normalized, index);
  }
  return [...seen.entries()]
    .map(([term, index]) => ({
      term,
      weight: scorePromptSearchTerm(term),
      strong: isStrongPromptSearchTerm(term),
      index,
    }))
    .sort(
      (a, b) =>
        Number(b.strong) - Number(a.strong) ||
        b.weight - a.weight ||
        a.index - b.index,
    )
    .slice(0, PROMPT_RELEVANCE_TERM_LIMIT)
    .map(({ term, weight, strong }) => ({ term, weight, strong }));
}

// Scoring is purely structural — no curated repo-specific vocabulary. The
// shape of a token (identifier-like, numeric id, length) is a corpus-agnostic
// proxy for specificity, so this generalizes to any project's prompts.
function scorePromptSearchTerm(term: string): number {
  // Compound identifiers (snake_case, kebab-case) and alnum mixes
  // (e.g. v2, pr226) are highly specific — strong enough to match alone.
  if (term.includes("_") || term.includes("-")) return 18;
  if (/[0-9]/.test(term) && /[a-z]/.test(term)) return 18;
  // Bare numeric ids (issue/PR numbers) are specific but slightly weaker.
  if (/^\d{3,}$/.test(term)) return 16;
  // Plain words: longer is more specific, but never strong enough alone.
  return Math.min(Math.max(term.length, 4), 12);
}

// "Strong" == structurally specific: a compound identifier, an alnum mix, or
// a bare numeric id. Deliberately NOT keyed on length — a long plain English
// word ("classification", "deterministic") is generic and was the main source
// of low-utility ("tighten") injections in the LLM-judge eval.
function isStrongPromptSearchTerm(term: string): boolean {
  return (
    term.includes("_") ||
    term.includes("-") ||
    (/[0-9]/.test(term) && /[a-z]/.test(term)) ||
    /^\d{3,}$/.test(term)
  );
}

function buildPromptLikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export function whyCode(opts: {
  path: string;
  line?: number;
  repository?: string;
}): WhyCodeResult {
  const normalizedPath = normalizeLookupPath(opts.path, opts.repository);
  const repositoryRoot = lookupRepositoryRoot(opts.path, opts.repository);
  const displayPath = resolveDisplayPath(normalizedPath, repositoryRoot);
  const line = typeof opts.line === "number" ? opts.line : null;
  const history = intentForCode({ file_path: normalizedPath, limit: 10 });

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
      path: displayPath,
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
    path: displayPath,
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
      file_path: resolveDisplayPath(preferred.file_path, repositoryRoot),
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
  const repositoryRoot = lookupRepositoryRoot(opts.path, opts.repository);
  const limit = opts.limit ?? 20;
  ensureSessionSummaryProjections();
  const rows = db
    .prepare(
      `SELECT e.id AS intent_edit_id,
              e.timestamp_ms,
              e.landed,
              e.landed_reason,
              u.id AS intent_unit_id,
              u.prompt_text,
              u.repository,
              (SELECT iss.session_summary_id
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
               LIMIT 1) AS session_summary_title
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
    path: resolveDisplayPath(normalizedPath, repositoryRoot),
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
  const repositoryRoot = lookupRepositoryRoot(opts.path, opts.repository);
  const summary = loadFileOverviewSummary(normalizedPath);
  const current = whyCode({
    path: opts.path,
    repository: opts.repository,
  });
  const recent = recentWorkOnPath({
    path: opts.path,
    repository: opts.repository,
    limit: opts.recent_limit ?? 5,
  });
  const relatedFiles = loadRelatedFilesForPath(
    normalizedPath,
    opts.related_limit ?? 10,
  );

  return {
    path: resolveDisplayPath(normalizedPath, repositoryRoot),
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
    related_files: relatedFiles.map((row) => ({
      ...row,
      file_path: resolveDisplayPath(row.file_path, repositoryRoot),
    })),
  };
}

export function ensureSessionSummaryProjections(): void {
  if (needsSessionSummaryProjectionRebuild()) {
    rebuildSessionSummaryProjections();
    return;
  }
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
  const searchIndexCount = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT session_summary_key) AS c
         FROM session_summary_search_index`,
      )
      .get() as {
      c: number;
    }
  ).c;
  if (
    sessionSummaryCount === 0 ||
    membershipCount === 0 ||
    searchIndexCount < sessionSummaryCount
  ) {
    rebuildSessionSummaryProjections();
  }
}

function listSessionSummaryProjections(opts?: {
  repository?: string;
  cwd?: string;
  status?: "active" | "landed" | "mixed" | "read-only" | "unlanded";
  path?: string;
  since?: string;
  limit?: number;
  offset?: number;
}): SessionSummaryProjectionRow[] {
  ensureSessionSummaryProjections();
  const db = getDb();
  const params: unknown[] = [];
  let sql = `
    SELECT DISTINCT ${SESSION_SUMMARY_PROJECTION_SELECT}
    FROM session_summaries s
    ${SESSION_SUMMARY_PROJECTION_JOINS}`;

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
    db.prepare(sql).all(...params) as RawSessionSummaryProjectionRow[]
  ).map((row) => toSessionSummaryProjectionRow(row));
}

function getSessionSummaryProjectionDetail(opts: {
  session_summary_id: number;
}): SessionSummaryProjectionDetailResult | null {
  ensureSessionSummaryProjections();
  const db = getDb();
  const sessionSummary = db
    .prepare(
      `SELECT ${SESSION_SUMMARY_PROJECTION_SELECT}
       FROM session_summaries s
       ${SESSION_SUMMARY_PROJECTION_JOINS}
       WHERE s.id = ?`,
    )
    .get(opts.session_summary_id) as RawSessionSummaryProjectionRow | undefined;
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
              COUNT(DISTINCT e.intent_unit_id) AS intent_count,
              SUM(CASE WHEN e.landed = 1 THEN 1 ELSE 0 END) AS landed_count,
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
              MAX(COALESCE(e.timestamp_ms, u.prompt_ts_ms)) AS last_touched_ms
       FROM intent_session_summaries iss
       JOIN intent_edits e ON e.intent_unit_id = iss.intent_unit_id
       JOIN intent_units u ON u.id = e.intent_unit_id
       WHERE iss.session_summary_id = ?
       GROUP BY e.file_path
       ORDER BY edit_count DESC, e.file_path ASC`,
    )
    .all(opts.session_summary_id) as SessionSummaryFileRow[];

  return {
    session_summary: toSessionSummaryProjectionRow(sessionSummary),
    intents,
    files: files.map((row) => ({
      ...row,
      file_path: resolveCanonicalFilePath(row.file_path, {
        cwd: sessionSummary.cwd,
        repositoryRoot: sessionSummary.repository,
      }),
      landed_count: row.landed_count ?? 0,
      current_edit_count: row.current_edit_count ?? 0,
      superseded_edit_count: row.superseded_edit_count ?? 0,
      reverted_edit_count: row.reverted_edit_count ?? 0,
      unknown_edit_count: row.unknown_edit_count ?? 0,
      intent_count: row.intent_count ?? 0,
    })),
  };
}

function loadSessionSummaryPreviewFiles(
  summaries: Pick<
    SessionSummaryProjectionRow,
    "session_summary_id" | "cwd" | "repository"
  >[],
  limitPerSummary: number,
): Map<number, SessionSummaryPreviewFile[]> {
  if (summaries.length === 0) return new Map();

  const summaryById = new Map(
    summaries.map((summary) => [summary.session_summary_id, summary]),
  );
  const db = getDb();
  const placeholders = summaries.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT iss.session_summary_id,
              e.file_path,
              COUNT(*) AS edit_count,
              COUNT(DISTINCT e.intent_unit_id) AS intent_count,
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
              MAX(COALESCE(e.timestamp_ms, u.prompt_ts_ms)) AS last_touched_ms
       FROM intent_session_summaries iss
       JOIN intent_edits e ON e.intent_unit_id = iss.intent_unit_id
       JOIN intent_units u ON u.id = e.intent_unit_id
       WHERE iss.session_summary_id IN (${placeholders})
       GROUP BY iss.session_summary_id, e.file_path`,
    )
    .all(...summaries.map((summary) => summary.session_summary_id)) as Array<{
    session_summary_id: number;
    file_path: string;
    edit_count: number;
    intent_count: number;
    current_edit_count: number | null;
    superseded_edit_count: number | null;
    reverted_edit_count: number | null;
    unknown_edit_count: number | null;
    last_touched_ms: number | null;
  }>;

  const filesBySummaryId = new Map<number, SessionSummaryPreviewFile[]>();
  for (const row of rows) {
    const summary = summaryById.get(row.session_summary_id);
    if (!summary) continue;
    const currentEditCount = row.current_edit_count ?? 0;
    const file: SessionSummaryPreviewFile = {
      file_path: resolveCanonicalFilePath(row.file_path, {
        cwd: summary.cwd,
        repositoryRoot: summary.repository,
      }),
      score: 0,
      edit_count: row.edit_count,
      landed_count: currentEditCount,
      current_edit_count: currentEditCount,
      superseded_edit_count: row.superseded_edit_count ?? 0,
      reverted_edit_count: row.reverted_edit_count ?? 0,
      unknown_edit_count: row.unknown_edit_count ?? 0,
      intent_count: row.intent_count,
      last_touched_ms: row.last_touched_ms,
    };
    const files = filesBySummaryId.get(row.session_summary_id) ?? [];
    files.push(file);
    filesBySummaryId.set(row.session_summary_id, files);
  }

  for (const [summaryId, files] of filesBySummaryId) {
    filesBySummaryId.set(
      summaryId,
      rankSessionSummaryPreviewFiles(files, limitPerSummary),
    );
  }
  return filesBySummaryId;
}

function normalizeLookupPath(filePath: string, repository?: string): string {
  const direct = canonicalizeRepoFilePath(filePath, {
    repositoryRoot: repository ?? null,
    allowNonGitRepositoryRoot: true,
  });
  if (!isObservedAbsolutePath(filePath) || direct !== filePath) {
    return direct;
  }
  const storedRoot = inferStoredRepositoryRoot(filePath);
  if (!storedRoot) return direct;
  return canonicalizeRepoFilePath(filePath, {
    repositoryRoot: storedRoot,
    allowNonGitRepositoryRoot: true,
  });
}

function lookupRepositoryRoot(
  filePath: string,
  repository?: string,
): string | null {
  const direct = resolveRepositoryRootForPath({
    filePath,
    repositoryRoot: repository ?? null,
    allowNonGitRepositoryRoot: true,
  });
  return direct ?? inferStoredRepositoryRoot(filePath);
}

function resolveDisplayPath(
  filePath: string,
  repositoryRoot: string | null,
): string {
  return resolveCanonicalFilePath(filePath, {
    repositoryRoot,
  });
}

function inferStoredRepositoryRoot(filePath: string): string | null {
  if (!isObservedAbsolutePath(filePath)) return null;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT repository
       FROM (
         SELECT repository
         FROM session_summaries
         WHERE repository IS NOT NULL
           AND repository != ''
         UNION
         SELECT repository
         FROM intent_units
         WHERE repository IS NOT NULL
           AND repository != ''
       )
       ORDER BY length(repository) DESC, repository ASC`,
    )
    .all() as Array<{ repository: string }>;

  for (const row of rows) {
    if (!isObservedAbsolutePath(row.repository)) continue;
    const candidate = canonicalizeRepoFilePath(filePath, {
      repositoryRoot: row.repository,
      allowNonGitRepositoryRoot: true,
    });
    if (candidate !== filePath) {
      return row.repository;
    }
  }
  return null;
}

function toSessionSummaryRow(
  row: SessionSummaryProjectionRow,
  previewFiles: SessionSummaryPreviewFile[] = [],
): SessionSummaryRow | null {
  const summary: Omit<SessionSummaryRow, "preview"> = {
    session_id: row.session_id,
    target: row.target,
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
    projection_hash: row.projection_hash,
    projected_at_ms: row.projected_at_ms,
    source_last_seen_at_ms: row.source_last_seen_at_ms,
    summary_source: row.summary_source,
    enriched_summary_text: row.enriched_summary_text,
    enriched_search_text: row.enriched_search_text,
    enrichment_source: row.enrichment_source,
    enrichment_runner: row.enrichment_runner,
    enrichment_model: row.enrichment_model,
    enrichment_summary_version: row.enrichment_summary_version,
    enrichment_current_summary_version: row.enrichment_current_summary_version,
    enrichment_stale: row.enrichment_stale,
    enrichment_stale_reasons: row.enrichment_stale_reasons,
    enrichment_invalid_reason: row.enrichment_invalid_reason,
    enrichment_generated_at_ms: row.enrichment_generated_at_ms,
    enrichment_dirty: row.enrichment_dirty,
  };
  return {
    ...summary,
    preview: buildSessionSummaryPreview(summary, previewFiles),
  };
}

export function sessionSummaryKeyForSession(sessionId: string): string {
  return `ss:local:${sessionId}`;
}

function toSessionSummaryProjectionRow(
  row: RawSessionSummaryProjectionRow,
): SessionSummaryProjectionRow {
  const { enrichment_policy_hash: _policyHash, ...baseRow } = row;
  const currentPolicyHash = getSessionSummaryRunnerPolicy().policyHash;
  const display = selectSessionSummaryDisplay({
    summary_text: row.summary_text,
    summary_source: parseSummarySource(row.summary_source),
    enriched_summary_text: row.enriched_summary_text,
    enrichment_source: parseEnrichmentSource(row.enrichment_source),
    enrichment_dirty: row.enrichment_dirty === 1,
    enrichment_summary_version: row.enrichment_summary_version,
    enrichment_policy_hash: row.enrichment_policy_hash,
    current_policy_hash: currentPolicyHash,
  });
  const enrichedSearchText = display.enrichment.invalidReason
    ? null
    : validEnrichedText(row.enriched_search_text);
  return {
    ...baseRow,
    target: emptyToNull(row.target),
    repository: emptyToNull(row.repository),
    summary_source: parseSummarySource(row.summary_source),
    enriched_summary_text: display.enrichment.summaryText,
    enriched_search_text: enrichedSearchText,
    enrichment_source:
      display.enrichment.summaryText || enrichedSearchText
        ? parseEnrichmentSource(row.enrichment_source)
        : null,
    enrichment_current_summary_version:
      display.enrichment.currentSummaryVersion,
    enrichment_stale: display.enrichment.stale,
    enrichment_stale_reasons: display.enrichment.staleReasons,
    enrichment_invalid_reason: display.enrichment.invalidReason,
    enrichment_dirty: row.enrichment_dirty === 1,
  };
}

function validEnrichedText(value: string | null): string | null {
  const trimmed = emptyToNull(value);
  if (!trimmed) return null;
  return invalidSessionSummaryEnrichmentReason(trimmed) ? null : trimmed;
}

function parseSummarySource(
  value: string | null,
): SessionSummaryProjectionRow["summary_source"] {
  return value === "deterministic" ? value : null;
}

function parseEnrichmentSource(
  value: string | null,
): SessionSummaryProjectionRow["enrichment_source"] {
  return value === "llm" ? value : null;
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
