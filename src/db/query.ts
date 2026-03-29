import { allTargets } from "../targets/index.js";
import type { MetricSpec } from "../targets/types.js";
import type {
  ActivitySessionDetail,
  ActivitySummaryResult,
  SearchMatch,
  SearchResult,
  Session,
  SessionListResult,
  SessionTimelineResult,
  SpendingGroup,
  SpendingResult,
  TimelineEvent,
} from "../types.js";
import { COST_EXPR } from "./pricing.js";
import { getDb } from "./schema.js";

// ── Adapter-driven SQL helpers ───────────────────────────────────────────────

/** Build a COALESCE SQL expr to extract the model from metric attributes. */
function buildModelExpr(spec: MetricSpec): string {
  const exprs = spec.modelAttrs.map((a) => `json_extract(attributes, '${a}')`);
  return exprs.length === 1 ? exprs[0] : `COALESCE(${exprs.join(", ")})`;
}

/** Build a SQL expr to extract and optionally remap token_type from metric attributes. */
function buildTokenTypeExpr(spec: MetricSpec): string {
  const exprs = spec.tokenTypeAttrs.map(
    (a) => `json_extract(attributes, '${a}')`,
  );
  const inner = exprs.length === 1 ? exprs[0] : `COALESCE(${exprs.join(", ")})`;

  if (!spec.tokenTypeMap || Object.keys(spec.tokenTypeMap).length === 0) {
    return inner;
  }

  const whenClauses = Object.entries(spec.tokenTypeMap)
    .map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
    .join(" ");
  return `CASE ${inner} ${whenClauses} ELSE ${inner} END`;
}

/**
 * Resolved metrics CTE — generates one UNION ALL branch per target that
 * declares otel.metrics, using the adapter's aggregation strategy.
 */
function resolvedMetricsCTE(extraWhere = ""): string {
  const branches: string[] = [];

  for (const target of allTargets()) {
    const spec = target.otel?.metrics;
    if (!spec) continue;

    const nameList = spec.metricNames.map((n) => `'${n}'`).join(", ");
    const modelExpr = buildModelExpr(spec);
    const tokenTypeExpr = buildTokenTypeExpr(spec);

    let whereClause = `WHERE name IN (${nameList})`;
    if (spec.excludeTokenTypes?.length) {
      const rawCoalesce = spec.tokenTypeAttrs
        .map((a) => `json_extract(attributes, '${a}')`)
        .join(", ");
      const rawExpr =
        spec.tokenTypeAttrs.length === 1
          ? rawCoalesce
          : `COALESCE(${rawCoalesce})`;
      for (const excluded of spec.excludeTokenTypes) {
        whereClause += `\n        AND ${rawExpr} != '${excluded}'`;
      }
    }
    whereClause += `\n      ${extraWhere}`;

    branches.push(`
      -- ${target.id}: ${spec.aggregation}
      SELECT session_id,
             ${modelExpr} as model,
             ${tokenTypeExpr} as token_type,
             ${spec.aggregation}(value) as tokens
      FROM otel_metrics
      ${whereClause}
      GROUP BY session_id, model, token_type`);
  }

  if (branches.length === 0) {
    return `resolved_tokens AS (SELECT NULL as session_id, NULL as model, NULL as token_type, 0 as tokens WHERE 0)`;
  }

  return `resolved_tokens AS (${branches.join("\n\n      UNION ALL\n")}\n    )`;
}

function parseSince(since?: string): number | null {
  if (!since) return null;
  const match = since.match(/^(\d+)(h|d|m)$/);
  if (match) {
    const [, num, unit] = match;
    const ms = unit === "h" ? 3600000 : unit === "d" ? 86400000 : 60000;
    return Date.now() - parseInt(num, 10) * ms;
  }
  const date = new Date(since);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── OTel log SQL helpers (adapter-driven) ────────────────────────────────────

/** Build COALESCE/CASE expressions for OTel log event type and timestamp from adapter specs. */
function buildOtelLogExprs(): { eventType: string; timestampMs: string } {
  const defaultTs = "CAST(timestamp_ns / 1000000 AS INTEGER)";
  const eventExprs = new Set<string>(["body"]);
  const extraTsExprs = new Set<string>();

  for (const target of allTargets()) {
    const lf = target.otel?.logFields;
    if (!lf) continue;
    for (const expr of lf.eventTypeExprs ?? []) {
      eventExprs.add(expr);
    }
    for (const expr of lf.timestampMsExprs ?? []) {
      if (expr !== defaultTs) extraTsExprs.add(expr);
    }
  }

  const eventExprArr = [...eventExprs];
  const eventType =
    eventExprArr.length === 1
      ? eventExprArr[0]
      : `COALESCE(${eventExprArr.join(", ")})`;

  let timestampMs = defaultTs;
  if (extraTsExprs.size > 0) {
    const fallbackArr = [...extraTsExprs];
    const fallbackExpr =
      fallbackArr.length === 1
        ? fallbackArr[0]
        : `COALESCE(${fallbackArr.join(", ")})`;
    timestampMs = `CASE WHEN timestamp_ns > 0 THEN ${defaultTs} ELSE ${fallbackExpr} END`;
  }

  return { eventType, timestampMs };
}

let _otelLogExprs: { eventType: string; timestampMs: string } | null = null;
function otelLogExprs() {
  if (!_otelLogExprs) _otelLogExprs = buildOtelLogExprs();
  return _otelLogExprs;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

interface RawSessionRow {
  session_id: string;
  start_ms: number;
  end_ms: number;
  event_count: number;
  tool_count: number;
  total_tokens: number;
  total_cost: number;
  cwd: string | null;
  first_prompt: string | null;
  event_type_counts: string | null;
}

interface RawRepoRow {
  session_id: string;
  repository: string;
  git_user_name: string | null;
  git_user_email: string | null;
}

export function listSessions(
  opts: { limit?: number; since?: string } = {},
): SessionListResult {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const sinceMs = parseSince(opts.since);

  const sinceClause = sinceMs ? "WHERE timestamp_ms >= ?" : "";

  const sql = `
    WITH all_sessions AS (
      SELECT session_id,
             MIN(timestamp_ms) as start_ms,
             MAX(timestamp_ms) as end_ms,
             COUNT(*) as event_count,
             COUNT(DISTINCT tool_name) as tool_count
      FROM hook_events
      ${sinceClause}
      GROUP BY session_id
    ),
    ${resolvedMetricsCTE()},
    otel_costs AS (
      SELECT session_id,
             SUM(tokens) as total_tokens,
             SUM(${COST_EXPR}) as total_cost
      FROM resolved_tokens
      GROUP BY session_id
    ),
    session_cwds AS (
      SELECT h.session_id, h.cwd
      FROM hook_events h
      INNER JOIN all_sessions a ON h.session_id = a.session_id
      WHERE h.event_type = 'SessionStart' AND h.cwd IS NOT NULL
      GROUP BY h.session_id
    ),
    session_prompts AS (
      SELECT h.session_id, MIN(h.timestamp_ms) as ts, SUBSTR(h.user_prompt, 1, 200) as prompt
      FROM hook_events h
      INNER JOIN all_sessions a ON h.session_id = a.session_id
      WHERE h.event_type = 'UserPromptSubmit' AND h.user_prompt IS NOT NULL
      GROUP BY h.session_id
    ),
    session_event_types AS (
      SELECT session_id,
             json_group_object(event_type, cnt) as event_type_counts
      FROM (
        SELECT h.session_id, h.event_type, COUNT(*) as cnt
        FROM hook_events h
        INNER JOIN all_sessions a ON h.session_id = a.session_id
        GROUP BY h.session_id, h.event_type
      )
      GROUP BY session_id
    )
    SELECT s.session_id,
           s.start_ms,
           s.end_ms,
           s.event_count,
           s.tool_count,
           COALESCE(c.total_tokens, 0) as total_tokens,
           COALESCE(c.total_cost, 0) as total_cost,
           sc.cwd,
           sp.prompt as first_prompt,
           se.event_type_counts
    FROM all_sessions s
    LEFT JOIN otel_costs c ON s.session_id = c.session_id
    LEFT JOIN session_cwds sc ON s.session_id = sc.session_id
    LEFT JOIN session_prompts sp ON s.session_id = sp.session_id
    LEFT JOIN session_event_types se ON s.session_id = se.session_id
    GROUP BY s.session_id
    ORDER BY s.start_ms DESC
    LIMIT ?
  `;

  const params: unknown[] = [];
  if (sinceMs) params.push(sinceMs);
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as RawSessionRow[];

  const sessionIds = rows.map((r) => r.session_id);
  const repoRows =
    sessionIds.length > 0
      ? (db
          .prepare(
            `SELECT session_id, repository, git_user_name, git_user_email
             FROM session_repositories
             WHERE session_id IN (${sessionIds.map(() => "?").join(",")})`,
          )
          .all(...sessionIds) as RawRepoRow[])
      : [];

  const reposBySession = new Map<string, RawRepoRow[]>();
  for (const r of repoRows) {
    const list = reposBySession.get(r.session_id) ?? [];
    list.push(r);
    reposBySession.set(r.session_id, list);
  }

  const sessions: Session[] = rows.map((row) => ({
    sessionId: row.session_id,
    startedAt: toIso(row.start_ms),
    endedAt: toIso(row.end_ms),
    eventCount: row.event_count,
    toolCount: row.tool_count,
    totalTokens: row.total_tokens,
    totalCost: row.total_cost,
    repositories: (reposBySession.get(row.session_id) ?? []).map((r) => ({
      name: r.repository,
      gitUserName: r.git_user_name,
      gitUserEmail: r.git_user_email,
    })),
    cwd: row.cwd ?? null,
    firstPrompt: row.first_prompt ?? null,
    eventTypeCounts:
      (parseJson(row.event_type_counts) as Record<string, number>) ?? {},
  }));

  return {
    sessions,
    totalCount: sessions.length,
    source: "local",
  };
}

// ── Timeline ──────────────────────────────────────────────────────────────────

interface RawTimelineRow {
  source: string;
  id: number;
  session_id: string;
  event_type: string;
  timestamp_ms: number;
  tool_name: string | null;
  cwd: string | null;
  payload: string | null;
  user_prompt: string | null;
  body: string | null;
  attributes: string | null;
  severity_text: string | null;
}

export function sessionTimeline(opts: {
  sessionId: string;
  eventTypes?: string[];
  limit?: number;
  offset?: number;
  fullPayloads?: boolean;
}): SessionTimelineResult {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const truncate = !opts.fullPayloads;

  const payloadCol = truncate
    ? "SUBSTR(decompress(payload), 1, 500)"
    : "decompress(payload)";
  const attrsCol = truncate ? "SUBSTR(attributes, 1, 500)" : "attributes";

  let hookSql = `
    SELECT 'hook' as source, id, session_id, event_type, timestamp_ms,
           tool_name, cwd, ${payloadCol} as payload, user_prompt,
           NULL as body, NULL as attributes, NULL as severity_text
    FROM hook_events
    WHERE session_id = ?
  `;
  const hookParams: unknown[] = [opts.sessionId];

  if (opts.eventTypes?.length) {
    hookSql += ` AND event_type IN (${opts.eventTypes.map(() => "?").join(",")})`;
    hookParams.push(...opts.eventTypes);
  }

  let otelSql = `
    SELECT 'otel' as source, id, session_id, ${otelLogExprs().eventType} as event_type,
           ${otelLogExprs().timestampMs} as timestamp_ms,
           NULL as tool_name, NULL as cwd, NULL as payload, NULL as user_prompt,
           ${otelLogExprs().eventType} as body, ${attrsCol} as attributes, severity_text
    FROM otel_logs
    WHERE session_id = ?
  `;
  const otelParams: unknown[] = [opts.sessionId];

  if (opts.eventTypes?.length) {
    otelSql += ` AND ${otelLogExprs().eventType} IN (${opts.eventTypes.map(() => "?").join(",")})`;
    otelParams.push(...opts.eventTypes);
  }

  const countSql = `SELECT COUNT(*) as total FROM (${hookSql} UNION ALL ${otelSql})`;
  const total = (
    db.prepare(countSql).get(...hookParams, ...otelParams) as { total: number }
  ).total;

  const sql = `
    SELECT * FROM (${hookSql} UNION ALL ${otelSql})
    ORDER BY timestamp_ms ASC
    LIMIT ? OFFSET ?
  `;
  const rows = db
    .prepare(sql)
    .all(...hookParams, ...otelParams, limit, offset) as RawTimelineRow[];

  // Session metadata
  const cwdRow = db
    .prepare(
      "SELECT cwd FROM hook_events WHERE session_id = ? AND event_type = 'SessionStart' LIMIT 1",
    )
    .get(opts.sessionId) as { cwd: string | null } | undefined;

  const repoRows = db
    .prepare(
      "SELECT repository, git_user_name, git_user_email FROM session_repositories WHERE session_id = ?",
    )
    .all(opts.sessionId) as RawRepoRow[];

  const events: TimelineEvent[] = rows.map((row) => {
    let promptPreview: string | null = null;
    let payload: unknown = null;

    if (row.source === "hook") {
      payload = parseJson(row.payload);
      if (row.user_prompt) {
        promptPreview = row.user_prompt.slice(0, 300);
      }
    } else {
      payload = parseJson(row.attributes);
    }

    return {
      eventType: row.event_type,
      timestamp: toIso(row.timestamp_ms),
      toolName: row.tool_name,
      promptPreview,
      payload,
    };
  });

  return {
    session: {
      sessionId: opts.sessionId,
      repositories: repoRows.map((r) => ({
        name: r.repository,
        gitUserName: r.git_user_name,
        gitUserEmail: r.git_user_email,
      })),
      cwd: cwdRow?.cwd ?? null,
    },
    events,
    totalEvents: total,
    hasMore: offset + rows.length < total,
    source: "local",
  };
}

// ── Tool Stats (not in unified types — panopticon-specific) ───────────────────

export function toolStats(opts: { since?: string; session_id?: string } = {}) {
  const db = getDb();
  const sinceMs = parseSince(opts.since);

  const conditions: string[] = ["tool_name IS NOT NULL"];
  const params: unknown[] = [];

  if (opts.session_id) {
    conditions.push("session_id = ?");
    params.push(opts.session_id);
  }
  if (sinceMs) {
    conditions.push("timestamp_ms >= ?");
    params.push(sinceMs);
  }

  const where = conditions.join(" AND ");

  const sql = `
    SELECT tool_name,
           COUNT(*) as call_count,
           SUM(CASE WHEN event_type = 'PostToolUse' THEN 1 ELSE 0 END) as success_count,
           SUM(CASE WHEN event_type = 'PostToolUseFailure' THEN 1 ELSE 0 END) as failure_count
    FROM hook_events
    WHERE ${where}
    GROUP BY tool_name
    ORDER BY call_count DESC
  `;

  return db.prepare(sql).all(...params);
}

// ── Spending ──────────────────────────────────────────────────────────────────

interface RawCostRow {
  group_key: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost: number;
  session_count: number;
}

export function costBreakdown(
  opts: { since?: string; groupBy?: "session" | "model" | "day" } = {},
): SpendingResult {
  const db = getDb();
  const sinceMs = parseSince(opts.since);
  const groupBy = opts.groupBy ?? "session";

  const extraWhere = sinceMs
    ? `AND CAST(timestamp_ns / 1000000 AS INTEGER) >= ${Number(sinceMs)}`
    : "";

  let sql: string;

  if (groupBy === "day") {
    // Day grouping needs session start times — join resolved_tokens with hook_events
    sql = `
      WITH ${resolvedMetricsCTE(extraWhere)},
      session_starts AS (
        SELECT session_id, date(MIN(timestamp_ms) / 1000, 'unixepoch') as day
        FROM hook_events
        GROUP BY session_id
      )
      SELECT ss.day as group_key,
             SUM(CASE WHEN token_type IN ('input', 'cacheRead', 'cacheWrite') THEN tokens ELSE 0 END) as input_tokens,
             SUM(CASE WHEN token_type = 'output' THEN tokens ELSE 0 END) as output_tokens,
             SUM(tokens) as total_tokens,
             SUM(${COST_EXPR}) as total_cost,
             COUNT(DISTINCT resolved_tokens.session_id) as session_count
      FROM resolved_tokens
      INNER JOIN session_starts ss ON resolved_tokens.session_id = ss.session_id
      GROUP BY ss.day
      ORDER BY ss.day DESC
    `;
  } else {
    const groupExpr = groupBy === "model" ? "model" : "session_id";
    const selectExpr =
      groupBy === "model" ? "model as group_key" : "session_id as group_key";

    sql = `
      WITH ${resolvedMetricsCTE(extraWhere)}
      SELECT ${selectExpr},
             SUM(CASE WHEN token_type IN ('input', 'cacheRead', 'cacheWrite') THEN tokens ELSE 0 END) as input_tokens,
             SUM(CASE WHEN token_type = 'output' THEN tokens ELSE 0 END) as output_tokens,
             SUM(tokens) as total_tokens,
             SUM(${COST_EXPR}) as total_cost,
             COUNT(DISTINCT session_id) as session_count
      FROM resolved_tokens
      GROUP BY ${groupExpr}
      ORDER BY total_tokens DESC
    `;
  }

  const rows = db.prepare(sql).all() as RawCostRow[];

  const groups: SpendingGroup[] = rows.map((row) => ({
    key: row.group_key,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    totalCost: row.total_cost,
    sessionCount: row.session_count,
  }));

  const totals = {
    inputTokens: groups.reduce((sum, g) => sum + g.inputTokens, 0),
    outputTokens: groups.reduce((sum, g) => sum + g.outputTokens, 0),
    totalTokens: groups.reduce((sum, g) => sum + g.totalTokens, 0),
    totalCost: groups.reduce((sum, g) => sum + g.totalCost, 0),
  };

  return { groups, totals, groupBy, source: "local" };
}

// ── Search ────────────────────────────────────────────────────────────────────

interface RawSearchRow {
  source: string;
  id: number;
  session_id: string;
  event_type: string;
  timestamp_ms: number;
  tool_name: string | null;
  cwd: string | null;
  payload: string | null;
}

export function searchEvents(opts: {
  query: string;
  eventTypes?: string[];
  since?: string;
  limit?: number;
  offset?: number;
  fullPayloads?: boolean;
}): SearchResult {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const sinceMs = parseSince(opts.since);
  const pattern = `%${opts.query}%`;
  const truncate = !opts.fullPayloads;

  const hookPayloadCol = truncate
    ? "SUBSTR(decompress(h.payload), 1, 500)"
    : "decompress(h.payload)";

  const hookConditions: string[] = [];
  const hookParams: unknown[] = [];

  hookConditions.push(
    "(h.id IN (SELECT rowid FROM hook_events_fts WHERE hook_events_fts MATCH ?) OR h.tool_name LIKE ? OR h.event_type LIKE ?)",
  );
  hookParams.push(opts.query, pattern, pattern);

  if (opts.eventTypes?.length) {
    hookConditions.push(
      `h.event_type IN (${opts.eventTypes.map(() => "?").join(",")})`,
    );
    hookParams.push(...opts.eventTypes);
  }
  if (sinceMs) {
    hookConditions.push("h.timestamp_ms >= ?");
    hookParams.push(sinceMs);
  }

  const hookSql = `
    SELECT 'hook' as source, h.id, h.session_id, h.event_type, h.timestamp_ms,
           h.tool_name, h.cwd, ${hookPayloadCol} as payload
    FROM hook_events h
    WHERE ${hookConditions.join(" AND ")}
  `;

  const otelConditions: string[] = ["(o.body LIKE ? OR o.attributes LIKE ?)"];
  const otelParams: unknown[] = [pattern, pattern];

  if (sinceMs) {
    otelConditions.push("CAST(o.timestamp_ns / 1000000 AS INTEGER) >= ?");
    otelParams.push(sinceMs);
  }

  const otelAttrsCol = truncate
    ? "SUBSTR(o.attributes, 1, 500)"
    : "o.attributes";

  // Use table-qualified versions of the OTel expressions for the aliased query
  const otelEventTypeQ = otelLogExprs().eventType.replace(
    /\b(body|timestamp_ns|attributes)\b/g,
    "o.$1",
  );
  const otelTimestampMsQ = otelLogExprs().timestampMs.replace(
    /\b(body|timestamp_ns|attributes)\b/g,
    "o.$1",
  );

  const otelSql = `
    SELECT 'otel' as source, o.id, o.session_id,
           ${otelEventTypeQ} as event_type,
           ${otelTimestampMsQ} as timestamp_ms,
           NULL as tool_name, NULL as cwd, ${otelAttrsCol} as payload
    FROM otel_logs o
    WHERE ${otelConditions.join(" AND ")}
  `;

  const countSql = `SELECT COUNT(*) as total FROM (${hookSql} UNION ALL ${otelSql})`;
  const total = (
    db.prepare(countSql).get(...hookParams, ...otelParams) as { total: number }
  ).total;

  const sql = `
    SELECT * FROM (${hookSql} UNION ALL ${otelSql})
    ORDER BY timestamp_ms DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db
    .prepare(sql)
    .all(...hookParams, ...otelParams, limit, offset) as RawSearchRow[];

  const results: SearchMatch[] = rows.map((row) => {
    const snippet = row.payload ?? row.event_type ?? "";
    const matchType =
      row.event_type === "UserPromptSubmit"
        ? "prompt"
        : row.tool_name
          ? "tool_use"
          : "event";

    return {
      sessionId: row.session_id,
      timestamp: toIso(row.timestamp_ms),
      matchType,
      matchSnippet:
        typeof snippet === "string"
          ? snippet.slice(0, 300)
          : String(snippet).slice(0, 300),
      eventType: row.event_type,
      toolName: row.tool_name,
    };
  });

  return {
    results,
    totalMatches: total,
    query: opts.query,
    source: "local",
  };
}

// ── Activity Summary ──────────────────────────────────────────────────────────

export function activitySummary(
  opts: { since?: string } = {},
): ActivitySummaryResult {
  const db = getDb();
  const sinceMs = parseSince(opts.since ?? "24h") ?? Date.now() - 86400000;
  const now = Date.now();

  const sessionsSql = `
    SELECT session_id,
           MIN(timestamp_ms) as start_ms,
           MAX(timestamp_ms) as end_ms,
           COUNT(*) as event_count
    FROM hook_events
    WHERE timestamp_ms >= ?
    GROUP BY session_id
    ORDER BY start_ms ASC
  `;
  const rawSessions = db.prepare(sessionsSql).all(sinceMs) as {
    session_id: string;
    start_ms: number;
    end_ms: number;
    event_count: number;
  }[];

  let totalCost = 0;
  let totalTokens = 0;
  const sessions: ActivitySessionDetail[] = [];

  for (const s of rawSessions) {
    const prompts = db
      .prepare(
        "SELECT SUBSTR(user_prompt, 1, 100) as prompt FROM hook_events WHERE session_id = ? AND event_type = 'UserPromptSubmit' AND timestamp_ms >= ? ORDER BY timestamp_ms ASC",
      )
      .all(s.session_id, sinceMs) as { prompt: string | null }[];

    const tools = db
      .prepare(
        "SELECT tool_name, COUNT(*) as count FROM hook_events WHERE session_id = ? AND event_type = 'PostToolUse' AND tool_name IS NOT NULL AND timestamp_ms >= ? GROUP BY tool_name ORDER BY count DESC",
      )
      .all(s.session_id, sinceMs) as { tool_name: string; count: number }[];

    const files = db
      .prepare(
        "SELECT DISTINCT file_path FROM hook_events WHERE session_id = ? AND tool_name IN ('Write', 'Edit') AND event_type = 'PostToolUse' AND file_path IS NOT NULL AND timestamp_ms >= ?",
      )
      .all(s.session_id, sinceMs) as { file_path: string | null }[];

    const repos = db
      .prepare(
        "SELECT repository, git_user_name, git_user_email FROM session_repositories WHERE session_id = ?",
      )
      .all(s.session_id) as RawRepoRow[];

    const cwdRow = db
      .prepare(
        "SELECT cwd FROM hook_events WHERE session_id = ? AND event_type = 'SessionStart' LIMIT 1",
      )
      .get(s.session_id) as { cwd: string | null } | undefined;

    const costRow = db
      .prepare(
        `WITH ${resolvedMetricsCTE("AND session_id = @sid")} SELECT SUM(tokens) as tokens, SUM(${COST_EXPR}) as cost FROM resolved_tokens`,
      )
      .get({ sid: s.session_id }) as
      | { tokens: number; cost: number }
      | undefined;

    const sessionCost = costRow?.cost ?? 0;
    const sessionTokens = costRow?.tokens ?? 0;
    totalCost += sessionCost;
    totalTokens += sessionTokens;

    sessions.push({
      sessionId: s.session_id,
      startedAt: toIso(s.start_ms),
      durationMinutes: Math.round((s.end_ms - s.start_ms) / 60000),
      cwd: cwdRow?.cwd ?? null,
      repositories: repos.map((r) => ({
        name: r.repository,
        gitUserName: r.git_user_name,
        gitUserEmail: r.git_user_email,
      })),
      userPrompts: prompts.map((p) => p.prompt).filter(Boolean) as string[],
      toolsUsed: tools.map((t) => ({ tool: t.tool_name, count: t.count })),
      filesModified: files.map((f) => f.file_path).filter(Boolean) as string[],
      totalCost: sessionCost,
    });
  }

  // Global top tools
  const topTools = db
    .prepare(
      "SELECT tool_name, COUNT(*) as count FROM hook_events WHERE event_type = 'PostToolUse' AND tool_name IS NOT NULL AND timestamp_ms >= ? GROUP BY tool_name ORDER BY count DESC LIMIT 10",
    )
    .all(sinceMs) as { tool_name: string; count: number }[];

  // Global event type counts
  const eventTypeRows = db
    .prepare(
      "SELECT event_type, COUNT(*) as count FROM hook_events WHERE timestamp_ms >= ? GROUP BY event_type",
    )
    .all(sinceMs) as { event_type: string; count: number }[];

  const eventTypeCounts: Record<string, number> = {};
  for (const r of eventTypeRows) {
    eventTypeCounts[r.event_type] = r.count;
  }

  return {
    period: {
      since: toIso(sinceMs),
      until: toIso(now),
    },
    totalSessions: rawSessions.length,
    totalTokens,
    totalCost,
    topTools: topTools.map((t) => ({ tool: t.tool_name, count: t.count })),
    eventTypeCounts,
    engineers: [], // local — single user, no engineer breakdown
    sessions,
    source: "local",
  };
}

// ── Plans (panopticon-specific, not in unified types) ─────────────────────────

export function listPlans(
  opts: { session_id?: string; since?: string; limit?: number } = {},
) {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const sinceMs = parseSince(opts.since);

  const conditions: string[] = [
    "tool_name = 'ExitPlanMode'",
    "event_type = 'PreToolUse'",
  ];
  const params: unknown[] = [];

  if (opts.session_id) {
    conditions.push("session_id = ?");
    params.push(opts.session_id);
  }
  if (sinceMs) {
    conditions.push("timestamp_ms >= ?");
    params.push(sinceMs);
  }

  const sql = `
    SELECT id, session_id, timestamp_ms, plan, allowed_prompts
    FROM hook_events
    WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp_ms DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as {
    id: number;
    session_id: string;
    timestamp_ms: number;
    plan: string | null;
    allowed_prompts: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    timestamp: toIso(r.timestamp_ms),
    plan: r.plan,
    allowed_prompts: r.allowed_prompts ? JSON.parse(r.allowed_prompts) : null,
  }));
}

// ── Get Event (panopticon-specific) ───────────────────────────────────────────

export function getEvent(opts: { source: "hook" | "otel"; id: number }) {
  const db = getDb();

  if (opts.source === "hook") {
    const sql = `
      SELECT 'hook' as source, id, session_id, event_type, timestamp_ms,
             tool_name, cwd, user_prompt, file_path, command, plan,
             tool_result, allowed_prompts, decompress(payload) as payload
      FROM hook_events
      WHERE id = ?
    `;
    return db.prepare(sql).get(opts.id) ?? null;
  }

  const sql = `
    SELECT 'otel' as source, id, session_id, ${otelLogExprs().eventType} as event_type,
           ${otelLogExprs().timestampMs} as timestamp_ms,
           NULL as tool_name, NULL as cwd, attributes, severity_text,
           ${otelLogExprs().eventType} as body
    FROM otel_logs
    WHERE id = ?
  `;
  return db.prepare(sql).get(opts.id) ?? null;
}

// ── Raw Query (panopticon-specific) ──────────────────────────────────────────

export function rawQuery(sql: string) {
  const db = getDb();

  const trimmed = sql.trim().toUpperCase();
  if (
    !trimmed.startsWith("SELECT") &&
    !trimmed.startsWith("WITH") &&
    !trimmed.startsWith("PRAGMA")
  ) {
    throw new Error("Only SELECT, WITH, and PRAGMA statements are allowed");
  }

  if (!trimmed.startsWith("PRAGMA") && !trimmed.includes("LIMIT")) {
    sql = `${sql.trimEnd().replace(/;$/, "")} LIMIT 1000`;
  }

  return db.prepare(sql).all();
}

// ── DB Stats (panopticon-specific) ───────────────────────────────────────────

export function dbStats() {
  const db = getDb();
  const logs = db.prepare("SELECT COUNT(*) as count FROM otel_logs").get() as {
    count: number;
  };
  const metrics = db
    .prepare("SELECT COUNT(*) as count FROM otel_metrics")
    .get() as { count: number };
  const hooks = db
    .prepare("SELECT COUNT(*) as count FROM hook_events")
    .get() as { count: number };
  const spans = db
    .prepare("SELECT COUNT(*) as count FROM otel_spans")
    .get() as { count: number };
  const sessions = db
    .prepare("SELECT COUNT(*) as count FROM sessions")
    .get() as { count: number };
  const scannerTurns = db
    .prepare("SELECT COUNT(*) as count FROM scanner_turns")
    .get() as { count: number };
  const scannerEvents = db
    .prepare("SELECT COUNT(*) as count FROM scanner_events")
    .get() as { count: number };

  return {
    otel_logs: logs.count,
    otel_metrics: metrics.count,
    otel_spans: spans.count,
    hook_events: hooks.count,
    sessions: sessions.count,
    scanner_turns: scannerTurns.count,
    scanner_events: scannerEvents.count,
  };
}
