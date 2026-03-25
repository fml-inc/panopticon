import { getDb } from "../db/schema.js";
import type { MergedEvent, MetricRow, UnmatchedOtelLog } from "./types.js";

/** OTLP body types that get merged with hook events. */
const MERGED_OTEL_BODIES = [
  "claude_code.user_prompt",
  "claude_code.tool_decision",
  "claude_code.tool_result",
];

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// ── Merged events ────────────────────────────────────────────────────────────

interface RawMergedRow {
  id: number;
  session_id: string;
  event_type: string;
  timestamp_ms: number;
  cwd: string | null;
  repository: string | null;
  tool_name: string | null;
  payload: string | null;
  user_prompt: string | null;
  file_path: string | null;
  command: string | null;
  otel_log_id: number | null;
  otel_timestamp_ns: number | null;
  otel_body: string | null;
  otel_attributes: string | null;
  otel_resource_attributes: string | null;
  otel_severity_text: string | null;
  otel_prompt_id: string | null;
  otel_trace_id: string | null;
  otel_span_id: string | null;
}

const MERGE_SQL = `
  WITH batch AS (
    SELECT id, session_id, event_type, timestamp_ms, cwd, repository,
           tool_name, decompress(payload) as payload,
           user_prompt, file_path, command
    FROM hook_events
    WHERE id > ?
    ORDER BY id
    LIMIT ?
  )
  SELECT b.*,
         l.id AS otel_log_id,
         l.timestamp_ns AS otel_timestamp_ns,
         l.body AS otel_body,
         l.attributes AS otel_attributes,
         l.resource_attributes AS otel_resource_attributes,
         l.severity_text AS otel_severity_text,
         l.prompt_id AS otel_prompt_id,
         l.trace_id AS otel_trace_id,
         l.span_id AS otel_span_id
  FROM batch b
  LEFT JOIN otel_logs l
    ON l.session_id = b.session_id
    AND l.body = CASE b.event_type
      WHEN 'UserPromptSubmit' THEN 'claude_code.user_prompt'
      WHEN 'PreToolUse' THEN 'claude_code.tool_decision'
      WHEN 'PostToolUse' THEN 'claude_code.tool_result'
      WHEN 'PostToolUseFailure' THEN 'claude_code.tool_result'
    END
    AND ABS(CAST(l.timestamp_ns / 1000000 AS INTEGER) - b.timestamp_ms) < 100
    AND (
      b.tool_name IS NULL
      OR json_extract(l.attributes, '$.tool_name') = b.tool_name
    )
  ORDER BY b.id
`;

export function readMergedEvents(
  afterId: number,
  limit: number,
): { rows: MergedEvent[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(MERGE_SQL).all(afterId, limit) as RawMergedRow[];

  // Deduplicate: if multiple OTLP logs matched one hook event (shouldn't
  // happen but defensive), keep the one with the closest timestamp.
  const seen = new Map<number, MergedEvent>();

  for (const raw of rawRows) {
    const existing = seen.get(raw.id);
    if (existing) {
      // Keep the one with closest OTLP timestamp
      if (
        raw.otel_timestamp_ns != null &&
        existing.otelPromptId == null // existing had no match
      ) {
        // Replace with this one
      } else if (
        raw.otel_timestamp_ns != null &&
        existing.otelPromptId != null
      ) {
        const existingDelta = Math.abs(
          Number(
            BigInt(existing.timestampMs) * 1_000_000n -
              BigInt(raw.otel_timestamp_ns),
          ),
        );
        const newDelta = Math.abs(
          Number(
            BigInt(raw.timestamp_ms) * 1_000_000n -
              BigInt(raw.otel_timestamp_ns),
          ),
        );
        if (newDelta >= existingDelta) continue; // existing is closer, skip
      } else {
        continue; // no improvement
      }
    }

    seen.set(raw.id, {
      hookId: raw.id,
      sessionId: raw.session_id,
      eventType: raw.event_type,
      timestampMs: raw.timestamp_ms,
      cwd: raw.cwd,
      repository: raw.repository,
      toolName: raw.tool_name,
      payload: parseJson(raw.payload),
      userPrompt: raw.user_prompt,
      filePath: raw.file_path,
      command: raw.command,
      otelAttributes: parseJson(raw.otel_attributes),
      otelResourceAttributes: parseJson(raw.otel_resource_attributes),
      otelSeverityText: raw.otel_severity_text,
      otelPromptId: raw.otel_prompt_id,
      otelTraceId: raw.otel_trace_id,
      otelSpanId: raw.otel_span_id,
    });
  }

  const rows = Array.from(seen.values());
  const maxId = rows.length > 0 ? rows[rows.length - 1].hookId : afterId;

  return { rows, maxId };
}

// ── Unmatched OTLP logs ──────────────────────────────────────────────────────

interface RawOtelLogRow {
  id: number;
  timestamp_ns: number;
  body: string | null;
  attributes: string | null;
  resource_attributes: string | null;
  severity_text: string | null;
  session_id: string | null;
  prompt_id: string | null;
  trace_id: string | null;
  span_id: string | null;
}

const UNMATCHED_LOGS_SQL = `
  SELECT id, timestamp_ns, body, attributes, resource_attributes,
         severity_text, session_id, prompt_id, trace_id, span_id
  FROM otel_logs
  WHERE id > ?
    AND body NOT IN (${MERGED_OTEL_BODIES.map(() => "?").join(", ")})
  ORDER BY id
  LIMIT ?
`;

export function readUnmatchedOtelLogs(
  afterId: number,
  limit: number,
): { rows: UnmatchedOtelLog[]; maxId: number } {
  const db = getDb();
  const rawRows = db
    .prepare(UNMATCHED_LOGS_SQL)
    .all(afterId, ...MERGED_OTEL_BODIES, limit) as RawOtelLogRow[];

  const rows: UnmatchedOtelLog[] = rawRows.map((r) => ({
    id: r.id,
    timestampNs: r.timestamp_ns,
    body: r.body,
    attributes: parseJson(r.attributes),
    resourceAttributes: parseJson(r.resource_attributes),
    severityText: r.severity_text,
    sessionId: r.session_id,
    promptId: r.prompt_id,
    traceId: r.trace_id,
    spanId: r.span_id,
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

interface RawMetricRow {
  id: number;
  timestamp_ns: number;
  name: string;
  value: number;
  metric_type: string | null;
  unit: string | null;
  attributes: string | null;
  resource_attributes: string | null;
  session_id: string | null;
}

const METRICS_SQL = `
  SELECT id, timestamp_ns, name, value, metric_type, unit,
         attributes, resource_attributes, session_id
  FROM otel_metrics
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

export function readMetrics(
  afterId: number,
  limit: number,
): { rows: MetricRow[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(METRICS_SQL).all(afterId, limit) as RawMetricRow[];

  const rows: MetricRow[] = rawRows.map((r) => ({
    id: r.id,
    timestampNs: r.timestamp_ns,
    name: r.name,
    value: r.value,
    metricType: r.metric_type,
    unit: r.unit,
    attributes: parseJson(r.attributes),
    resourceAttributes: parseJson(r.resource_attributes),
    sessionId: r.session_id,
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}
