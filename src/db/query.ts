import { buildCostSQL } from "./pricing.js";
import { getDb } from "./schema.js";

// Unified token type extraction: works for Claude, Gemini CLI, and gen_ai metric names
const TOKEN_TYPE_EXPR = `COALESCE(json_extract(attributes, '$.type'), json_extract(attributes, '$."gen_ai.token.type"'))`;
const MODEL_EXPR = `COALESCE(json_extract(attributes, '$.model'), json_extract(attributes, '$."gen_ai.response.model"'))`;

/**
 * Resolved metrics CTE that correctly deduplicates Gemini (cumulative MAX) vs Claude (per-request SUM).
 * Gemini CLI sends cumulative counters — use MAX per (session, model, token_type).
 * Claude Code sends per-request values — use SUM per (session, model, token_type).
 */
function resolvedMetricsCTE(extraWhere = ""): string {
  return `
    resolved_tokens AS (
      -- Gemini: cumulative counters → MAX per (session, model, token_type)
      SELECT session_id,
             ${MODEL_EXPR} as model,
             ${TOKEN_TYPE_EXPR} as token_type,
             MAX(value) as tokens
      FROM otel_metrics
      WHERE name IN ('gemini_cli.token.usage', 'gen_ai.client.token.usage')
      ${extraWhere}
      GROUP BY session_id, model, token_type

      UNION ALL

      -- Claude: per-request values → SUM
      SELECT session_id,
             ${MODEL_EXPR} as model,
             ${TOKEN_TYPE_EXPR} as token_type,
             SUM(value) as tokens
      FROM otel_metrics
      WHERE name = 'claude_code.token.usage'
      ${extraWhere}
      GROUP BY session_id, model, token_type
    )`;
}

/** Cost SQL expression — uses OpenRouter pricing cache, falls back to hardcoded defaults. */
function costExpr(): string {
  return buildCostSQL();
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

export function listSessions(opts: { limit?: number; since?: string } = {}) {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const sinceMs = parseSince(opts.since);

  // Combine sessions from both hook_events and otel_logs
  const sql = `
    WITH all_sessions AS (
      SELECT session_id,
             MIN(timestamp_ms) as start_ms,
             MAX(timestamp_ms) as end_ms,
             COUNT(*) as event_count,
             COUNT(DISTINCT tool_name) as tool_count
      FROM hook_events
      ${sinceMs ? "WHERE timestamp_ms >= ?" : ""}
      GROUP BY session_id
    ),
    ${resolvedMetricsCTE()},
    otel_costs AS (
      SELECT session_id,
             SUM(tokens) as total_tokens,
             SUM(${costExpr()}) as total_cost
      FROM resolved_tokens
      GROUP BY session_id
    )
    SELECT s.session_id,
           s.start_ms,
           s.end_ms,
           s.event_count,
           s.tool_count,
           COALESCE(c.total_tokens, 0) as total_tokens,
           COALESCE(c.total_cost, 0) as total_cost,
           GROUP_CONCAT(DISTINCT sr.repository) as repositories
    FROM all_sessions s
    LEFT JOIN otel_costs c ON s.session_id = c.session_id
    LEFT JOIN session_repositories sr ON s.session_id = sr.session_id
    GROUP BY s.session_id
    ORDER BY s.start_ms DESC
    LIMIT ?
  `;

  const params: unknown[] = [];
  if (sinceMs) params.push(sinceMs);
  params.push(limit);

  return db.prepare(sql).all(...params);
}

export function sessionTimeline(opts: {
  session_id: string;
  event_types?: string[];
  limit?: number;
  offset?: number;
  full_payloads?: boolean;
}) {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const truncate = !opts.full_payloads;

  const payloadCol = truncate
    ? "SUBSTR(decompress(payload), 1, 500)"
    : "decompress(payload)";
  const attrsCol = truncate ? "SUBSTR(attributes, 1, 500)" : "attributes";

  // Hook events
  let hookSql = `
    SELECT 'hook' as source, id, session_id, event_type, timestamp_ms,
           tool_name, cwd, ${payloadCol} as payload, NULL as body, NULL as attributes, NULL as severity_text
    FROM hook_events
    WHERE session_id = ?
  `;
  const hookParams: unknown[] = [opts.session_id];

  if (opts.event_types?.length) {
    hookSql += ` AND event_type IN (${opts.event_types.map(() => "?").join(",")})`;
    hookParams.push(...opts.event_types);
  }

  // OTel log events
  let otelSql = `
    SELECT 'otel' as source, id, session_id, body as event_type,
           CAST(timestamp_ns / 1000000 AS INTEGER) as timestamp_ms,
           NULL as tool_name, NULL as cwd, NULL as payload, body, ${attrsCol} as attributes, severity_text
    FROM otel_logs
    WHERE session_id = ?
  `;
  const otelParams: unknown[] = [opts.session_id];

  if (opts.event_types?.length) {
    otelSql += ` AND body IN (${opts.event_types.map(() => "?").join(",")})`;
    otelParams.push(...opts.event_types);
  }

  // Count query (same WHERE, no LIMIT)
  const countSql = `
    SELECT COUNT(*) as total FROM (${hookSql} UNION ALL ${otelSql})
  `;
  const total = (
    db.prepare(countSql).get(...hookParams, ...otelParams) as { total: number }
  ).total;

  const sql = `
    SELECT * FROM (${hookSql} UNION ALL ${otelSql})
    ORDER BY timestamp_ms ASC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...hookParams, ...otelParams, limit, offset);
  return { total, rows };
}

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

export function costBreakdown(
  opts: { since?: string; group_by?: "session" | "model" | "day" } = {},
) {
  const db = getDb();
  const sinceMs = parseSince(opts.since);
  const groupBy = opts.group_by ?? "session";

  const extraWhere = sinceMs
    ? `AND CAST(timestamp_ns / 1000000 AS INTEGER) >= ${Number(sinceMs)}`
    : "";

  let groupExpr: string;
  let selectExpr: string;
  switch (groupBy) {
    case "session":
      groupExpr = "session_id";
      selectExpr = "session_id as group_key";
      break;
    case "model":
      groupExpr = "model";
      selectExpr = "model as group_key";
      break;
    case "day":
      // Fall back to raw metrics for day grouping (needs timestamp)
      groupExpr = "session_id";
      selectExpr = "session_id as group_key";
      break;
  }

  const sql = `
    WITH ${resolvedMetricsCTE(extraWhere)}
    SELECT ${selectExpr},
           SUM(CASE WHEN token_type IN ('input', 'cacheRead', 'cacheWrite') THEN tokens ELSE 0 END) as input_tokens,
           SUM(CASE WHEN token_type = 'output' THEN tokens ELSE 0 END) as output_tokens,
           SUM(tokens) as total_tokens,
           SUM(${costExpr()}) as total_cost
    FROM resolved_tokens
    GROUP BY ${groupExpr}
    ORDER BY total_tokens DESC
  `;

  return db.prepare(sql).all();
}

export function searchEvents(opts: {
  query: string;
  event_types?: string[];
  since?: string;
  limit?: number;
  offset?: number;
  full_payloads?: boolean;
}) {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const sinceMs = parseSince(opts.since);
  const pattern = `%${opts.query}%`;
  const truncate = !opts.full_payloads;

  const hookPayloadCol = truncate
    ? "SUBSTR(decompress(h.payload), 1, 500)"
    : "decompress(h.payload)";
  const attrsCol = truncate ? "SUBSTR(attributes, 1, 500)" : "attributes";

  // Search hook events via FTS5 + fallback on tool_name/event_type LIKE
  const hookConditions: string[] = [];
  const hookParams: unknown[] = [];

  // FTS5 match on payload, plus LIKE fallback for tool_name/event_type
  hookConditions.push(
    "(h.id IN (SELECT rowid FROM hook_events_fts WHERE hook_events_fts MATCH ?) OR h.tool_name LIKE ? OR h.event_type LIKE ?)",
  );
  hookParams.push(opts.query, pattern, pattern);

  if (opts.event_types?.length) {
    hookConditions.push(
      `h.event_type IN (${opts.event_types.map(() => "?").join(",")})`,
    );
    hookParams.push(...opts.event_types);
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

  // Search otel logs
  const otelConditions: string[] = ["(body LIKE ? OR attributes LIKE ?)"];
  const otelParams: unknown[] = [pattern, pattern];

  if (sinceMs) {
    otelConditions.push("CAST(timestamp_ns / 1000000 AS INTEGER) >= ?");
    otelParams.push(sinceMs);
  }

  const otelSql = `
    SELECT 'otel' as source, id, session_id, body as event_type,
           CAST(timestamp_ns / 1000000 AS INTEGER) as timestamp_ms,
           NULL as tool_name, NULL as cwd, ${attrsCol} as payload
    FROM otel_logs
    WHERE ${otelConditions.join(" AND ")}
  `;

  // Count query
  const countSql = `
    SELECT COUNT(*) as total FROM (${hookSql} UNION ALL ${otelSql})
  `;
  const total = (
    db.prepare(countSql).get(...hookParams, ...otelParams) as { total: number }
  ).total;

  const sql = `
    SELECT * FROM (${hookSql} UNION ALL ${otelSql})
    ORDER BY timestamp_ms DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...hookParams, ...otelParams, limit, offset);
  return { total, rows };
}

export function getEvent(opts: { source: "hook" | "otel"; id: number }) {
  const db = getDb();

  if (opts.source === "hook") {
    const sql = `
      SELECT 'hook' as source, id, session_id, event_type, timestamp_ms,
             tool_name, cwd, user_prompt, file_path, command, plan,
             decompress(payload) as payload
      FROM hook_events
      WHERE id = ?
    `;
    return db.prepare(sql).get(opts.id) ?? null;
  }

  const sql = `
    SELECT 'otel' as source, id, session_id, body as event_type,
           CAST(timestamp_ns / 1000000 AS INTEGER) as timestamp_ms,
           NULL as tool_name, NULL as cwd, attributes, severity_text, body
    FROM otel_logs
    WHERE id = ?
  `;
  return db.prepare(sql).get(opts.id) ?? null;
}

export function activitySummary(opts: { since?: string } = {}) {
  const db = getDb();
  const sinceMs = parseSince(opts.since ?? "24h") ?? Date.now() - 86400000;
  const now = Date.now();

  // 1. Sessions with basic stats
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
  const sessions = db.prepare(sessionsSql).all(sinceMs) as {
    session_id: string;
    start_ms: number;
    end_ms: number;
    event_count: number;
  }[];

  const result: {
    period: { since: string; until: string };
    sessions: unknown[];
    totals: {
      session_count: number;
      total_cost: number;
      total_tokens: number;
      top_tools: { tool: string; count: number }[];
    };
  } = {
    period: {
      since: new Date(sinceMs).toISOString(),
      until: new Date(now).toISOString(),
    },
    sessions: [],
    totals: {
      session_count: sessions.length,
      total_cost: 0,
      total_tokens: 0,
      top_tools: [],
    },
  };

  for (const s of sessions) {
    // User prompts (first 100 chars of each)
    const prompts = db
      .prepare(`
      SELECT SUBSTR(user_prompt, 1, 100) as prompt
      FROM hook_events
      WHERE session_id = ? AND event_type = 'UserPromptSubmit' AND timestamp_ms >= ?
      ORDER BY timestamp_ms ASC
    `)
      .all(s.session_id, sinceMs) as { prompt: string | null }[];

    // Tool usage
    const tools = db
      .prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM hook_events
      WHERE session_id = ? AND event_type = 'PostToolUse' AND tool_name IS NOT NULL AND timestamp_ms >= ?
      GROUP BY tool_name
      ORDER BY count DESC
    `)
      .all(s.session_id, sinceMs) as { tool_name: string; count: number }[];

    // Files modified (from Write/Edit tools)
    const files = db
      .prepare(`
      SELECT DISTINCT file_path
      FROM hook_events
      WHERE session_id = ? AND tool_name IN ('Write', 'Edit') AND event_type = 'PostToolUse'
        AND file_path IS NOT NULL AND timestamp_ms >= ?
    `)
      .all(s.session_id, sinceMs) as { file_path: string | null }[];

    // Plans created in this session
    const plans = db
      .prepare(`
      SELECT plan
      FROM hook_events
      WHERE session_id = ? AND tool_name = 'ExitPlanMode' AND event_type = 'PreToolUse'
        AND plan IS NOT NULL AND timestamp_ms >= ?
      ORDER BY timestamp_ms ASC
    `)
      .all(s.session_id, sinceMs) as { plan: string | null }[];

    // Repositories for this session
    const repos = db
      .prepare(
        "SELECT repository FROM session_repositories WHERE session_id = ?",
      )
      .all(s.session_id) as { repository: string }[];

    // Working directory
    const cwdRow = db
      .prepare(`
      SELECT cwd FROM hook_events
      WHERE session_id = ? AND event_type = 'SessionStart'
      LIMIT 1
    `)
      .get(s.session_id) as { cwd: string | null } | undefined;

    // Cost from otel_metrics (handles Gemini cumulative MAX vs Claude per-request SUM)
    const costRow = db
      .prepare(`
      WITH ${resolvedMetricsCTE(`AND session_id = ?`)}
      SELECT SUM(tokens) as tokens,
             SUM(${costExpr()}) as cost
      FROM resolved_tokens
    `)
      .get(s.session_id) as { tokens: number; cost: number } | undefined;

    const sessionCost = costRow?.cost ?? 0;
    const sessionTokens = costRow?.tokens ?? 0;
    result.totals.total_cost += sessionCost;
    result.totals.total_tokens += sessionTokens;

    result.sessions.push({
      session_id: s.session_id,
      start: new Date(s.start_ms).toISOString(),
      duration_minutes: Math.round((s.end_ms - s.start_ms) / 60000),
      working_directory: cwdRow?.cwd ?? null,
      repositories: repos.map((r) => r.repository),
      user_prompts: prompts.map((p) => p.prompt).filter(Boolean),
      tools_used: tools.map((t) => ({ tool: t.tool_name, count: t.count })),
      plans: plans.map((p) => p.plan).filter(Boolean),
      files_modified: files.map((f) => f.file_path).filter(Boolean),
      total_cost: sessionCost,
    });
  }

  // Global top tools
  const topTools = db
    .prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM hook_events
    WHERE event_type = 'PostToolUse' AND tool_name IS NOT NULL AND timestamp_ms >= ?
    GROUP BY tool_name
    ORDER BY count DESC
    LIMIT 10
  `)
    .all(sinceMs) as { tool_name: string; count: number }[];
  result.totals.top_tools = topTools.map((t) => ({
    tool: t.tool_name,
    count: t.count,
  }));

  return result;
}

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
    timestamp: new Date(r.timestamp_ms).toISOString(),
    plan: r.plan,
    allowed_prompts: r.allowed_prompts ? JSON.parse(r.allowed_prompts) : null,
  }));
}

export function rawQuery(sql: string) {
  const db = getDb();

  // Only allow SELECT statements
  const trimmed = sql.trim().toUpperCase();
  if (
    !trimmed.startsWith("SELECT") &&
    !trimmed.startsWith("WITH") &&
    !trimmed.startsWith("PRAGMA")
  ) {
    throw new Error("Only SELECT, WITH, and PRAGMA statements are allowed");
  }

  // Safety net: append LIMIT if not already present (skip for PRAGMA)
  if (!trimmed.startsWith("PRAGMA") && !trimmed.includes("LIMIT")) {
    sql = `${sql.trimEnd().replace(/;$/, "")} LIMIT 1000`;
  }

  return db.prepare(sql).all();
}

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

  return {
    otel_logs: logs.count,
    otel_metrics: metrics.count,
    hook_events: hooks.count,
  };
}
