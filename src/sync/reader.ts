import { getDb } from "../db/schema.js";
import type { HookEventRecord, MetricRow, OtelLogRecord } from "./types.js";

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// ── Hook events ──────────────────────────────────────────────────────────────

const HOOK_EVENTS_SQL = `
  SELECT id, session_id, event_type, timestamp_ms, cwd, repository,
         tool_name, decompress(payload) as payload,
         user_prompt, file_path, command, tool_result
  FROM hook_events
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

export function readHookEvents(
  afterId: number,
  limit: number,
): { rows: HookEventRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(HOOK_EVENTS_SQL).all(afterId, limit) as Array<{
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
    tool_result: string | null;
  }>;

  const rows: HookEventRecord[] = rawRows.map((r) => ({
    hookId: r.id,
    sessionId: r.session_id,
    eventType: r.event_type,
    timestampMs: r.timestamp_ms,
    cwd: r.cwd,
    repository: r.repository,
    toolName: r.tool_name,
    payload: parseJson(r.payload),
    userPrompt: r.user_prompt,
    filePath: r.file_path,
    command: r.command,
    toolResult: r.tool_result,
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].hookId : afterId;
  return { rows, maxId };
}

// ── OTLP logs ────────────────────────────────────────────────────────────────

/** Body types that hooks already cover — filtered out when hooks are installed. */
const HOOK_COVERED_BODIES = [
  // Claude Code
  "claude_code.user_prompt",
  "claude_code.tool_decision",
  "claude_code.tool_result",
  // Gemini CLI
  "gemini_cli.user_prompt",
  "gemini_cli.tool_call",
  "gemini_cli.hook_call",
];

const ALL_LOGS_SQL = `
  SELECT id, timestamp_ns, body, attributes, resource_attributes,
         severity_text, session_id, prompt_id, trace_id, span_id
  FROM otel_logs
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

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

function mapOtelRows(rawRows: RawOtelLogRow[]): OtelLogRecord[] {
  return rawRows.map((r) => ({
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
}

/**
 * Read OTLP logs in batches.
 * When hooksInstalled is true, filters out body types that hooks cover
 * (tool_decision, tool_result, user_prompt) to avoid double-counting.
 */
/**
 * Read OTLP logs in batches.
 * When hooksInstalled is true, filters out body types that hooks cover
 * (tool_decision, tool_result, user_prompt) to avoid double-counting.
 *
 * maxId advances to the highest id scanned (not just the highest returned),
 * so the watermark skips past blocks of filtered rows without stalling.
 */
export function readOtelLogs(
  afterId: number,
  limit: number,
  hooksInstalled: boolean,
): { rows: OtelLogRecord[]; maxId: number } {
  const db = getDb();

  if (!hooksInstalled) {
    const rawRows = db
      .prepare(ALL_LOGS_SQL)
      .all(afterId, limit) as RawOtelLogRow[];
    const rows = mapOtelRows(rawRows);
    const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
    return { rows, maxId };
  }

  // When filtering, we need the max id from the unfiltered range so the
  // watermark advances past blocks of hook-covered rows.
  const scanMaxId = (
    db
      .prepare(
        "SELECT MAX(id) as m FROM (SELECT id FROM otel_logs WHERE id > ? ORDER BY id LIMIT ?)",
      )
      .get(afterId, limit) as { m: number | null }
  ).m;

  if (scanMaxId == null) return { rows: [], maxId: afterId };

  // Only return filtered rows within the scanned range (id <= scanMaxId),
  // not beyond it — otherwise we'd skip ahead of the scan window.
  const rawRows = db
    .prepare(
      `SELECT id, timestamp_ns, body, attributes, resource_attributes,
              severity_text, session_id, prompt_id, trace_id, span_id
       FROM otel_logs
       WHERE id > ? AND id <= ?
         AND body NOT IN (${HOOK_COVERED_BODIES.map(() => "?").join(", ")})
       ORDER BY id`,
    )
    .all(afterId, scanMaxId, ...HOOK_COVERED_BODIES) as RawOtelLogRow[];

  const rows = mapOtelRows(rawRows);
  return { rows, maxId: scanMaxId };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

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
  const rawRows = db.prepare(METRICS_SQL).all(afterId, limit) as Array<{
    id: number;
    timestamp_ns: number;
    name: string;
    value: number;
    metric_type: string | null;
    unit: string | null;
    attributes: string | null;
    resource_attributes: string | null;
    session_id: string | null;
  }>;

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
