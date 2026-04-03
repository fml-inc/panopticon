import { allTargets } from "../targets/index.js";
import type { MetricSpec } from "../targets/types.js";
import type {
  ActivitySessionDetail,
  ActivitySummaryResult,
  ChildSession,
  SearchMatch,
  SearchResult,
  Session,
  SessionListResult,
  SessionTimelineResult,
  SpendingGroup,
  SpendingResult,
  TimelineMessage,
  TimelineToolCall,
} from "../types.js";
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
function _resolvedMetricsCTE(extraWhere = ""): string {
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

function _parseJson(raw: string | null): unknown {
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

interface RawRepoRow {
  session_id: string;
  repository: string;
  git_user_name: string | null;
  git_user_email: string | null;
}

/** Cost SQL fragment for a session row with model + token columns. */
const SESSION_COST_SQL = `
  COALESCE((
    SELECT (s.total_input_tokens + s.total_cache_read_tokens + s.total_cache_creation_tokens) * COALESCE(mp.input_per_m, 0) / 1000000.0
         + s.total_output_tokens * COALESCE(mp.output_per_m, 0) / 1000000.0
         + s.total_cache_read_tokens * COALESCE(mp.cache_read_per_m, 0) / 1000000.0
         + s.total_cache_creation_tokens * COALESCE(mp.cache_write_per_m, 0) / 1000000.0
    FROM model_pricing mp
    WHERE s.model LIKE mp.model_id || '%'
    ORDER BY LENGTH(mp.model_id) DESC, mp.updated_ms DESC
    LIMIT 1
  ), 0)`;

export function listSessions(
  opts: { limit?: number; since?: string } = {},
): SessionListResult {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const sinceMs = parseSince(opts.since);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (sinceMs) {
    conditions.push("s.started_at_ms >= ?");
    params.push(sinceMs);
  }
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT s.session_id, s.target, s.model, s.project,
           s.started_at_ms, s.ended_at_ms, s.first_prompt,
           COALESCE(s.turn_count, 0) as turn_count,
           COALESCE(s.message_count, 0) as message_count,
           COALESCE(s.total_input_tokens, 0) as total_input_tokens,
           COALESCE(s.total_output_tokens, 0) as total_output_tokens,
           s.parent_session_id, s.relationship_type,
           ${SESSION_COST_SQL} as total_cost
    FROM sessions s
    ${where}
    ORDER BY s.started_at_ms DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    session_id: string;
    target: string | null;
    model: string | null;
    project: string | null;
    started_at_ms: number | null;
    ended_at_ms: number | null;
    first_prompt: string | null;
    turn_count: number;
    message_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    parent_session_id: string | null;
    relationship_type: string | null;
    total_cost: number;
  }>;

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
    target: row.target,
    model: row.model,
    project: row.project,
    startedAt: row.started_at_ms ? toIso(row.started_at_ms) : null,
    endedAt: row.ended_at_ms ? toIso(row.ended_at_ms) : null,
    firstPrompt: row.first_prompt,
    turnCount: row.turn_count,
    messageCount: row.message_count,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    totalCost: row.total_cost,
    repositories: (reposBySession.get(row.session_id) ?? []).map((r) => ({
      name: r.repository,
      gitUserName: r.git_user_name,
      gitUserEmail: r.git_user_email,
    })),
    parentSessionId: row.parent_session_id,
    relationshipType: row.relationship_type,
  }));

  return {
    sessions,
    totalCount: sessions.length,
    source: "local",
  };
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export function sessionTimeline(opts: {
  sessionId: string;
  limit?: number;
  offset?: number;
  fullPayloads?: boolean;
}): SessionTimelineResult {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const truncate = !opts.fullPayloads;

  // Session metadata
  const sessionRow = db
    .prepare(
      "SELECT session_id, target, model, project, parent_session_id, relationship_type FROM sessions WHERE session_id = ?",
    )
    .get(opts.sessionId) as
    | {
        session_id: string;
        target: string | null;
        model: string | null;
        project: string | null;
        parent_session_id: string | null;
        relationship_type: string | null;
      }
    | undefined;

  if (!sessionRow) {
    return {
      session: null,
      messages: [],
      totalMessages: 0,
      hasMore: false,
      source: "local",
    };
  }

  const repoRows = db
    .prepare(
      "SELECT repository, git_user_name, git_user_email FROM session_repositories WHERE session_id = ?",
    )
    .all(opts.sessionId) as RawRepoRow[];

  // Child sessions (forks + subagents)
  const childRows = db
    .prepare(
      "SELECT session_id, relationship_type, model, COALESCE(turn_count, 0) as turn_count, first_prompt, started_at_ms FROM sessions WHERE parent_session_id = ?",
    )
    .all(opts.sessionId) as Array<{
    session_id: string;
    relationship_type: string;
    model: string | null;
    turn_count: number;
    first_prompt: string | null;
    started_at_ms: number | null;
  }>;

  const childSessions: ChildSession[] = childRows.map((r) => ({
    sessionId: r.session_id,
    relationshipType: r.relationship_type,
    model: r.model,
    turnCount: r.turn_count,
    firstPrompt: r.first_prompt,
    startedAtMs: r.started_at_ms,
  }));

  // Message count
  const totalMessages = (
    db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?")
      .get(opts.sessionId) as { c: number }
  ).c;

  // Messages
  const contentCol = truncate ? "SUBSTR(m.content, 1, 500)" : "m.content";
  const msgRows = db
    .prepare(
      `SELECT m.id, m.ordinal, m.role, ${contentCol} as content, m.timestamp_ms,
              m.model, m.is_system, m.has_thinking, m.has_tool_use,
              m.content_length, m.uuid, m.parent_uuid,
              m.token_usage, m.context_tokens, m.output_tokens
       FROM messages m
       WHERE m.session_id = ?
       ORDER BY m.ordinal ASC
       LIMIT ? OFFSET ?`,
    )
    .all(opts.sessionId, limit, offset) as Array<{
    id: number;
    ordinal: number;
    role: string;
    content: string;
    timestamp_ms: number | null;
    model: string | null;
    is_system: number;
    has_thinking: number;
    has_tool_use: number;
    content_length: number;
    uuid: string | null;
    parent_uuid: string | null;
    token_usage: string | null;
    context_tokens: number;
    output_tokens: number;
  }>;

  // Batch-load tool calls
  const msgIds = msgRows.map((m) => m.id);
  const tcRows =
    msgIds.length > 0
      ? (db
          .prepare(
            `SELECT tc.message_id, tc.tool_name, tc.category, tc.tool_use_id,
                    tc.input_json, tc.skill_name, tc.result_content_length,
                    tc.duration_ms, tc.subagent_session_id
             FROM tool_calls tc
             WHERE tc.message_id IN (${msgIds.map(() => "?").join(",")})
             ORDER BY tc.id ASC`,
          )
          .all(...msgIds) as Array<{
          message_id: number;
          tool_name: string;
          category: string;
          tool_use_id: string | null;
          input_json: string | null;
          skill_name: string | null;
          result_content_length: number | null;
          duration_ms: number | null;
          subagent_session_id: string | null;
        }>)
      : [];

  // Subagent metadata lookup
  const subagentIds = [
    ...new Set(
      tcRows.map((tc) => tc.subagent_session_id).filter(Boolean) as string[],
    ),
  ];
  const subagentMap = new Map<
    string,
    { model: string | null; turn_count: number; first_prompt: string | null }
  >();
  if (subagentIds.length > 0) {
    const subRows = db
      .prepare(
        `SELECT session_id, model, COALESCE(turn_count, 0) as turn_count, first_prompt
         FROM sessions WHERE session_id IN (${subagentIds.map(() => "?").join(",")})`,
      )
      .all(...subagentIds) as Array<{
      session_id: string;
      model: string | null;
      turn_count: number;
      first_prompt: string | null;
    }>;
    for (const r of subRows) {
      subagentMap.set(r.session_id, {
        model: r.model,
        turn_count: r.turn_count,
        first_prompt: r.first_prompt,
      });
    }
  }

  // Group tool calls by message_id
  const tcByMessage = new Map<number, typeof tcRows>();
  for (const tc of tcRows) {
    const list = tcByMessage.get(tc.message_id) ?? [];
    list.push(tc);
    tcByMessage.set(tc.message_id, list);
  }

  const messages: TimelineMessage[] = msgRows.map((m) => {
    const tcs = tcByMessage.get(m.id) ?? [];
    return {
      id: m.id,
      ordinal: m.ordinal,
      role: m.role,
      content: m.content,
      timestampMs: m.timestamp_ms,
      model: m.model,
      isSystem: m.is_system === 1,
      hasThinking: m.has_thinking === 1,
      hasToolUse: m.has_tool_use === 1,
      contentLength: m.content_length,
      uuid: m.uuid,
      parentUuid: m.parent_uuid,
      tokenUsage: m.token_usage,
      contextTokens: m.context_tokens,
      outputTokens: m.output_tokens,
      toolCalls: tcs.map((tc): TimelineToolCall => {
        const sub = tc.subagent_session_id
          ? subagentMap.get(tc.subagent_session_id)
          : undefined;
        return {
          toolName: tc.tool_name,
          category: tc.category,
          toolUseId: tc.tool_use_id,
          inputJson: truncate
            ? (tc.input_json?.slice(0, 500) ?? null)
            : tc.input_json,
          skillName: tc.skill_name,
          resultContentLength: tc.result_content_length,
          durationMs: tc.duration_ms,
          subagentSessionId: tc.subagent_session_id,
          subagent: sub
            ? {
                sessionId: tc.subagent_session_id!,
                model: sub.model,
                turnCount: sub.turn_count,
                firstPrompt: sub.first_prompt,
              }
            : null,
        };
      }),
    };
  });

  return {
    session: {
      sessionId: opts.sessionId,
      target: sessionRow.target,
      model: sessionRow.model,
      project: sessionRow.project,
      parentSessionId: sessionRow.parent_session_id,
      relationshipType: sessionRow.relationship_type,
      repositories: repoRows.map((r) => ({
        name: r.repository,
        gitUserName: r.git_user_name,
        gitUserEmail: r.git_user_email,
      })),
      childSessions,
    },
    messages,
    totalMessages,
    hasMore: offset + limit < totalMessages,
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

export function costBreakdown(
  opts: { since?: string; groupBy?: "session" | "model" | "day" } = {},
): SpendingResult {
  const db = getDb();
  const sinceMs = parseSince(opts.since);
  const groupBy = opts.groupBy ?? "session";

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (sinceMs) {
    conditions.push("s.started_at_ms >= ?");
    params.push(sinceMs);
  }
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let groupExpr: string;
  let selectExpr: string;
  if (groupBy === "day") {
    groupExpr = "date(s.started_at_ms / 1000, 'unixepoch')";
    selectExpr = `${groupExpr} as group_key`;
  } else if (groupBy === "model") {
    groupExpr = "COALESCE(s.model, 'unknown')";
    selectExpr = `${groupExpr} as group_key`;
  } else {
    groupExpr = "s.session_id";
    selectExpr = "s.session_id as group_key";
  }

  const sql = `
    SELECT ${selectExpr},
           SUM(COALESCE(s.total_input_tokens, 0) + COALESCE(s.total_cache_read_tokens, 0) + COALESCE(s.total_cache_creation_tokens, 0)) as input_tokens,
           SUM(COALESCE(s.total_output_tokens, 0)) as output_tokens,
           SUM(COALESCE(s.total_input_tokens, 0) + COALESCE(s.total_output_tokens, 0) + COALESCE(s.total_cache_read_tokens, 0) + COALESCE(s.total_cache_creation_tokens, 0)) as total_tokens,
           SUM(${SESSION_COST_SQL}) as total_cost,
           COUNT(DISTINCT s.session_id) as session_count
    FROM sessions s
    ${where}
    GROUP BY ${groupExpr}
    ORDER BY ${groupBy === "day" ? "group_key DESC" : "total_tokens DESC"}
  `;

  const rows = db.prepare(sql).all(...params) as Array<{
    group_key: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    total_cost: number;
    session_count: number;
  }>;

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

export function search(opts: {
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

  // Messages FTS search
  const msgContentCol = truncate ? "SUBSTR(m.content, 1, 500)" : "m.content";
  const msgConditions: string[] = [
    "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)",
  ];
  const msgParams: unknown[] = [opts.query];
  if (sinceMs) {
    msgConditions.push("m.timestamp_ms >= ?");
    msgParams.push(sinceMs);
  }

  const msgSql = `
    SELECT 'message' as source, m.id, m.session_id,
           m.role as event_type, m.timestamp_ms,
           NULL as tool_name, NULL as cwd, ${msgContentCol} as payload
    FROM messages m
    WHERE ${msgConditions.join(" AND ")}
  `;

  const countSql = `SELECT COUNT(*) as total FROM (${hookSql} UNION ALL ${otelSql} UNION ALL ${msgSql})`;
  const total = (
    db.prepare(countSql).get(...hookParams, ...otelParams, ...msgParams) as {
      total: number;
    }
  ).total;

  const sql = `
    SELECT * FROM (${hookSql} UNION ALL ${otelSql} UNION ALL ${msgSql})
    ORDER BY timestamp_ms DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db
    .prepare(sql)
    .all(
      ...hookParams,
      ...otelParams,
      ...msgParams,
      limit,
      offset,
    ) as RawSearchRow[];

  const results: SearchMatch[] = rows.map((row) => {
    const snippet = row.payload ?? row.event_type ?? "";
    const matchType =
      row.source === "message"
        ? "message"
        : row.event_type === "UserPromptSubmit"
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

  const rawSessions = db
    .prepare(
      `SELECT s.session_id, s.model, s.project,
              s.started_at_ms, s.ended_at_ms,
              COALESCE(s.total_input_tokens, 0) + COALESCE(s.total_output_tokens, 0) +
              COALESCE(s.total_cache_read_tokens, 0) + COALESCE(s.total_cache_creation_tokens, 0) as total_tokens,
              ${SESSION_COST_SQL} as total_cost
       FROM sessions s
       WHERE s.started_at_ms >= ?
       ORDER BY s.started_at_ms ASC`,
    )
    .all(sinceMs) as Array<{
    session_id: string;
    model: string | null;
    project: string | null;
    started_at_ms: number | null;
    ended_at_ms: number | null;
    total_tokens: number;
    total_cost: number;
  }>;

  let totalCost = 0;
  let totalTokens = 0;
  const sessions: ActivitySessionDetail[] = [];

  for (const s of rawSessions) {
    totalCost += s.total_cost;
    totalTokens += s.total_tokens;

    // User prompts from messages
    const prompts = db
      .prepare(
        "SELECT SUBSTR(content, 1, 100) as prompt FROM messages WHERE session_id = ? AND role = 'user' AND is_system = 0 ORDER BY ordinal ASC LIMIT 10",
      )
      .all(s.session_id) as { prompt: string }[];

    // Tool usage from tool_calls
    const tools = db
      .prepare(
        "SELECT tool_name, COUNT(*) as count FROM tool_calls WHERE session_id = ? GROUP BY tool_name ORDER BY count DESC",
      )
      .all(s.session_id) as { tool_name: string; count: number }[];

    // Files from Write/Edit tool_calls input_json
    const fileRows = db
      .prepare(
        "SELECT DISTINCT json_extract(input_json, '$.file_path') as file_path FROM tool_calls WHERE session_id = ? AND tool_name IN ('Write', 'Edit') AND input_json IS NOT NULL",
      )
      .all(s.session_id) as { file_path: string | null }[];

    const repos = db
      .prepare(
        "SELECT repository, git_user_name, git_user_email FROM session_repositories WHERE session_id = ?",
      )
      .all(s.session_id) as RawRepoRow[];

    const durationMs =
      s.started_at_ms && s.ended_at_ms ? s.ended_at_ms - s.started_at_ms : 0;

    sessions.push({
      sessionId: s.session_id,
      startedAt: s.started_at_ms ? toIso(s.started_at_ms) : null,
      durationMinutes: Math.round(durationMs / 60000),
      model: s.model,
      project: s.project,
      repositories: repos.map((r) => ({
        name: r.repository,
        gitUserName: r.git_user_name,
        gitUserEmail: r.git_user_email,
      })),
      userPrompts: prompts.map((p) => p.prompt),
      toolsUsed: tools.map((t) => ({ tool: t.tool_name, count: t.count })),
      filesModified: fileRows
        .map((f) => f.file_path)
        .filter(Boolean) as string[],
      totalCost: s.total_cost,
    });
  }

  // Global top tools from tool_calls
  const topTools = db
    .prepare(
      `SELECT tc.tool_name, COUNT(*) as count
       FROM tool_calls tc
       INNER JOIN sessions s ON tc.session_id = s.session_id
       WHERE s.started_at_ms >= ?
       GROUP BY tc.tool_name ORDER BY count DESC LIMIT 10`,
    )
    .all(sinceMs) as { tool_name: string; count: number }[];

  return {
    period: {
      since: toIso(sinceMs),
      until: toIso(now),
    },
    totalSessions: rawSessions.length,
    totalTokens,
    totalCost,
    topTools: topTools.map((t) => ({ tool: t.tool_name, count: t.count })),
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

export function print(opts: {
  source: "hook" | "otel" | "message";
  id: number;
}) {
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

  if (opts.source === "message") {
    const msg = db
      .prepare(
        `SELECT m.id, m.session_id, m.ordinal, m.role, m.content, m.timestamp_ms,
              m.has_thinking, m.has_tool_use, m.content_length, m.is_system,
              m.model, m.token_usage, m.context_tokens, m.output_tokens,
              m.uuid, m.parent_uuid
       FROM messages m WHERE m.id = ?`,
      )
      .get(opts.id) as Record<string, unknown> | undefined;
    if (!msg) return null;
    const toolCalls = db
      .prepare(
        `SELECT tool_name, category, tool_use_id, input_json, skill_name,
              result_content_length, duration_ms, subagent_session_id
       FROM tool_calls WHERE message_id = ?`,
      )
      .all(opts.id);
    return { source: "message", ...msg, tool_calls: toolCalls };
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

  const messages = db
    .prepare("SELECT COUNT(*) as count FROM messages")
    .get() as { count: number };
  const toolCalls = db
    .prepare("SELECT COUNT(*) as count FROM tool_calls")
    .get() as { count: number };

  return {
    sessions: sessions.count,
    messages: messages.count,
    tool_calls: toolCalls.count,
    scanner_turns: scannerTurns.count,
    scanner_events: scannerEvents.count,
    hook_events: hooks.count,
    otel_logs: logs.count,
    otel_metrics: metrics.count,
    otel_spans: spans.count,
  };
}
