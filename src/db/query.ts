import { getDb } from "./schema.js";

function parseSince(since?: string): number | null {
  if (!since) return null;
  const match = since.match(/^(\d+)(h|d|m)$/);
  if (match) {
    const [, num, unit] = match;
    const ms = unit === "h" ? 3600000 : unit === "d" ? 86400000 : 60000;
    return Date.now() - parseInt(num) * ms;
  }
  const date = new Date(since);
  return isNaN(date.getTime()) ? null : date.getTime();
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
    otel_costs AS (
      SELECT session_id,
             SUM(CASE WHEN name LIKE '%token%' THEN value ELSE 0 END) as total_tokens,
             SUM(CASE WHEN name LIKE '%cost%' THEN value ELSE 0 END) as total_cost
      FROM otel_metrics
      WHERE session_id IS NOT NULL
      GROUP BY session_id
    )
    SELECT s.session_id,
           s.start_ms,
           s.end_ms,
           s.event_count,
           s.tool_count,
           COALESCE(c.total_tokens, 0) as total_tokens,
           COALESCE(c.total_cost, 0) as total_cost
    FROM all_sessions s
    LEFT JOIN otel_costs c ON s.session_id = c.session_id
    ORDER BY s.start_ms DESC
    LIMIT ?
  `;

  const params: unknown[] = [];
  if (sinceMs) params.push(sinceMs);
  params.push(limit);

  return db.prepare(sql).all(...params);
}

export function sessionTimeline(opts: { session_id: string; event_types?: string[] }) {
  const db = getDb();

  // Hook events
  let hookSql = `
    SELECT 'hook' as source, id, session_id, event_type, timestamp_ms,
           tool_name, payload, NULL as body, NULL as attributes, NULL as severity_text
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
           NULL as tool_name, NULL as payload, body, attributes, severity_text
    FROM otel_logs
    WHERE session_id = ?
  `;
  const otelParams: unknown[] = [opts.session_id];

  const sql = `
    SELECT * FROM (${hookSql} UNION ALL ${otelSql})
    ORDER BY timestamp_ms ASC
  `;

  return db.prepare(sql).all(...hookParams, ...otelParams);
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

export function costBreakdown(opts: { since?: string; group_by?: "session" | "model" | "day" } = {}) {
  const db = getDb();
  const sinceMs = parseSince(opts.since);
  const groupBy = opts.group_by ?? "session";

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (sinceMs) {
    conditions.push("CAST(timestamp_ns / 1000000 AS INTEGER) >= ?");
    params.push(sinceMs);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  let groupExpr: string;
  let selectExpr: string;
  switch (groupBy) {
    case "session":
      groupExpr = "session_id";
      selectExpr = "session_id as group_key";
      break;
    case "model":
      groupExpr = "json_extract(attributes, '$.model')";
      selectExpr = `json_extract(attributes, '$.model') as group_key`;
      break;
    case "day":
      groupExpr = "date(timestamp_ns / 1000000000, 'unixepoch')";
      selectExpr = `date(timestamp_ns / 1000000000, 'unixepoch') as group_key`;
      break;
  }

  const sql = `
    SELECT ${selectExpr},
           SUM(CASE WHEN name LIKE '%input%token%' THEN value ELSE 0 END) as input_tokens,
           SUM(CASE WHEN name LIKE '%output%token%' THEN value ELSE 0 END) as output_tokens,
           SUM(CASE WHEN name LIKE '%token%' THEN value ELSE 0 END) as total_tokens,
           SUM(CASE WHEN name LIKE '%cost%' THEN value ELSE 0 END) as total_cost
    FROM otel_metrics
    ${where}
    GROUP BY ${groupExpr}
    ORDER BY total_tokens DESC
  `;

  return db.prepare(sql).all(...params);
}

export function searchEvents(opts: {
  query: string;
  event_types?: string[];
  since?: string;
  limit?: number;
}) {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const sinceMs = parseSince(opts.since);
  const pattern = `%${opts.query}%`;

  // Search hook events
  const hookConditions: string[] = [
    "(payload LIKE ? OR tool_name LIKE ? OR event_type LIKE ?)",
  ];
  const hookParams: unknown[] = [pattern, pattern, pattern];

  if (opts.event_types?.length) {
    hookConditions.push(`event_type IN (${opts.event_types.map(() => "?").join(",")})`);
    hookParams.push(...opts.event_types);
  }
  if (sinceMs) {
    hookConditions.push("timestamp_ms >= ?");
    hookParams.push(sinceMs);
  }

  const hookSql = `
    SELECT 'hook' as source, id, session_id, event_type, timestamp_ms,
           tool_name, payload
    FROM hook_events
    WHERE ${hookConditions.join(" AND ")}
  `;

  // Search otel logs
  const otelConditions: string[] = [
    "(body LIKE ? OR attributes LIKE ?)",
  ];
  const otelParams: unknown[] = [pattern, pattern];

  if (sinceMs) {
    otelConditions.push("CAST(timestamp_ns / 1000000 AS INTEGER) >= ?");
    otelParams.push(sinceMs);
  }

  const otelSql = `
    SELECT 'otel' as source, id, session_id, body as event_type,
           CAST(timestamp_ns / 1000000 AS INTEGER) as timestamp_ms,
           NULL as tool_name, attributes as payload
    FROM otel_logs
    WHERE ${otelConditions.join(" AND ")}
  `;

  const sql = `
    SELECT * FROM (${hookSql} UNION ALL ${otelSql})
    ORDER BY timestamp_ms DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...hookParams, ...otelParams, limit);
}

export function rawQuery(sql: string) {
  const db = getDb();

  // Only allow SELECT statements
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH") && !trimmed.startsWith("PRAGMA")) {
    throw new Error("Only SELECT, WITH, and PRAGMA statements are allowed");
  }

  return db.prepare(sql).all();
}

export function dbStats() {
  const db = getDb();
  const logs = db.prepare("SELECT COUNT(*) as count FROM otel_logs").get() as { count: number };
  const metrics = db.prepare("SELECT COUNT(*) as count FROM otel_metrics").get() as { count: number };
  const hooks = db.prepare("SELECT COUNT(*) as count FROM hook_events").get() as { count: number };

  return {
    otel_logs: logs.count,
    otel_metrics: metrics.count,
    hook_events: hooks.count,
  };
}
