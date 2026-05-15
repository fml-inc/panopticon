import { clearAttemptBackoff } from "../attempt-backoff.js";
import { getDb } from "../db/schema.js";
import { sessionSummaryLastActivitySql } from "./activity.js";
import { SUMMARY_ROW_BACKOFF_SCOPE } from "./backoff.js";
import {
  SESSION_SUMMARY_ENRICHMENT_VERSION,
  SESSION_SUMMARY_PENDING_AGE_THRESHOLD_MS,
} from "./model.js";
import { getSessionSummaryRunnerPolicy } from "./policy.js";
import { ensureSessionSummaryProjections } from "./query.js";

export type SessionSummaryRegenerationTimeField =
  | "activity"
  | "generated-at"
  | "projected-at";

export interface RegenerateSessionSummariesInput {
  sessionId?: string;
  cwd?: string;
  repository?: string;
  since?: string;
  before?: string;
  by?: SessionSummaryRegenerationTimeField;
  reason?: string;
  all?: boolean;
  staleOnly?: boolean;
  dirtyOnly?: boolean;
  cleanOnly?: boolean;
  dryRun?: boolean;
  limit?: number;
}

export interface RegenerateSessionSummaryItem {
  session_id: string;
  session_summary_key: string;
  title: string;
  status: string;
  repository: string | null;
  cwd: string | null;
  summary_version: number;
  summary_runner: string | null;
  dirty: boolean;
  stale: boolean;
  time_ms: number | null;
  last_activity_ms: number | null;
  summary_generated_at_ms: number | null;
}

export interface RegenerateSessionSummariesResult {
  dryRun: boolean;
  selected: number;
  markedDirty: number;
  alreadyDirty: number;
  stale: number;
  current: number;
  currentVersion: number;
  timeField: SessionSummaryRegenerationTimeField;
  filter: {
    sessionId?: string;
    cwd?: string;
    repository?: string;
    sinceMs?: number;
    beforeMs?: number;
    reason: string;
    all: boolean;
    staleOnly: boolean;
    dirtyOnly: boolean;
    cleanOnly: boolean;
    limit?: number;
  };
  byVersion: Record<string, number>;
  byRunner: Record<string, number>;
  items: RegenerateSessionSummaryItem[];
}

interface RawRegenerationRow {
  session_summary_key: string;
  session_id: string;
  title: string;
  status: string;
  repository: string | null;
  cwd: string | null;
  summary_version: number;
  summary_runner: string | null;
  summary_policy_hash: string | null;
  summary_generated_at_ms: number | null;
  dirty: number;
  dirty_reason_json: string | null;
  last_activity_ms: number | null;
  time_ms: number | null;
}

const ACTIVITY_SQL = sessionSummaryLastActivitySql();

export function regenerateSessionSummaryEnrichments(
  opts: RegenerateSessionSummariesInput = {},
): RegenerateSessionSummariesResult {
  const timeField = opts.by ?? "activity";
  const sinceMs = parseTimeFilter(opts.since, "--since");
  const beforeMs = parseTimeFilter(opts.before, "--before");
  const reason = normalizeReason(opts.reason);
  const dryRun = opts.dryRun !== false;
  const limit = normalizeLimit(opts.limit);
  const all = opts.all === true;
  const staleOnly = opts.staleOnly === true;
  const dirtyOnly = opts.dirtyOnly === true;
  const cleanOnly = opts.cleanOnly === true;

  if ([dirtyOnly, cleanOnly].filter(Boolean).length > 1) {
    throw new Error("--dirty-only and --clean-only are mutually exclusive");
  }
  if (
    !all &&
    !opts.sessionId &&
    !opts.cwd &&
    !opts.repository &&
    sinceMs === undefined &&
    beforeMs === undefined
  ) {
    throw new Error(
      "At least one regeneration scope is required: --session, --cwd, --repository, --since, --before, or --all",
    );
  }

  ensureSessionSummaryProjections();

  const db = getDb();
  const policy = getSessionSummaryRunnerPolicy();
  const nowMs = Date.now();
  const timeSql = timeExpression(timeField);
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.sessionId) {
    where.push("s.session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.cwd) {
    where.push("s.cwd = ?");
    params.push(opts.cwd);
  }
  if (opts.repository) {
    where.push("s.repository = ?");
    params.push(opts.repository);
  }
  if (sinceMs !== undefined) {
    where.push(`${timeSql} >= ?`);
    params.push(sinceMs);
  }
  if (beforeMs !== undefined) {
    where.push(`${timeSql} <= ?`);
    params.push(beforeMs);
  }
  if (staleOnly) {
    where.push(
      `(COALESCE(e.dirty, 0) = 1
        OR COALESCE(e.summary_version, -1) != ?
        OR e.summary_policy_hash IS NULL
        OR e.summary_policy_hash != ?)`,
    );
    params.push(SESSION_SUMMARY_ENRICHMENT_VERSION, policy.policyHash);
  }
  if (dirtyOnly) {
    where.push("COALESCE(e.dirty, 0) = 1");
  }
  if (cleanOnly) {
    where.push("COALESCE(e.dirty, 0) != 1");
  }

  const rows = db
    .prepare(
      `SELECT s.session_summary_key,
              s.session_id,
              s.title,
              s.status,
              s.repository,
              s.cwd,
              e.summary_version,
              e.summary_runner,
              e.summary_policy_hash,
              e.summary_generated_at_ms,
              e.dirty,
              e.dirty_reason_json,
              ${ACTIVITY_SQL} AS last_activity_ms,
              ${timeSql} AS time_ms
       FROM session_summaries s
       JOIN session_summary_enrichments e
         ON e.session_summary_key = s.session_summary_key
       LEFT JOIN sessions sess
         ON sess.session_id = s.session_id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${timeSql} DESC, s.session_summary_key ASC
      ${limit !== undefined ? "LIMIT ?" : ""}`,
    )
    .all(
      ...params,
      ...(limit !== undefined ? [limit] : []),
    ) as RawRegenerationRow[];

  const selectedRows = rows;

  const byVersion: Record<string, number> = {};
  const byRunner: Record<string, number> = {};
  let alreadyDirty = 0;
  let stale = 0;
  for (const row of selectedRows) {
    byVersion[String(row.summary_version)] =
      (byVersion[String(row.summary_version)] ?? 0) + 1;
    const runner = row.summary_runner ?? "unknown";
    byRunner[runner] = (byRunner[runner] ?? 0) + 1;
    if (row.dirty === 1) alreadyDirty += 1;
    if (isStale(row, policy.policyHash)) stale += 1;
  }

  let markedDirty = 0;
  if (!dryRun && selectedRows.length > 0) {
    const eligibleAtMs = nowMs - SESSION_SUMMARY_PENDING_AGE_THRESHOLD_MS - 1;
    const updateEnrichment = db.prepare(
      `UPDATE session_summary_enrichments
       SET dirty = 1,
           dirty_reason_json = ?,
           last_material_change_at_ms = ?,
           last_attempted_at_ms = NULL,
           failure_count = 0,
           last_error = NULL
       WHERE session_summary_key = ?`,
    );
    const markLlmSearchDirty = db.prepare(
      `UPDATE session_summary_search_index
       SET dirty = 1,
           updated_at_ms = ?
       WHERE session_summary_key = ?
         AND source = 'llm'`,
    );
    const bumpDerivedSyncSeq = db.prepare(
      `UPDATE sessions
       SET derived_sync_seq = COALESCE(derived_sync_seq, 0) + 1
       WHERE session_id = ?`,
    );

    const tx = db.transaction((txRows: RawRegenerationRow[]) => {
      for (const row of txRows) {
        const result = updateEnrichment.run(
          buildDirtyReasonJson(row, {
            reason,
            nowMs,
            timeField,
            sinceMs,
            beforeMs,
            policyHash: policy.policyHash,
            scope: {
              sessionId: opts.sessionId,
              cwd: opts.cwd,
              repository: opts.repository,
              all,
            },
          }),
          eligibleAtMs,
          row.session_summary_key,
        );
        if (result.changes > 0) {
          markedDirty += 1;
          markLlmSearchDirty.run(nowMs, row.session_summary_key);
          bumpDerivedSyncSeq.run(row.session_id);
          clearAttemptBackoff(
            SUMMARY_ROW_BACKOFF_SCOPE,
            row.session_summary_key,
          );
        }
      }
    });
    tx(selectedRows);
  }

  return {
    dryRun,
    selected: selectedRows.length,
    markedDirty,
    alreadyDirty,
    stale,
    current: selectedRows.length - stale,
    currentVersion: SESSION_SUMMARY_ENRICHMENT_VERSION,
    timeField,
    filter: {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      repository: opts.repository,
      sinceMs,
      beforeMs,
      reason,
      all,
      staleOnly,
      dirtyOnly,
      cleanOnly,
      limit,
    },
    byVersion,
    byRunner,
    items: selectedRows.slice(0, 50).map((row) => ({
      session_id: row.session_id,
      session_summary_key: row.session_summary_key,
      title: row.title,
      status: row.status,
      repository: row.repository,
      cwd: row.cwd,
      summary_version: row.summary_version,
      summary_runner: row.summary_runner,
      dirty: row.dirty === 1,
      stale: isStale(row, policy.policyHash),
      time_ms: nullIfZero(row.time_ms),
      last_activity_ms: nullIfZero(row.last_activity_ms),
      summary_generated_at_ms: row.summary_generated_at_ms,
    })),
  };
}

function parseTimeFilter(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
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
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid ${label} value: ${value} (use ISO date or relative like 24h, 7d, 30m)`,
    );
  }
  return parsed;
}

function normalizeReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "manual";
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  return Math.floor(limit);
}

function timeExpression(field: SessionSummaryRegenerationTimeField): string {
  switch (field) {
    case "activity":
      return ACTIVITY_SQL;
    case "generated-at":
      return "COALESCE(e.summary_generated_at_ms, 0)";
    case "projected-at":
      return "COALESCE(s.projected_at_ms, 0)";
    default:
      throw new Error(
        `Invalid --by value: ${field} (expected activity, generated-at, or projected-at)`,
      );
  }
}

function isStale(row: RawRegenerationRow, policyHash: string): boolean {
  return (
    row.dirty === 1 ||
    row.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION ||
    row.summary_policy_hash !== policyHash
  );
}

function buildDirtyReasonJson(
  row: RawRegenerationRow,
  opts: {
    reason: string;
    nowMs: number;
    timeField: SessionSummaryRegenerationTimeField;
    sinceMs?: number;
    beforeMs?: number;
    policyHash: string;
    scope: {
      sessionId?: string;
      cwd?: string;
      repository?: string;
      all: boolean;
    };
  },
): string {
  const reasons = new Set(parseDirtyReasons(row.dirty_reason_json));
  reasons.add("regeneration_requested");
  if (row.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION) {
    reasons.add("summary_version_changed");
  }
  if (row.summary_policy_hash !== opts.policyHash) {
    reasons.add("summary_policy_changed");
  }
  reasons.add("refresh_pending");

  return JSON.stringify({
    reasons: Array.from(reasons),
    regeneration: {
      reason: opts.reason,
      requested_at_ms: opts.nowMs,
      current_summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
      time_field: opts.timeField,
      since_ms: opts.sinceMs ?? null,
      before_ms: opts.beforeMs ?? null,
      scope: opts.scope,
    },
  });
}

function parseDirtyReasons(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { reasons?: unknown };
    if (!Array.isArray(parsed.reasons)) return [];
    return parsed.reasons.filter(
      (reason): reason is string =>
        typeof reason === "string" && reason.length > 0,
    );
  } catch {
    return [];
  }
}

function nullIfZero(value: number | null): number | null {
  return value === 0 ? null : value;
}
