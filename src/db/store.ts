import { createHash } from "node:crypto";
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

export interface OtelSpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  kind?: number;
  start_time_ns: number;
  end_time_ns: number;
  status_code?: number;
  status_message?: string;
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

const INSERT_SPAN_SQL = `
  INSERT OR IGNORE INTO otel_spans (trace_id, span_id, parent_span_id, name, kind, start_time_ns, end_time_ns, status_code, status_message, attributes, resource_attributes, session_id)
  VALUES (@trace_id, @span_id, @parent_span_id, @name, @kind, @start_time_ns, @end_time_ns, @status_code, @status_message, @attributes, @resource_attributes, @session_id)
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

export function insertOtelSpans(rows: OtelSpanRow[]): void {
  const db = getDb();
  const stmt = db.prepare(INSERT_SPAN_SQL);

  const insertMany = db.transaction((rows: OtelSpanRow[]) => {
    for (const row of rows) {
      stmt.run({
        trace_id: row.trace_id,
        span_id: row.span_id,
        parent_span_id: row.parent_span_id ?? null,
        name: row.name,
        kind: row.kind ?? null,
        start_time_ns: row.start_time_ns,
        end_time_ns: row.end_time_ns,
        status_code: row.status_code ?? null,
        status_message: row.status_message ?? null,
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
  gitIdentity?: { name: string | null; email: string | null },
  branch?: string | null,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_repositories (session_id, repository, first_seen_ms, git_user_name, git_user_email, branch)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, repository) DO UPDATE SET
       git_user_name = COALESCE(session_repositories.git_user_name, excluded.git_user_name),
       git_user_email = COALESCE(session_repositories.git_user_email, excluded.git_user_email),
       branch = COALESCE(excluded.branch, session_repositories.branch)`,
  ).run(
    sessionId,
    repository,
    timestampMs,
    gitIdentity?.name ?? null,
    gitIdentity?.email ?? null,
    branch ?? null,
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

// ---------------------------------------------------------------------------
// Config snapshots
// ---------------------------------------------------------------------------

function contentHash(obj: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(obj, Object.keys(obj).sort()))
    .digest("hex");
}

export interface UserConfigSnapshot {
  deviceName: string;
  permissions: unknown;
  enabledPlugins: unknown;
  hooks: unknown;
  commands: unknown;
  rules: unknown;
  skills: unknown;
}

/**
 * Insert a user config snapshot if the content has changed since the last one
 * for this device. Returns true if a new row was inserted.
 */
export function insertUserConfigSnapshot(snap: UserConfigSnapshot): boolean {
  const db = getDb();
  const hash = contentHash({
    permissions: snap.permissions,
    enabledPlugins: snap.enabledPlugins,
    hooks: snap.hooks,
    commands: snap.commands,
    rules: snap.rules,
    skills: snap.skills,
  });

  // Check if latest snapshot for this device has the same hash
  const existing = db
    .prepare(
      "SELECT content_hash FROM user_config_snapshots WHERE device_name = ? ORDER BY snapshot_at_ms DESC LIMIT 1",
    )
    .get(snap.deviceName) as { content_hash: string } | undefined;

  if (existing?.content_hash === hash) return false;

  db.prepare(
    `INSERT INTO user_config_snapshots
       (device_name, snapshot_at_ms, content_hash, permissions, enabled_plugins, hooks, commands, rules, skills)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snap.deviceName,
    Date.now(),
    hash,
    JSON.stringify(snap.permissions),
    JSON.stringify(snap.enabledPlugins),
    JSON.stringify(snap.hooks),
    JSON.stringify(snap.commands),
    JSON.stringify(snap.rules),
    JSON.stringify(snap.skills),
  );
  return true;
}

export interface RepoConfigSnapshot {
  repository: string;
  cwd: string;
  sessionId?: string;
  // project layer
  hooks: unknown;
  mcpServers: unknown;
  commands: unknown;
  agents: unknown;
  rules: unknown;
  // project local layer
  localHooks: unknown;
  localMcpServers: unknown;
  localPermissions: unknown;
  localIsGitignored: boolean;
  // instructions
  instructions: unknown;
}

/**
 * Insert a repo config snapshot if the content has changed since the last one
 * for this repository. Returns true if a new row was inserted.
 */
export function insertRepoConfigSnapshot(snap: RepoConfigSnapshot): boolean {
  const db = getDb();
  const hash = contentHash({
    hooks: snap.hooks,
    mcpServers: snap.mcpServers,
    commands: snap.commands,
    agents: snap.agents,
    rules: snap.rules,
    localHooks: snap.localHooks,
    localMcpServers: snap.localMcpServers,
    localPermissions: snap.localPermissions,
    localIsGitignored: snap.localIsGitignored,
    instructions: snap.instructions,
  });

  const existing = db
    .prepare(
      "SELECT content_hash FROM repo_config_snapshots WHERE repository = ? ORDER BY snapshot_at_ms DESC LIMIT 1",
    )
    .get(snap.repository) as { content_hash: string } | undefined;

  if (existing?.content_hash === hash) return false;

  db.prepare(
    `INSERT INTO repo_config_snapshots
       (repository, cwd, session_id, snapshot_at_ms, content_hash,
        hooks, mcp_servers, commands, agents, rules,
        local_hooks, local_mcp_servers, local_permissions, local_is_gitignored,
        instructions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snap.repository,
    snap.cwd,
    snap.sessionId ?? null,
    Date.now(),
    hash,
    JSON.stringify(snap.hooks),
    JSON.stringify(snap.mcpServers),
    JSON.stringify(snap.commands),
    JSON.stringify(snap.agents),
    JSON.stringify(snap.rules),
    JSON.stringify(snap.localHooks),
    JSON.stringify(snap.localMcpServers),
    JSON.stringify(snap.localPermissions),
    snap.localIsGitignored ? 1 : 0,
    JSON.stringify(snap.instructions),
  );
  return true;
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
  // Scanner-sourced fields
  model?: string;
  cli_version?: string;
  scanner_file_path?: string;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number;
  total_cache_creation_tokens?: number;
  total_reasoning_tokens?: number;
  turn_count?: number;
  // OTLP-sourced tokens
  otel_input_tokens?: number;
  otel_output_tokens?: number;
  otel_cache_read_tokens?: number;
  otel_cache_creation_tokens?: number;
}

export function upsertSession(row: SessionUpsert): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (session_id, target, started_at_ms, ended_at_ms, cwd, first_prompt,
       permission_mode, agent_version, model, cli_version, scanner_file_path,
       total_input_tokens, total_output_tokens, total_cache_read_tokens,
       total_cache_creation_tokens, total_reasoning_tokens, turn_count,
       otel_input_tokens, otel_output_tokens, otel_cache_read_tokens, otel_cache_creation_tokens,
       models)
     VALUES (@session_id, @target, @started_at_ms, @ended_at_ms, @cwd, @first_prompt,
       @permission_mode, @agent_version, @model, @cli_version, @scanner_file_path,
       @total_input_tokens, @total_output_tokens, @total_cache_read_tokens,
       @total_cache_creation_tokens, @total_reasoning_tokens, @turn_count,
       @otel_input_tokens, @otel_output_tokens, @otel_cache_read_tokens, @otel_cache_creation_tokens,
       @model)
     ON CONFLICT(session_id) DO UPDATE SET
       target = COALESCE(excluded.target, sessions.target),
       started_at_ms = COALESCE(excluded.started_at_ms, sessions.started_at_ms),
       ended_at_ms = COALESCE(excluded.ended_at_ms, sessions.ended_at_ms),
       cwd = COALESCE(excluded.cwd, sessions.cwd),
       first_prompt = COALESCE(sessions.first_prompt, excluded.first_prompt),
       permission_mode = COALESCE(excluded.permission_mode, sessions.permission_mode),
       agent_version = COALESCE(excluded.agent_version, sessions.agent_version),
       model = COALESCE(excluded.model, sessions.model),
       cli_version = COALESCE(excluded.cli_version, sessions.cli_version),
       scanner_file_path = COALESCE(excluded.scanner_file_path, sessions.scanner_file_path),
       total_input_tokens = COALESCE(excluded.total_input_tokens, sessions.total_input_tokens),
       total_output_tokens = COALESCE(excluded.total_output_tokens, sessions.total_output_tokens),
       total_cache_read_tokens = COALESCE(excluded.total_cache_read_tokens, sessions.total_cache_read_tokens),
       total_cache_creation_tokens = COALESCE(excluded.total_cache_creation_tokens, sessions.total_cache_creation_tokens),
       total_reasoning_tokens = COALESCE(excluded.total_reasoning_tokens, sessions.total_reasoning_tokens),
       turn_count = COALESCE(excluded.turn_count, sessions.turn_count),
       otel_input_tokens = COALESCE(excluded.otel_input_tokens, sessions.otel_input_tokens),
       otel_output_tokens = COALESCE(excluded.otel_output_tokens, sessions.otel_output_tokens),
       otel_cache_read_tokens = COALESCE(excluded.otel_cache_read_tokens, sessions.otel_cache_read_tokens),
       otel_cache_creation_tokens = COALESCE(excluded.otel_cache_creation_tokens, sessions.otel_cache_creation_tokens),
       models = CASE
         WHEN excluded.model IS NULL THEN sessions.models
         WHEN sessions.models IS NULL THEN excluded.model
         WHEN sessions.models LIKE '%' || excluded.model || '%' THEN sessions.models
         ELSE sessions.models || ',' || excluded.model
       END,
       sync_dirty = 1`,
  ).run({
    session_id: row.session_id,
    target: row.target ?? null,
    started_at_ms: row.started_at_ms ?? null,
    ended_at_ms: row.ended_at_ms ?? null,
    cwd: row.cwd ?? null,
    first_prompt: row.first_prompt ?? null,
    permission_mode: row.permission_mode ?? null,
    agent_version: row.agent_version ?? null,
    model: row.model ?? null,
    cli_version: row.cli_version ?? null,
    scanner_file_path: row.scanner_file_path ?? null,
    total_input_tokens: row.total_input_tokens ?? null,
    total_output_tokens: row.total_output_tokens ?? null,
    total_cache_read_tokens: row.total_cache_read_tokens ?? null,
    total_cache_creation_tokens: row.total_cache_creation_tokens ?? null,
    total_reasoning_tokens: row.total_reasoning_tokens ?? null,
    turn_count: row.turn_count ?? null,
    otel_input_tokens: row.otel_input_tokens ?? null,
    otel_output_tokens: row.otel_output_tokens ?? null,
    otel_cache_read_tokens: row.otel_cache_read_tokens ?? null,
    otel_cache_creation_tokens: row.otel_cache_creation_tokens ?? null,
  });
}

export function clearSessionDirtyFlags(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  const db = getDb();
  const placeholders = sessionIds.map(() => "?").join(", ");
  db.prepare(
    `UPDATE sessions SET sync_dirty = 0 WHERE session_id IN (${placeholders})`,
  ).run(...sessionIds);
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
