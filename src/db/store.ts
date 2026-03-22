import { gzipSync } from "node:zlib";
import { getDb } from "./schema.js";

export interface OtelLogRow {
  timestamp_ns: number;
  observed_timestamp_ns?: number;
  severity_number?: number;
  severity_text?: string;
  body?: string;
  attributes?: Record<string, unknown>;
  resource_attributes?: Record<string, unknown>;
  session_id?: string;
  prompt_id?: string;
  trace_id?: string;
  span_id?: string;
}

export interface OtelMetricRow {
  timestamp_ns: number;
  name: string;
  value: number;
  metric_type?: string;
  unit?: string;
  attributes?: Record<string, unknown>;
  resource_attributes?: Record<string, unknown>;
  session_id?: string;
}

export interface HookEventRow {
  session_id: string;
  event_type: string;
  timestamp_ms: number;
  cwd?: string;
  repository?: string;
  tool_name?: string;
  user_prompt?: string;
  file_path?: string;
  command?: string;
  plan?: string;
  allowed_prompts?: string;
  payload: unknown;
}

const INSERT_LOG_SQL = `
  INSERT INTO otel_logs (timestamp_ns, observed_timestamp_ns, severity_number, severity_text, body, attributes, resource_attributes, session_id, prompt_id, trace_id, span_id)
  VALUES (@timestamp_ns, @observed_timestamp_ns, @severity_number, @severity_text, @body, @attributes, @resource_attributes, @session_id, @prompt_id, @trace_id, @span_id)
`;

const INSERT_METRIC_SQL = `
  INSERT INTO otel_metrics (timestamp_ns, name, value, metric_type, unit, attributes, resource_attributes, session_id)
  VALUES (@timestamp_ns, @name, @value, @metric_type, @unit, @attributes, @resource_attributes, @session_id)
`;

const INSERT_HOOK_SQL = `
  INSERT INTO hook_events (session_id, event_type, timestamp_ms, cwd, repository, tool_name,
                           user_prompt, file_path, command, plan, allowed_prompts, payload)
  VALUES (@session_id, @event_type, @timestamp_ms, @cwd, @repository, @tool_name,
          @user_prompt, @file_path, @command, @plan, @allowed_prompts, @payload)
`;

export function insertOtelLogs(rows: OtelLogRow[]): void {
  const db = getDb();
  const stmt = db.prepare(INSERT_LOG_SQL);
  const insertMany = db.transaction((rows: OtelLogRow[]) => {
    for (const row of rows) {
      stmt.run({
        timestamp_ns: row.timestamp_ns,
        observed_timestamp_ns: row.observed_timestamp_ns ?? null,
        severity_number: row.severity_number ?? null,
        severity_text: row.severity_text ?? null,
        body: row.body ?? null,
        attributes: row.attributes ? JSON.stringify(row.attributes) : null,
        resource_attributes: row.resource_attributes
          ? JSON.stringify(row.resource_attributes)
          : null,
        session_id: row.session_id ?? null,
        prompt_id: row.prompt_id ?? null,
        trace_id: row.trace_id ?? null,
        span_id: row.span_id ?? null,
      });
    }
  });
  insertMany(rows);
}

export function insertOtelMetrics(rows: OtelMetricRow[]): void {
  const db = getDb();
  const stmt = db.prepare(INSERT_METRIC_SQL);
  const insertMany = db.transaction((rows: OtelMetricRow[]) => {
    for (const row of rows) {
      stmt.run({
        timestamp_ns: row.timestamp_ns,
        name: row.name,
        value: row.value,
        metric_type: row.metric_type ?? null,
        unit: row.unit ?? null,
        attributes: row.attributes ? JSON.stringify(row.attributes) : null,
        resource_attributes: row.resource_attributes
          ? JSON.stringify(row.resource_attributes)
          : null,
        session_id: row.session_id ?? null,
      });
    }
  });
  insertMany(rows);
}

export function upsertSessionRepository(
  sessionId: string,
  repository: string,
  timestampMs: number,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO session_repositories (session_id, repository, first_seen_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(sessionId, repository, timestampMs);
}

export function upsertSessionCwd(
  sessionId: string,
  cwd: string,
  timestampMs: number,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO session_cwds (session_id, cwd, first_seen_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(sessionId, cwd, timestampMs);
}

/** Fields that are already stored as columns or are noise — strip from payload before compression. */
const STRIP_TOP_LEVEL = new Set([
  "session_id",
  "hook_event_name",
  "tool_name",
  "cwd",
  "repository",
  "transcript_path",
  "permission_mode",
  "tool_use_id",
  "prompt",
  "user_prompt",
]);

const STRIP_TOOL_INPUT = new Set([
  "file_path",
  "command",
  "plan",
  "allowedPrompts",
]);

function extractStr(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" ? v : undefined;
}

export function insertHookEvent(row: HookEventRow): void {
  const db = getDb();
  const data = row.payload as Record<string, unknown>;
  const toolInput = data.tool_input as Record<string, unknown> | undefined;

  // Extract high-value fields into columns
  const userPrompt = extractStr(data, "prompt");
  const filePath = extractStr(toolInput, "file_path");
  const command = extractStr(toolInput, "command");
  const plan = extractStr(toolInput, "plan");
  const allowedPrompts = toolInput?.allowedPrompts
    ? JSON.stringify(toolInput.allowedPrompts)
    : undefined;

  // Full JSON for FTS (before stripping)
  const fullJson = JSON.stringify(data);

  // Strip redundant / extracted fields from payload before compression
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!STRIP_TOP_LEVEL.has(k)) stripped[k] = v;
  }
  if (toolInput) {
    const ti: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(toolInput)) {
      if (!STRIP_TOOL_INPUT.has(k)) ti[k] = v;
    }
    if (Object.keys(ti).length > 0) {
      stripped.tool_input = ti;
    } else {
      delete stripped.tool_input;
    }
  }

  const insertWithFts = db.transaction(() => {
    db.prepare(INSERT_HOOK_SQL).run({
      session_id: row.session_id,
      event_type: row.event_type,
      timestamp_ms: row.timestamp_ms,
      cwd: row.cwd ?? null,
      repository: row.repository ?? null,
      tool_name: row.tool_name ?? null,
      user_prompt: userPrompt ?? null,
      file_path: filePath ?? null,
      command: command ?? null,
      plan: plan ?? null,
      allowed_prompts: allowedPrompts ?? null,
      payload: gzipSync(Buffer.from(JSON.stringify(stripped))),
    });
    const { id } = db.prepare("SELECT last_insert_rowid() as id").get() as {
      id: number;
    };
    db.prepare("INSERT INTO hook_events_fts(rowid, payload) VALUES (?, ?)").run(
      id,
      fullJson,
    );
  });
  insertWithFts();
}
