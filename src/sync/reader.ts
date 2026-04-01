import { getDb } from "../db/schema.js";
import type {
  HookEventRecord,
  MetricRow,
  OtelLogRecord,
  OtelSpanRecord,
  ScannerEventRecord,
  ScannerTurnRecord,
} from "./types.js";

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
  SELECT h.id, h.session_id, h.event_type, h.timestamp_ms, h.cwd, h.repository,
         h.tool_name, decompress(h.payload) as payload,
         h.user_prompt, h.file_path, h.command, h.tool_result,
         s.target
  FROM hook_events h
  LEFT JOIN sessions s ON s.session_id = h.session_id
  WHERE h.id > ?
  ORDER BY h.id
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
    target: string | null;
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
    target: r.target,
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

// ── Scanner turns ───────────────────────────────────────────────────────────

const SCANNER_TURNS_SQL = `
  SELECT t.id, t.session_id, t.source, t.turn_index, t.timestamp_ms,
         t.model, t.role, t.content_preview,
         t.input_tokens, t.output_tokens, t.cache_read_tokens,
         t.cache_creation_tokens, t.reasoning_tokens,
         s.cli_version
  FROM scanner_turns t
  LEFT JOIN sessions s ON s.session_id = t.session_id
  WHERE t.id > ?
  ORDER BY t.id
  LIMIT ?
`;

export function readScannerTurns(
  afterId: number,
  limit: number,
): { rows: ScannerTurnRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(SCANNER_TURNS_SQL).all(afterId, limit) as Array<{
    id: number;
    session_id: string;
    source: string;
    turn_index: number;
    timestamp_ms: number;
    model: string | null;
    role: string | null;
    content_preview: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    reasoning_tokens: number;
    cli_version: string | null;
  }>;

  const rows: ScannerTurnRecord[] = rawRows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    source: r.source,
    turnIndex: r.turn_index,
    timestampMs: r.timestamp_ms,
    model: r.model,
    role: r.role,
    contentPreview: r.content_preview,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    reasoningTokens: r.reasoning_tokens,
    cliVersion: r.cli_version,
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

// ── Scanner events ──────────────────────────────────────────────────────────

const SCANNER_EVENTS_SQL = `
  SELECT id, session_id, source, event_type, timestamp_ms,
         tool_name, tool_input, tool_output, content, metadata
  FROM scanner_events
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

export function readScannerEvents(
  afterId: number,
  limit: number,
): { rows: ScannerEventRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(SCANNER_EVENTS_SQL).all(afterId, limit) as Array<{
    id: number;
    session_id: string;
    source: string;
    event_type: string;
    timestamp_ms: number;
    tool_name: string | null;
    tool_input: string | null;
    tool_output: string | null;
    content: string | null;
    metadata: string | null;
  }>;

  const rows: ScannerEventRecord[] = rawRows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    source: r.source,
    eventType: r.event_type,
    timestampMs: r.timestamp_ms,
    toolName: r.tool_name,
    toolInput: r.tool_input,
    toolOutput: r.tool_output,
    content: r.content,
    metadata: parseJson(r.metadata),
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

// ── OTLP spans ─────────────────────────────────────────────────────────────

const SPANS_SQL = `
  SELECT id, trace_id, span_id, parent_span_id, name, kind,
         start_time_ns, end_time_ns, status_code, status_message,
         attributes, resource_attributes, session_id
  FROM otel_spans
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

export function readOtelSpans(
  afterId: number,
  limit: number,
): { rows: OtelSpanRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(SPANS_SQL).all(afterId, limit) as Array<{
    id: number;
    trace_id: string;
    span_id: string;
    parent_span_id: string | null;
    name: string;
    kind: number | null;
    start_time_ns: number;
    end_time_ns: number;
    status_code: number | null;
    status_message: string | null;
    attributes: string | null;
    resource_attributes: string | null;
    session_id: string | null;
  }>;

  const rows: OtelSpanRecord[] = rawRows.map((r) => ({
    id: r.id,
    traceId: r.trace_id,
    spanId: r.span_id,
    parentSpanId: r.parent_span_id,
    name: r.name,
    kind: r.kind,
    startTimeNs: r.start_time_ns,
    endTimeNs: r.end_time_ns,
    statusCode: r.status_code,
    statusMessage: r.status_message,
    attributes: parseJson(r.attributes),
    resourceAttributes: parseJson(r.resource_attributes),
    sessionId: r.session_id,
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}
