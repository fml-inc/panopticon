import { getDb } from "../db/schema.js";
import type {
  HookEventRecord,
  MessageSyncRecord,
  MetricRow,
  OtelLogRecord,
  OtelSpanRecord,
  RepoConfigSnapshotRecord,
  ScannerEventRecord,
  ScannerTurnRecord,
  SessionSyncRecord,
  ToolCallSyncRecord,
  UserConfigSnapshotRecord,
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
  SELECT h.id, h.session_id, h.sync_id, h.event_type, h.timestamp_ms, h.cwd, h.repository,
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
    sync_id: string | null;
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
    syncId: r.sync_id,
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
  SELECT id, sync_id, timestamp_ns, body, attributes, resource_attributes,
         severity_text, session_id, prompt_id, trace_id, span_id
  FROM otel_logs
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

interface RawOtelLogRow {
  id: number;
  sync_id: string | null;
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
    syncId: r.sync_id,
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
      `SELECT id, sync_id, timestamp_ns, body, attributes, resource_attributes,
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
  SELECT id, sync_id, timestamp_ns, name, value, metric_type, unit,
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
    sync_id: string | null;
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
    syncId: r.sync_id,
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
  SELECT t.id, t.session_id, t.sync_id, t.source, t.turn_index, t.timestamp_ms,
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
    sync_id: string | null;
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
    syncId: r.sync_id,
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
  SELECT id, session_id, sync_id, source, event_type, timestamp_ms,
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
    sync_id: string | null;
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
    syncId: r.sync_id,
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

// ── JSON parse helpers for config snapshots ─────────────────────────────────

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

// ── User config snapshots ──────────────────────────────────────────────────

const USER_CONFIG_SQL = `
  SELECT id, device_name, snapshot_at_ms, content_hash,
         permissions, enabled_plugins, hooks, commands, rules, skills, plugin_hooks
  FROM user_config_snapshots
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

export function readUserConfigSnapshots(
  afterId: number,
  limit: number,
): { rows: UserConfigSnapshotRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(USER_CONFIG_SQL).all(afterId, limit) as Array<{
    id: number;
    device_name: string;
    snapshot_at_ms: number;
    content_hash: string;
    permissions: string | null;
    enabled_plugins: string | null;
    hooks: string | null;
    commands: string | null;
    rules: string | null;
    skills: string | null;
    plugin_hooks: string | null;
  }>;

  const rows: UserConfigSnapshotRecord[] = rawRows.map((r) => ({
    id: r.id,
    deviceName: r.device_name,
    snapshotAtMs: r.snapshot_at_ms,
    contentHash: r.content_hash,
    permissions: parseJsonObject(r.permissions),
    enabledPlugins: parseJsonArray(r.enabled_plugins),
    hooks: parseJsonArray(r.hooks),
    commands: parseJsonArray(r.commands),
    rules: parseJsonArray(r.rules),
    skills: parseJsonArray(r.skills),
    pluginHooks: parseJsonArray(r.plugin_hooks),
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

// ── Repo config snapshots ──────────────────────────────────────────────────

const REPO_CONFIG_SQL = `
  SELECT id, repository, cwd, session_id, snapshot_at_ms, content_hash,
         hooks, mcp_servers, commands, agents, rules,
         local_hooks, local_mcp_servers, local_permissions,
         local_is_gitignored, instructions
  FROM repo_config_snapshots
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

export function readRepoConfigSnapshots(
  afterId: number,
  limit: number,
): { rows: RepoConfigSnapshotRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(REPO_CONFIG_SQL).all(afterId, limit) as Array<{
    id: number;
    repository: string;
    cwd: string;
    session_id: string | null;
    snapshot_at_ms: number;
    content_hash: string;
    hooks: string | null;
    mcp_servers: string | null;
    commands: string | null;
    agents: string | null;
    rules: string | null;
    local_hooks: string | null;
    local_mcp_servers: string | null;
    local_permissions: string | null;
    local_is_gitignored: number;
    instructions: string | null;
  }>;

  const rows: RepoConfigSnapshotRecord[] = rawRows.map((r) => ({
    id: r.id,
    repository: r.repository,
    cwd: r.cwd,
    sessionId: r.session_id,
    snapshotAtMs: r.snapshot_at_ms,
    contentHash: r.content_hash,
    hooks: parseJsonArray(r.hooks),
    mcpServers: parseJsonArray(r.mcp_servers),
    commands: parseJsonArray(r.commands),
    agents: parseJsonArray(r.agents),
    rules: parseJsonArray(r.rules),
    localHooks: parseJsonArray(r.local_hooks),
    localMcpServers: parseJsonArray(r.local_mcp_servers),
    localPermissions: parseJsonObject(r.local_permissions),
    localIsGitignored: r.local_is_gitignored === 1,
    instructions: parseJsonArray(r.instructions),
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

// ── Messages ────────────────────────────────────────────────────────────────

const MESSAGES_SQL = `
  SELECT id, session_id, ordinal, role, content, timestamp_ms,
         has_thinking, has_tool_use, content_length, is_system,
         model, token_usage, context_tokens, output_tokens,
         has_context_tokens, has_output_tokens
  FROM messages
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

export function readMessages(
  afterId: number,
  limit: number,
): { rows: MessageSyncRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(MESSAGES_SQL).all(afterId, limit) as Array<{
    id: number;
    session_id: string;
    ordinal: number;
    role: string;
    content: string;
    timestamp_ms: number | null;
    has_thinking: number;
    has_tool_use: number;
    content_length: number;
    is_system: number;
    model: string;
    token_usage: string;
    context_tokens: number;
    output_tokens: number;
    has_context_tokens: number;
    has_output_tokens: number;
  }>;

  const rows: MessageSyncRecord[] = rawRows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    ordinal: r.ordinal,
    role: r.role,
    content: r.content,
    timestampMs: r.timestamp_ms,
    hasThinking: r.has_thinking === 1,
    hasToolUse: r.has_tool_use === 1,
    contentLength: r.content_length,
    isSystem: r.is_system === 1,
    model: r.model,
    tokenUsage: r.token_usage,
    contextTokens: r.context_tokens,
    outputTokens: r.output_tokens,
    hasContextTokens: r.has_context_tokens === 1,
    hasOutputTokens: r.has_output_tokens === 1,
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

// ── Tool calls ──────────────────────────────────────────────────────────────

const TOOL_CALLS_SQL = `
  SELECT id, message_id, session_id, sync_id, tool_name, category, tool_use_id,
         input_json, skill_name, result_content_length, result_content,
         subagent_session_id
  FROM tool_calls
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

export function readToolCalls(
  afterId: number,
  limit: number,
): { rows: ToolCallSyncRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db.prepare(TOOL_CALLS_SQL).all(afterId, limit) as Array<{
    id: number;
    message_id: number;
    session_id: string;
    sync_id: string | null;
    tool_name: string;
    category: string;
    tool_use_id: string | null;
    input_json: string | null;
    skill_name: string | null;
    result_content_length: number | null;
    result_content: string | null;
    subagent_session_id: string | null;
  }>;

  const rows: ToolCallSyncRecord[] = rawRows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    sessionId: r.session_id,
    syncId: r.sync_id,
    toolName: r.tool_name,
    category: r.category,
    toolUseId: r.tool_use_id,
    inputJson: r.input_json,
    skillName: r.skill_name,
    resultContentLength: r.result_content_length,
    resultContent: r.result_content,
    subagentSessionId: r.subagent_session_id,
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

// ── Sessions (by ID, no global watermark) ───────────────────────────────────

/**
 * Read specific sessions by ID for syncing.
 * Sessions don't use a global watermark — the sync loop finds which sessions
 * need syncing by comparing sessions.sync_seq against target_session_sync.
 */
export function readSessionsByIds(sessionIds: string[]): SessionSyncRecord[] {
  if (sessionIds.length === 0) return [];

  const db = getDb();
  const placeholders = sessionIds.map(() => "?").join(", ");

  const rawRows = db
    .prepare(
      `SELECT session_id, target, started_at_ms, ended_at_ms, cwd, first_prompt,
              permission_mode, agent_version,
              total_input_tokens, total_output_tokens, total_cache_read_tokens,
              total_cache_creation_tokens, total_reasoning_tokens, turn_count,
              models, summary, tool_counts, hook_tool_counts, event_type_counts, hook_event_type_counts, sync_seq,
              project, machine, message_count, user_message_count,
              parent_session_id, relationship_type, is_automated, created_at
       FROM sessions
       WHERE session_id IN (${placeholders})`,
    )
    .all(...sessionIds) as Array<{
    session_id: string;
    target: string | null;
    started_at_ms: number | null;
    ended_at_ms: number | null;
    cwd: string | null;
    first_prompt: string | null;
    permission_mode: string | null;
    agent_version: string | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_cache_read_tokens: number | null;
    total_cache_creation_tokens: number | null;
    total_reasoning_tokens: number | null;
    turn_count: number | null;
    models: string | null;
    summary: string | null;
    tool_counts: string | null;
    hook_tool_counts: string | null;
    event_type_counts: string | null;
    hook_event_type_counts: string | null;
    sync_seq: number;
    project: string | null;
    machine: string;
    message_count: number;
    user_message_count: number;
    parent_session_id: string | null;
    relationship_type: string;
    is_automated: number;
    created_at: number | null;
  }>;

  if (rawRows.length === 0) return [];

  const repoRows = db
    .prepare(
      `SELECT session_id, repository, first_seen_ms, git_user_name, git_user_email, branch
       FROM session_repositories
       WHERE session_id IN (${placeholders})`,
    )
    .all(...sessionIds) as Array<{
    session_id: string;
    repository: string;
    first_seen_ms: number;
    git_user_name: string | null;
    git_user_email: string | null;
    branch: string | null;
  }>;

  const cwdRows = db
    .prepare(
      `SELECT session_id, cwd, first_seen_ms
       FROM session_cwds
       WHERE session_id IN (${placeholders})`,
    )
    .all(...sessionIds) as Array<{
    session_id: string;
    cwd: string;
    first_seen_ms: number;
  }>;

  const reposBySession = new Map<string, SessionSyncRecord["repositories"]>();
  for (const r of repoRows) {
    const list = reposBySession.get(r.session_id) ?? [];
    list.push({
      repository: r.repository,
      firstSeenMs: r.first_seen_ms,
      gitUserName: r.git_user_name,
      gitUserEmail: r.git_user_email,
      branch: r.branch,
    });
    reposBySession.set(r.session_id, list);
  }

  const cwdsBySession = new Map<string, SessionSyncRecord["cwds"]>();
  for (const r of cwdRows) {
    const list = cwdsBySession.get(r.session_id) ?? [];
    list.push({ cwd: r.cwd, firstSeenMs: r.first_seen_ms });
    cwdsBySession.set(r.session_id, list);
  }

  return rawRows.map((r) => ({
    sessionId: r.session_id,
    target: r.target,
    startedAtMs: r.started_at_ms,
    endedAtMs: r.ended_at_ms,
    cwd: r.cwd,
    firstPrompt: r.first_prompt,
    permissionMode: r.permission_mode,
    agentVersion: r.agent_version,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    totalCacheReadTokens: r.total_cache_read_tokens,
    totalCacheCreationTokens: r.total_cache_creation_tokens,
    totalReasoningTokens: r.total_reasoning_tokens,
    turnCount: r.turn_count,
    models: r.models,
    summary: r.summary,
    toolCounts: parseJsonObject(r.tool_counts) as Record<string, number>,
    hookToolCounts: parseJsonObject(r.hook_tool_counts) as Record<
      string,
      number
    >,
    eventTypeCounts: parseJsonObject(r.event_type_counts) as Record<
      string,
      number
    >,
    hookEventTypeCounts: parseJsonObject(r.hook_event_type_counts) as Record<
      string,
      number
    >,
    project: r.project,
    machine: r.machine,
    messageCount: r.message_count,
    userMessageCount: r.user_message_count,
    parentSessionId: r.parent_session_id,
    relationshipType: r.relationship_type,
    isAutomated: r.is_automated === 1,
    createdAt: r.created_at,
    repositories: reposBySession.get(r.session_id) ?? [],
    cwds: cwdsBySession.get(r.session_id) ?? [],
  }));
}

// ── Per-session readers (for gated sync) ──────────────────────────────────

export function readSessionMessages(
  sessionId: string,
  afterId: number,
  limit: number,
): { rows: MessageSyncRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db
    .prepare(
      `SELECT id, session_id, ordinal, role, content, timestamp_ms,
              has_thinking, has_tool_use, content_length, is_system,
              model, token_usage, context_tokens, output_tokens,
              has_context_tokens, has_output_tokens
       FROM messages
       WHERE session_id = ? AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as Array<{
    id: number;
    session_id: string;
    ordinal: number;
    role: string;
    content: string;
    timestamp_ms: number | null;
    has_thinking: number;
    has_tool_use: number;
    content_length: number;
    is_system: number;
    model: string;
    token_usage: string;
    context_tokens: number;
    output_tokens: number;
    has_context_tokens: number;
    has_output_tokens: number;
  }>;

  const rows: MessageSyncRecord[] = rawRows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    ordinal: r.ordinal,
    role: r.role,
    content: r.content,
    timestampMs: r.timestamp_ms,
    hasThinking: r.has_thinking === 1,
    hasToolUse: r.has_tool_use === 1,
    contentLength: r.content_length,
    isSystem: r.is_system === 1,
    model: r.model,
    tokenUsage: r.token_usage,
    contextTokens: r.context_tokens,
    outputTokens: r.output_tokens,
    hasContextTokens: r.has_context_tokens === 1,
    hasOutputTokens: r.has_output_tokens === 1,
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

export function readSessionToolCalls(
  sessionId: string,
  afterId: number,
  limit: number,
): { rows: ToolCallSyncRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db
    .prepare(
      `SELECT id, message_id, session_id, sync_id, tool_name, category, tool_use_id,
              input_json, skill_name, result_content_length, result_content,
              subagent_session_id
       FROM tool_calls
       WHERE session_id = ? AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as Array<{
    id: number;
    message_id: number;
    session_id: string;
    sync_id: string | null;
    tool_name: string;
    category: string;
    tool_use_id: string | null;
    input_json: string | null;
    skill_name: string | null;
    result_content_length: number | null;
    result_content: string | null;
    subagent_session_id: string | null;
  }>;

  const rows: ToolCallSyncRecord[] = rawRows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    sessionId: r.session_id,
    syncId: r.sync_id,
    toolName: r.tool_name,
    category: r.category,
    toolUseId: r.tool_use_id,
    inputJson: r.input_json,
    skillName: r.skill_name,
    resultContentLength: r.result_content_length,
    resultContent: r.result_content,
    subagentSessionId: r.subagent_session_id,
  }));

  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

export function readSessionScannerTurns(
  sessionId: string,
  afterId: number,
  limit: number,
): { rows: ScannerTurnRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db
    .prepare(
      `SELECT t.id, t.session_id, t.sync_id, t.source, t.turn_index, t.timestamp_ms,
              t.model, t.role, t.content_preview,
              t.input_tokens, t.output_tokens, t.cache_read_tokens,
              t.cache_creation_tokens, t.reasoning_tokens,
              s.cli_version
       FROM scanner_turns t
       LEFT JOIN sessions s ON s.session_id = t.session_id
       WHERE t.session_id = ? AND t.id > ?
       ORDER BY t.id
       LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as Array<{
    id: number;
    session_id: string;
    sync_id: string | null;
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
    syncId: r.sync_id,
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

export function readSessionScannerEvents(
  sessionId: string,
  afterId: number,
  limit: number,
): { rows: ScannerEventRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db
    .prepare(
      `SELECT id, session_id, sync_id, source, event_type, timestamp_ms,
              tool_name, tool_input, tool_output, content, metadata
       FROM scanner_events
       WHERE session_id = ? AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as Array<{
    id: number;
    session_id: string;
    sync_id: string | null;
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
    syncId: r.sync_id,
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

export function readSessionHookEvents(
  sessionId: string,
  afterId: number,
  limit: number,
): { rows: HookEventRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db
    .prepare(
      `SELECT h.id, h.session_id, h.sync_id, h.event_type, h.timestamp_ms, h.cwd, h.repository,
              h.tool_name, decompress(h.payload) as payload,
              h.user_prompt, h.file_path, h.command, h.tool_result,
              s.target
       FROM hook_events h
       LEFT JOIN sessions s ON s.session_id = h.session_id
       WHERE h.session_id = ? AND h.id > ?
       ORDER BY h.id
       LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as Array<{
    id: number;
    session_id: string;
    sync_id: string | null;
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
    syncId: r.sync_id,
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

export function readSessionOtelLogs(
  sessionId: string,
  afterId: number,
  limit: number,
): { rows: OtelLogRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db
    .prepare(
      `SELECT id, sync_id, timestamp_ns, body, attributes, resource_attributes,
              severity_text, session_id, prompt_id, trace_id, span_id
       FROM otel_logs
       WHERE session_id = ? AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as RawOtelLogRow[];

  const rows = mapOtelRows(rawRows);
  const maxId = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return { rows, maxId };
}

export function readSessionOtelMetrics(
  sessionId: string,
  afterId: number,
  limit: number,
): { rows: MetricRow[]; maxId: number } {
  const db = getDb();
  const rawRows = db
    .prepare(
      `SELECT id, sync_id, timestamp_ns, name, value, metric_type, unit,
              attributes, resource_attributes, session_id
       FROM otel_metrics
       WHERE session_id = ? AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as Array<{
    id: number;
    sync_id: string | null;
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
    syncId: r.sync_id,
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

export function readSessionOtelSpans(
  sessionId: string,
  afterId: number,
  limit: number,
): { rows: OtelSpanRecord[]; maxId: number } {
  const db = getDb();
  const rawRows = db
    .prepare(
      `SELECT id, trace_id, span_id, parent_span_id, name, kind,
              start_time_ns, end_time_ns, status_code, status_message,
              attributes, resource_attributes, session_id
       FROM otel_spans
       WHERE session_id = ? AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as Array<{
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

/** Map of table name → per-session reader for gated sync. */
export const SESSION_READERS: Record<
  string,
  (
    sessionId: string,
    afterId: number,
    limit: number,
  ) => { rows: unknown[]; maxId: number }
> = {
  messages: readSessionMessages,
  tool_calls: readSessionToolCalls,
  scanner_turns: readSessionScannerTurns,
  scanner_events: readSessionScannerEvents,
  hook_events: readSessionHookEvents,
  otel_logs: readSessionOtelLogs,
  otel_metrics: readSessionOtelMetrics,
  otel_spans: readSessionOtelSpans,
};
