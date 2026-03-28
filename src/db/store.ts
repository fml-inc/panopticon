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
  target?: string;
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
                           target, user_prompt, file_path, command, tool_result, plan, allowed_prompts, payload)
  VALUES (@session_id, @event_type, @timestamp_ms, @cwd, @repository, @tool_name,
          @target, @user_prompt, @file_path, @command, @tool_result, @plan, @allowed_prompts, @payload)
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
      const sessionId = row.session_id ?? null;

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
        session_id: sessionId,
      });
    }
  });
  insertMany(rows);
}

export function upsertSessionRepository(
  sessionId: string,
  repository: string,
  timestampMs: number,
  gitIdentity?: { name: string | null; email: string | null },
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_repositories (session_id, repository, first_seen_ms, git_user_name, git_user_email)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, repository) DO UPDATE SET
       git_user_name = COALESCE(session_repositories.git_user_name, excluded.git_user_name),
       git_user_email = COALESCE(session_repositories.git_user_email, excluded.git_user_email)`,
  ).run(
    sessionId,
    repository,
    timestampMs,
    gitIdentity?.name ?? null,
    gitIdentity?.email ?? null,
  );
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

export interface SessionUpsert {
  session_id: string;
  target?: string;
  started_at_ms?: number;
  ended_at_ms?: number;
  cwd?: string;
  first_prompt?: string;
  permission_mode?: string;
  agent_version?: string;
}

export function upsertSession(row: SessionUpsert): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (session_id, target, started_at_ms, ended_at_ms, cwd, first_prompt, permission_mode, agent_version)
     VALUES (@session_id, @target, @started_at_ms, @ended_at_ms, @cwd, @first_prompt, @permission_mode, @agent_version)
     ON CONFLICT(session_id) DO UPDATE SET
       target = COALESCE(excluded.target, sessions.target),
       started_at_ms = COALESCE(excluded.started_at_ms, sessions.started_at_ms),
       ended_at_ms = COALESCE(excluded.ended_at_ms, sessions.ended_at_ms),
       cwd = COALESCE(excluded.cwd, sessions.cwd),
       first_prompt = COALESCE(sessions.first_prompt, excluded.first_prompt),
       permission_mode = COALESCE(excluded.permission_mode, sessions.permission_mode),
       agent_version = COALESCE(excluded.agent_version, sessions.agent_version)`,
  ).run({
    session_id: row.session_id,
    target: row.target ?? null,
    started_at_ms: row.started_at_ms ?? null,
    ended_at_ms: row.ended_at_ms ?? null,
    cwd: row.cwd ?? null,
    first_prompt: row.first_prompt ?? null,
    permission_mode: row.permission_mode ?? null,
    agent_version: row.agent_version ?? null,
  });
}

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

  // Extract high-value fields into columns for indexed queries
  const userPrompt =
    extractStr(data, "prompt") ?? extractStr(data, "user_prompt");
  const filePath = extractStr(toolInput, "file_path");
  const command = extractStr(toolInput, "command");
  const plan = extractStr(toolInput, "plan");
  const toolResultRaw = data.tool_result ?? data.tool_response;
  const toolResult = toolResultRaw
    ? typeof toolResultRaw === "string"
      ? toolResultRaw
      : JSON.stringify(toolResultRaw)
    : undefined;
  const allowedPrompts = toolInput?.allowedPrompts
    ? JSON.stringify(toolInput.allowedPrompts)
    : undefined;

  const fullJson = JSON.stringify(data);

  const insertWithFts = db.transaction(() => {
    db.prepare(INSERT_HOOK_SQL).run({
      session_id: row.session_id,
      event_type: row.event_type,
      timestamp_ms: row.timestamp_ms,
      cwd: row.cwd ?? null,
      repository: row.repository ?? null,
      tool_name: row.tool_name ?? null,
      target: row.target ?? null,
      user_prompt: userPrompt ?? null,
      file_path: filePath ?? null,
      command: command ?? null,
      tool_result: toolResult ?? null,
      plan: plan ?? null,
      allowed_prompts: allowedPrompts ?? null,
      payload: gzipSync(Buffer.from(fullJson)),
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
