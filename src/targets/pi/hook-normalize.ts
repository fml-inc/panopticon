import { gunzipSync } from "node:zlib";

import { getDb } from "../../db/schema.js";
import { updateSessionMessageCounts, upsertSession } from "../../db/store.js";

function nextMessageOrdinal(sessionId: string): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
       FROM messages
       WHERE session_id = ?`,
    )
    .get(sessionId) as { ordinal: number };
  return row.ordinal;
}

function insertMessageFromHook(args: {
  sessionId: string;
  role: string;
  content: string;
  timestampMs: number;
  hasToolUse?: boolean;
  hasThinking?: boolean;
  syncId: string;
  model?: string;
  tokenUsage?: string;
  contextTokens?: number;
  outputTokens?: number;
}): void {
  const db = getDb();
  const ordinal = nextMessageOrdinal(args.sessionId);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO messages
        (session_id, ordinal, role, content, timestamp_ms,
         has_thinking, has_tool_use, content_length, is_system,
         model, token_usage, context_tokens, output_tokens,
         has_context_tokens, has_output_tokens, uuid, parent_uuid, sync_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.sessionId,
      ordinal,
      args.role,
      args.content,
      args.timestampMs,
      args.hasThinking ? 1 : 0,
      args.hasToolUse ? 1 : 0,
      args.content.length,
      0,
      args.model ?? "",
      args.tokenUsage ?? "",
      args.contextTokens ?? 0,
      args.outputTokens ?? 0,
      args.contextTokens == null ? 0 : 1,
      args.outputTokens == null ? 0 : 1,
      `hook:${args.syncId}`,
      null,
      `hook:${args.syncId}`,
    );
  if (result.changes > 0) {
    const { id } = db.prepare("SELECT last_insert_rowid() as id").get() as {
      id: number;
    };
    db.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)").run(
      id,
      args.content,
    );
  }
}

function piToolUseSummary(toolName: string | null, toolInput: unknown): string {
  if (!toolName) return "[tool]";
  let label = "";
  if (toolInput && typeof toolInput === "object") {
    const input = toolInput as Record<string, unknown>;
    const value =
      input.path ??
      input.file_path ??
      input.command ??
      input.pattern ??
      input.query ??
      input.prompt;
    if (typeof value === "string") label = value;
  }
  return label ? `[${toolName}: ${label}]` : `[${toolName}]`;
}

function extractPiAssistantContent(message: unknown): {
  text: string;
  hasThinking: boolean;
} | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return null;
  const content = record.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  let hasThinking = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    if (b.type === "thinking") {
      hasThinking = true;
      if (typeof b.thinking === "string") {
        parts.push(`[Thinking]\n${b.thinking}\n[/Thinking]`);
      }
    }
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? { text, hasThinking } : null;
}

interface PiTokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: unknown;
}

function readNonNegativeNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function extractPiTokenUsage(message: unknown): PiTokenUsage | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return null;
  const usage = record.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = readNonNegativeNumber(u, ["input", "input_tokens"]);
  const output = readNonNegativeNumber(u, ["output", "output_tokens"]);
  if (input == null || output == null) return null;
  const result: PiTokenUsage = { input, output };
  const cacheRead = readNonNegativeNumber(u, [
    "cacheRead",
    "cache_read_input_tokens",
  ]);
  const cacheWrite = readNonNegativeNumber(u, [
    "cacheWrite",
    "cache_creation_input_tokens",
  ]);
  const totalTokens = readNonNegativeNumber(u, ["totalTokens", "total_tokens"]);
  if (cacheRead != null) result.cacheRead = cacheRead;
  if (cacheWrite != null) result.cacheWrite = cacheWrite;
  if (totalTokens != null) result.totalTokens = totalTokens;
  if (u.cost != null) result.cost = u.cost;
  return result;
}

function refreshPiHookTokenTotals(sessionId: string): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT token_usage
       FROM messages
       WHERE session_id = ?
         AND role = 'assistant'
         AND token_usage != ''`,
    )
    .all(sessionId) as Array<{ token_usage: string }>;
  if (rows.length === 0) return;

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const row of rows) {
    const usage = JSON.parse(row.token_usage) as PiTokenUsage;
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
  }
  upsertSession({
    session_id: sessionId,
    target: "pi",
    total_input_tokens: input,
    total_output_tokens: output,
    total_cache_read_tokens: cacheRead,
    total_cache_creation_tokens: cacheWrite,
    has_hooks: 1,
  });
}

export function insertPiHookMessageFromEvent(hookEventId: number): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, session_id, event_type, timestamp_ms, tool_name,
              user_prompt, payload, sync_id
       FROM hook_events
       WHERE id = ? AND target = 'pi'`,
    )
    .get(hookEventId) as
    | {
        id: number;
        session_id: string;
        event_type: string;
        timestamp_ms: number;
        tool_name: string | null;
        user_prompt: string | null;
        payload: Uint8Array;
        sync_id: string;
      }
    | undefined;
  if (!row) return false;

  const existing = db
    .prepare(`SELECT 1 FROM messages WHERE sync_id = ? LIMIT 1`)
    .get(`hook:${row.sync_id}`);
  if (existing) return false;

  if (row.event_type === "UserPromptSubmit") {
    const content = row.user_prompt?.trim() ? row.user_prompt : null;
    if (!content) return false;
    insertMessageFromHook({
      sessionId: row.session_id,
      role: "user",
      content,
      timestampMs: row.timestamp_ms,
      syncId: row.sync_id,
    });
    updateSessionMessageCounts(row.session_id);
    return true;
  }

  if (row.event_type === "PreToolUse") {
    const data = JSON.parse(gunzipSync(row.payload).toString("utf8")) as Record<
      string,
      unknown
    >;
    insertMessageFromHook({
      sessionId: row.session_id,
      role: "assistant",
      content: piToolUseSummary(row.tool_name, data.tool_input),
      timestampMs: row.timestamp_ms,
      hasToolUse: true,
      syncId: row.sync_id,
    });
    updateSessionMessageCounts(row.session_id);
    return true;
  }

  if (row.event_type === "Stop") {
    const data = JSON.parse(gunzipSync(row.payload).toString("utf8")) as Record<
      string,
      unknown
    >;
    const assistantMessage = data.assistant_message;
    const content = extractPiAssistantContent(assistantMessage);
    if (!content) return false;
    const usage = extractPiTokenUsage(assistantMessage);
    const model =
      assistantMessage &&
      typeof assistantMessage === "object" &&
      typeof (assistantMessage as Record<string, unknown>).model === "string"
        ? ((assistantMessage as Record<string, unknown>).model as string)
        : undefined;
    insertMessageFromHook({
      sessionId: row.session_id,
      role: "assistant",
      content: content.text,
      timestampMs: row.timestamp_ms,
      hasThinking: content.hasThinking,
      syncId: row.sync_id,
      model,
      tokenUsage: usage ? JSON.stringify(usage) : undefined,
      contextTokens: usage
        ? usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
        : undefined,
      outputTokens: usage?.output,
    });
    updateSessionMessageCounts(row.session_id);
    if (usage) refreshPiHookTokenTotals(row.session_id);
    return true;
  }

  return false;
}

function stringifyToolResult(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function readToolCallId(data: Record<string, unknown>): string | null {
  const value = data.tool_call_id ?? data.toolCallId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolvePiPreToolUseForPost(args: {
  sessionId: string;
  toolName: string;
  postHookId: number;
  toolCallId: string | null;
}): { id: number; timestamp_ms: number; sync_id: string } | undefined {
  const db = getDb();
  if (args.toolCallId) {
    const exact = db
      .prepare(
        `SELECT id, timestamp_ms, sync_id
         FROM hook_events
         WHERE session_id = ?
           AND target = 'pi'
           AND event_type = 'PreToolUse'
           AND tool_name = ?
           AND id < ?
           AND (
             json_extract(decompress(payload), '$.tool_call_id') = ?
             OR json_extract(decompress(payload), '$.toolCallId') = ?
           )
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(
        args.sessionId,
        args.toolName,
        args.postHookId,
        args.toolCallId,
        args.toolCallId,
      ) as { id: number; timestamp_ms: number; sync_id: string } | undefined;
    return exact;
  }

  return db
    .prepare(
      `SELECT id, timestamp_ms, sync_id
       FROM hook_events
       WHERE session_id = ?
         AND target = 'pi'
         AND event_type = 'PreToolUse'
         AND tool_name = ?
         AND id < ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(args.sessionId, args.toolName, args.postHookId) as
    | { id: number; timestamp_ms: number; sync_id: string }
    | undefined;
}

function resolvePiToolCallMessageId(args: {
  sessionId: string;
  preHookSyncId: string | null;
}): number | null {
  if (!args.preHookSyncId) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id
       FROM messages
       WHERE session_id = ? AND sync_id = ?
       LIMIT 1`,
    )
    .get(args.sessionId, `hook:${args.preHookSyncId}`) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

/** Normalize hook-only Pi post-result events into tool_calls. */
export function insertPiHookToolCallFromPostEvent(hookEventId: number): void {
  const db = getDb();
  const post = db
    .prepare(
      `SELECT id, session_id, timestamp_ms, tool_name, payload, sync_id
       FROM hook_events
       WHERE id = ?
         AND target = 'pi'
         AND event_type IN ('PostToolUse', 'PostToolUseFailure')`,
    )
    .get(hookEventId) as
    | {
        id: number;
        session_id: string;
        timestamp_ms: number;
        tool_name: string | null;
        payload: Uint8Array;
        sync_id: string;
      }
    | undefined;
  if (!post?.tool_name) return;

  const existing = db
    .prepare(`SELECT 1 FROM tool_calls WHERE sync_id = ? LIMIT 1`)
    .get(`hook:${post.sync_id}`);
  if (existing) return;

  const data = JSON.parse(gunzipSync(post.payload).toString("utf8")) as Record<
    string,
    unknown
  >;
  const input = data.tool_input as Record<string, unknown> | undefined;
  const resultContent = stringifyToolResult(
    data.tool_result ?? data.tool_response,
  );
  const toolCallId = readToolCallId(data);
  const pre = resolvePiPreToolUseForPost({
    sessionId: post.session_id,
    toolName: post.tool_name,
    postHookId: post.id,
    toolCallId,
  });
  const messageId = resolvePiToolCallMessageId({
    sessionId: post.session_id,
    preHookSyncId: pre?.sync_id ?? null,
  });
  if (messageId == null) return;

  const callIndex = (
    db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM tool_calls
         WHERE message_id = ?`,
      )
      .get(messageId) as { c: number }
  ).c;

  db.prepare(
    `INSERT INTO tool_calls
      (message_id, session_id, call_index, tool_name, category, tool_use_id,
       input_json, skill_name, result_content_length, result_content,
       subagent_session_id, duration_ms, sync_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    post.session_id,
    callIndex,
    post.tool_name,
    "hook",
    toolCallId,
    input ? JSON.stringify(input) : null,
    null,
    resultContent?.length ?? null,
    resultContent,
    null,
    pre ? Math.max(0, post.timestamp_ms - pre.timestamp_ms) : null,
    `hook:${post.sync_id}`,
  );
}
