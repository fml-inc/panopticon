/**
 * Hermes Agent target adapter.
 *
 * Panopticon observes Hermes through a user-installed Hermes plugin. The
 * plugin runs in the Hermes Python process, receives native observer kwargs,
 * and posts Panopticon-shaped hook events to the local server.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/driver.js";
import type { HookInput } from "../hooks/ingest.js";
import { defaultToolCategory } from "../scanner/categories.js";
import { registerTarget } from "./registry.js";
import type { ParsedToolCall, ParseResult, TargetAdapter } from "./types.js";

const PLUGIN_NAME = "panopticon-observer";
const STRUCTURED_JSON_PREFIX = "\0json:";
const MAX_STRUCTURED_CONTENT_DEPTH = 16;

const HERMES_OBSERVER_HOOKS = [
  "on_session_start",
  "on_session_end",
  "on_session_finalize",
  "on_session_reset",
  "pre_llm_call",
  "post_llm_call",
  "pre_api_request",
  "post_api_request",
  "api_request_error",
  "pre_tool_call",
  "post_tool_call",
  "pre_approval_request",
  "post_approval_response",
  "subagent_start",
  "subagent_stop",
] as const;

const PLUGIN_YAML = `name: ${PLUGIN_NAME}
version: "0.2.0"
description: "Streams Hermes observer hooks to local Panopticon."
author: FML
hooks:
${HERMES_OBSERVER_HOOKS.map((hook) => `  - ${hook}`).join("\n")}
`;

/**
 * The plugin's Python source ships as a build asset at
 * <pluginRoot>/dist/targets/hermes/plugin.py (copied from
 * src/targets/hermes/plugin.py by scripts/copy-hermes-plugin.js).
 * Resolved from pluginRoot for the same reason as the Pi extension:
 * tsup's ESM __dirname shim resolves to the shared chunk's location,
 * not this file's.
 */
function getPluginSource(pluginRoot: string): string | null {
  const pluginPath = path.join(
    pluginRoot,
    "dist",
    "targets",
    "hermes",
    "plugin.py",
  );
  try {
    return fs.readFileSync(pluginPath, "utf-8");
  } catch (err) {
    // Only swallow "not found" — re-raise EACCES/EISDIR/etc. so real I/O
    // problems surface instead of masquerading as "run pnpm build first".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function hermesDir(): string {
  return process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes");
}

function pluginDest(): string {
  return path.join(hermesDir(), "plugins", PLUGIN_NAME);
}

function stateDbPath(): string {
  return path.join(hermesDir(), "state.db");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000
      ? Math.round(value * 1000)
      : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampMs(numeric);
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringifyJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function textFromStructuredContent(value: unknown, depth = 0): string {
  if (depth > MAX_STRUCTURED_CONTENT_DEPTH) {
    return typeof value === "string" ? value : (stringifyJson(value) ?? "");
  }
  if (value == null) return "";
  if (typeof value === "string") {
    if (value.startsWith(STRUCTURED_JSON_PREFIX)) {
      return textFromStructuredContent(
        value.slice(STRUCTURED_JSON_PREFIX.length),
        depth + 1,
      );
    }
    const parsed = parseJson(value);
    return parsed === value
      ? value
      : textFromStructuredContent(parsed, depth + 1);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromStructuredContent(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["text", "content", "message", "output", "result"]) {
    if (key in record) {
      const text = textFromStructuredContent(record[key], depth + 1);
      if (text) return text;
    }
  }
  return stringifyJson(record) ?? "";
}

function toolWords(toolName: string): Set<string> {
  return new Set(
    toolName
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

function hasToolWord(words: Set<string>, ...matches: string[]): boolean {
  return matches.some((word) => words.has(word));
}

function hermesToolCategory(toolName: string): string {
  const words = toolWords(toolName);
  if (hasToolWord(words, "read")) return "Read";
  if (hasToolWord(words, "edit", "patch")) return "Edit";
  if (hasToolWord(words, "write", "create")) return "Write";
  if (hasToolWord(words, "bash", "shell", "terminal", "command")) return "Bash";
  if (hasToolWord(words, "grep", "search")) return "Grep";
  if (hasToolWord(words, "glob", "list")) return "Glob";
  if (hasToolWord(words, "web", "fetch")) return "Web";
  if (hasToolWord(words, "delegate", "subagent")) return "Task";
  return defaultToolCategory(toolName);
}

function extractToolCall(
  raw: unknown,
  fallbackId: string,
): ParsedToolCall | null {
  const call = asRecord(raw);
  if (!call) return null;
  const fn = asRecord(call.function);
  const toolName =
    (typeof call.name === "string" && call.name) ||
    (typeof fn?.name === "string" && fn.name) ||
    (typeof call.tool_name === "string" && call.tool_name) ||
    "";
  if (!toolName) return null;
  const rawArgs = fn?.arguments ?? call.arguments ?? call.args ?? call.input;
  const input =
    typeof rawArgs === "string" ? parseJson(rawArgs) : (rawArgs ?? {});
  return {
    toolUseId:
      (typeof call.id === "string" && call.id) ||
      (typeof call.tool_call_id === "string" && call.tool_call_id) ||
      fallbackId,
    toolName,
    category: hermesToolCategory(toolName),
    inputJson: stringifyJson(input),
  };
}

function writePluginFiles(opts: { pluginRoot: string; port: number }): void {
  const pluginSource = getPluginSource(opts.pluginRoot);
  if (!pluginSource) {
    throw new Error(
      `panopticon: Hermes plugin source not found at ${path.join(opts.pluginRoot, "dist", "targets", "hermes", "plugin.py")}. ` +
        "Run 'pnpm build' first.",
    );
  }
  const dest = pluginDest();
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "plugin.yaml"), PLUGIN_YAML);
  fs.writeFileSync(path.join(dest, "__init__.py"), pluginSource);
  fs.writeFileSync(
    path.join(dest, "panopticon.json"),
    `${JSON.stringify(
      {
        host: "127.0.0.1",
        port: opts.port,
        request_timeout_ms: 3000,
        start_command: [
          process.execPath,
          path.join(opts.pluginRoot, "bin", "panopticon"),
          "start",
          "--force",
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

/**
 * Hermes owns config.yaml and rewrites it wholesale on every save (plain
 * PyYAML dump — it does not preserve comments or formatting). Panopticon must
 * therefore never write that file directly; instead we drive hermes's own CLI
 * for the plugin allow-list. Returns whether the command succeeded so callers
 * can fall back to a printed instruction when the `hermes` binary is absent.
 */
function runHermesCli(args: string[]): { ok: boolean; output: string } {
  const bin = process.env.HERMES_BIN ?? "hermes";
  try {
    const res = spawnSync(bin, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.error) return { ok: false, output: String(res.error.message) };
    return {
      ok: res.status === 0,
      output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim(),
    };
  } catch (err) {
    return { ok: false, output: String((err as Error).message) };
  }
}

/** The `hermes mcp add` command the user runs to register the MCP server. */
function mcpAddCommand(pluginRoot: string): string {
  const serverBin = path.join(pluginRoot, "bin", "mcp-server");
  return `hermes mcp add panopticon --command ${process.execPath} --args ${serverBin}`;
}

function normalizeHermesPayload(data: HookInput): HookInput {
  const record = data as Record<string, unknown>;
  if (typeof record.user_message === "string") {
    record.prompt ??= record.user_message;
    record.user_prompt ??= record.user_message;
  }
  if (!data.tool_input && asRecord(record.args)) {
    data.tool_input = record.args as Record<string, unknown>;
  }
  if (!data.tool_name && typeof record.command === "string") {
    data.tool_name = "Bash";
    data.tool_input = {
      ...(data.tool_input ?? {}),
      command: record.command,
    };
  }
  if (typeof record.child_session_id === "string" && !record.agent_id) {
    record.agent_id = record.child_session_id;
  } else if (typeof record.child_subagent_id === "string" && !record.agent_id) {
    record.agent_id = record.child_subagent_id;
  }
  return data;
}

interface HermesSessionRow {
  id: string;
  parent_session_id?: string | null;
  source?: string | null;
  model?: string | null;
  started_at?: number | string | null;
  ended_at?: number | string | null;
  cwd?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  title?: string | null;
}

interface HermesMessageRow {
  id: number;
  session_id: string;
  role: string;
  content?: string | null;
  content_hex?: string | null;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  tool_name?: string | null;
  timestamp?: number | string | null;
  token_count?: number | null;
  reasoning?: string | null;
  reasoning_hex?: string | null;
  reasoning_content?: string | null;
  reasoning_content_hex?: string | null;
  reasoning_details?: string | null;
  reasoning_details_hex?: string | null;
  active?: number | null;
}

// Re-snapshot sessions whose most recent message is within this window even
// when no new message rows arrived, so late session-aggregate token updates
// (hermes records usage via a separate UPDATE after the assistant message is
// already written — see set_session_usage) are not missed. Comfortably larger
// than the 60s scan cadence so a token finalization between two scans is
// always re-read, while idle/old sessions stay excluded (no resync churn).
const RECENT_ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

const SESSION_COLUMNS = `id, parent_session_id, source, model, started_at, ended_at, cwd,
                input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, reasoning_tokens, title`;

const MESSAGE_COLUMNS = `id, session_id, role,
                content, hex(content) AS content_hex,
                tool_call_id, tool_calls, tool_name, timestamp, token_count,
                reasoning, hex(reasoning) AS reasoning_hex,
                reasoning_content, hex(reasoning_content) AS reasoning_content_hex,
                reasoning_details, hex(reasoning_details) AS reasoning_details_hex,
                active`;

function parseHermesStateDb(
  filePath: string,
  fromWatermark: number,
): ParseResult | null {
  let db: Database;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }

  try {
    const maxMessageId =
      (
        db
          .prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages")
          .get() as { max_id: number }
      ).max_id ?? 0;

    // Sessions active within the recency window must be re-snapshotted even
    // with no new messages, to capture late aggregate-token updates. Hermes
    // timestamps are epoch seconds (time.time()); ms-valued rows compare as
    // far-future and are simply always included (harmless re-snapshot).
    const recentThresholdSec = (Date.now() - RECENT_ACTIVITY_WINDOW_MS) / 1000;
    const recentlyActiveIds = (
      db
        .prepare(
          `SELECT session_id FROM messages
            WHERE timestamp >= ?
            GROUP BY session_id`,
        )
        .all(recentThresholdSec) as Array<{ session_id: string }>
    ).map((r) => r.session_id);

    if (maxMessageId === fromWatermark && recentlyActiveIds.length === 0) {
      return null;
    }

    // fromWatermark > maxMessageId means state.db was pruned or recreated;
    // fall through to a full re-snapshot (the upserts below are idempotent).
    const incremental = fromWatermark > 0 && maxMessageId > fromWatermark;
    const fullScan = fromWatermark === 0 || maxMessageId < fromWatermark;

    // Each selected session is emitted as a FULL snapshot of that session
    // (absolute indices, INSERT OR IGNORE/upsert dedupes downstream). Full
    // scans cover every session; otherwise we snapshot the union of sessions
    // with new messages and recently-active sessions (token-only updates).
    let targetIds: string[] | null = null;
    if (!fullScan) {
      const changedIds = incremental
        ? (
            db
              .prepare(`SELECT DISTINCT session_id FROM messages WHERE id > ?`)
              .all(fromWatermark) as Array<{ session_id: string }>
          ).map((r) => r.session_id)
        : [];
      targetIds = [...new Set([...changedIds, ...recentlyActiveIds])];
      if (targetIds.length === 0) return null;
    }

    const idPlaceholders = targetIds?.map(() => "?").join(", ");
    const sessions = (
      targetIds
        ? db
            .prepare(
              `SELECT ${SESSION_COLUMNS} FROM sessions
                WHERE id IN (${idPlaceholders})
                ORDER BY COALESCE(started_at, 0), id`,
            )
            .all(...targetIds)
        : db
            .prepare(
              `SELECT ${SESSION_COLUMNS} FROM sessions
                ORDER BY COALESCE(started_at, 0), id`,
            )
            .all()
    ) as HermesSessionRow[];

    const messages = (
      targetIds
        ? db
            .prepare(
              `SELECT ${MESSAGE_COLUMNS} FROM messages
                WHERE COALESCE(active, 1) = 1
                  AND session_id IN (${idPlaceholders})
                ORDER BY session_id, id`,
            )
            .all(...targetIds)
        : db
            .prepare(
              `SELECT ${MESSAGE_COLUMNS} FROM messages
                WHERE COALESCE(active, 1) = 1
                ORDER BY session_id, id`,
            )
            .all()
    ) as HermesMessageRow[];
    const bySession = new Map<string, HermesMessageRow[]>();
    for (const message of messages) {
      const rows = bySession.get(message.session_id) ?? [];
      rows.push(message);
      bySession.set(message.session_id, rows);
    }

    // Emit a result for every session that has a metadata row OR new
    // messages, ordered by the sessions table first. Synthesizing a minimal
    // row for a message-only session (its sessions row is missing or hasn't
    // been written yet) guarantees the watermark advances past those
    // messages — otherwise a session_id present in messages but absent from
    // `sessions` would make every scan re-query the same rows forever.
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const session of sessions) {
      if (!seen.has(session.id)) {
        seen.add(session.id);
        orderedIds.push(session.id);
      }
    }
    for (const sessionId of bySession.keys()) {
      if (!seen.has(sessionId)) {
        seen.add(sessionId);
        orderedIds.push(sessionId);
      }
    }
    if (orderedIds.length === 0) return null;

    const results = orderedIds.map((sessionId) =>
      parseHermesSession(
        byId.get(sessionId) ?? { id: sessionId },
        bySession.get(sessionId) ?? [],
        maxMessageId,
      ),
    );
    const [first, ...rest] = results;
    if (!first) return null;
    first.forks = rest;
    return first;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function decodeSqlText(value: unknown, hexValue: unknown): string {
  if (typeof hexValue === "string" && hexValue.length > 0) {
    try {
      return Buffer.from(hexValue, "hex").toString("utf8");
    } catch {}
  }
  return typeof value === "string" ? value : "";
}

function parseHermesSession(
  session: HermesSessionRow,
  messages: HermesMessageRow[],
  newWatermark: number,
): ParseResult {
  const turns: ParseResult["turns"] = [];
  const events: ParseResult["events"] = [];
  const parsedMessages: ParseResult["messages"] = [];
  const orphanedToolResults = new Map<
    string,
    { contentLength: number; contentRaw: string; timestampMs?: number }
  >();
  const startedAtMs = timestampMs(session.started_at);
  let firstPrompt: string | undefined;
  let ordinal = 0;
  let turnIndex = 0;
  let lastAssistantTurnIndex = -1;
  // Messages are ordered by rowid (chronological). When a message has no
  // timestamp, inherit the most recent known time (or session start) rather
  // than the rowid — a rowid as epoch-ms would render as 1970.
  let lastTsMs = startedAtMs ?? 0;

  for (const message of messages) {
    const tsMs = timestampMs(message.timestamp) ?? lastTsMs;
    lastTsMs = tsMs;
    const role = message.role;
    const content = textFromStructuredContent(
      decodeSqlText(message.content, message.content_hex),
    );
    const reasoning = [
      decodeSqlText(message.reasoning, message.reasoning_hex),
      decodeSqlText(message.reasoning_content, message.reasoning_content_hex),
      decodeSqlText(message.reasoning_details, message.reasoning_details_hex),
    ]
      .map((value) => textFromStructuredContent(value))
      .filter(Boolean)
      .join("\n");
    const hasThinking = reasoning.length > 0;

    if (role === "user") {
      if (!firstPrompt && content) firstPrompt = content.slice(0, 200);
      parsedMessages.push({
        sessionId: session.id,
        ordinal: ordinal++,
        role: "user",
        content,
        timestampMs: tsMs,
        hasThinking: false,
        hasToolUse: false,
        isSystem: false,
        contentLength: content.length,
        hasContextTokens: false,
        hasOutputTokens: false,
        toolCalls: [],
        toolResults: new Map(),
      });
      turns.push({
        sessionId: session.id,
        turnIndex: turnIndex++,
        timestampMs: tsMs,
        role: "user",
        contentPreview: content.slice(0, 200),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      });
      continue;
    }

    if (role === "assistant") {
      const rawToolCalls = parseJson(message.tool_calls);
      const toolCalls = asArray(rawToolCalls)
        .map((call, index) =>
          extractToolCall(call, `${session.id}:${message.id}:${index}`),
        )
        .filter((call): call is ParsedToolCall => call !== null);
      for (const toolCall of toolCalls) {
        toolCall.timestampMs = tsMs;
        events.push({
          sessionId: session.id,
          eventType: "tool_call",
          timestampMs: tsMs,
          eventIndex: events.length,
          toolName: toolCall.toolName,
          toolInput: toolCall.inputJson?.slice(0, 10_000),
          metadata: { tool_call_id: toolCall.toolUseId },
        });
      }
      const fullContent = [
        content,
        reasoning ? `[Thinking]\n${reasoning}\n[/Thinking]` : "",
      ]
        .filter(Boolean)
        .join("\n");
      parsedMessages.push({
        sessionId: session.id,
        ordinal: ordinal++,
        role: "assistant",
        content: fullContent,
        timestampMs: tsMs,
        hasThinking,
        hasToolUse: toolCalls.length > 0,
        isSystem: false,
        contentLength: fullContent.length,
        model: session.model ?? undefined,
        tokenUsage:
          typeof message.token_count === "number"
            ? stringifyJson({ token_count: message.token_count })
            : undefined,
        contextTokens: undefined,
        outputTokens:
          typeof message.token_count === "number"
            ? message.token_count
            : undefined,
        hasContextTokens: false,
        hasOutputTokens: typeof message.token_count === "number",
        toolCalls,
        toolResults: new Map(),
      });
      turns.push({
        sessionId: session.id,
        turnIndex: turnIndex++,
        timestampMs: tsMs,
        role: "assistant",
        model: session.model ?? undefined,
        contentPreview: fullContent.slice(0, 200),
        // All per-turn token fields are 0: hermes only exposes a
        // session-level aggregate, applied below to the last assistant turn.
        // SUM(output_tokens) over the session must equal that aggregate, so we
        // must NOT seed per-turn tokens from message.token_count here — if
        // hermes ever populates it on non-last messages, doing so would make
        // SUM = Σ(token_count) + aggregate and double-count. (message.token_count
        // is still surfaced as per-message display metadata above.)
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      });
      lastAssistantTurnIndex = turns.length - 1;
      continue;
    }

    if (role === "tool" || role === "toolResult") {
      const toolCallId = message.tool_call_id;
      if (toolCallId) {
        orphanedToolResults.set(toolCallId, {
          contentLength: content.length,
          contentRaw: content,
          timestampMs: tsMs,
        });
      }
      events.push({
        sessionId: session.id,
        eventType: "tool_result",
        timestampMs: tsMs,
        eventIndex: events.length,
        toolName: message.tool_name ?? undefined,
        toolOutput: content.slice(0, 10_000),
        metadata: { tool_call_id: toolCallId },
      });
    }
  }

  const aggregateInput = session.input_tokens ?? 0;
  const aggregateOutput = session.output_tokens ?? 0;
  const aggregateCacheRead = session.cache_read_tokens ?? 0;
  const aggregateCacheWrite = session.cache_write_tokens ?? 0;
  const aggregateReasoning = session.reasoning_tokens ?? 0;
  if (
    lastAssistantTurnIndex >= 0 &&
    (aggregateInput > 0 ||
      aggregateOutput > 0 ||
      aggregateCacheRead > 0 ||
      aggregateCacheWrite > 0 ||
      aggregateReasoning > 0)
  ) {
    const turn = turns[lastAssistantTurnIndex];
    turn.inputTokens = aggregateInput;
    turn.outputTokens = aggregateOutput;
    turn.cacheReadTokens = aggregateCacheRead;
    turn.cacheCreationTokens = aggregateCacheWrite;
    turn.reasoningTokens = aggregateReasoning;
  }

  const meta: ParseResult["meta"] = {
    sessionId: session.id,
    parentSessionId: session.parent_session_id ?? undefined,
    relationshipType: session.parent_session_id ? "subagent" : undefined,
    model: session.model ?? undefined,
    cwd: session.cwd ?? undefined,
    startedAtMs,
    firstPrompt: firstPrompt ?? session.title ?? undefined,
  };

  return {
    meta,
    turns,
    events,
    messages: parsedMessages,
    newByteOffset: newWatermark,
    absoluteIndices: true,
    orphanedToolResults:
      orphanedToolResults.size > 0 ? orphanedToolResults : undefined,
  };
}

const hermes: TargetAdapter = {
  id: "hermes",

  config: {
    get dir() {
      return hermesDir();
    },
    get configPath() {
      return path.join(hermesDir(), "config.yaml");
    },
    configFormat: "yaml",
    // Hermes rewrites config.yaml wholesale on every save, so panopticon never
    // touches that file. The hooks below drive hermes's own CLI instead.
    selfManagedConfig: true,
  },

  hooks: {
    events: [...HERMES_OBSERVER_HOOKS],

    applyInstallConfig(existing, opts) {
      writePluginFiles({ pluginRoot: opts.pluginRoot, port: opts.port });
      // Enable the plugin through hermes's own CLI so hermes owns the write
      // to its config.yaml allow-list. Fall back to a printed instruction
      // when the hermes binary isn't reachable.
      const enable = runHermesCli(["plugins", "enable", PLUGIN_NAME]);
      if (!enable.ok) {
        console.log(
          `      Could not auto-enable the plugin (${enable.output || "hermes CLI not found on PATH"}).\n` +
            `      Activate it manually with: hermes plugins enable ${PLUGIN_NAME}`,
        );
      }
      // MCP registration is a separate interactive hermes wizard (it connects
      // to the server and prompts for tool selection), so we can't script it.
      // Print the command for the user to run; it lets hermes sessions query
      // their own panopticon history/costs and is optional.
      console.log(
        "      Optional — let Hermes query its own history/costs by running:\n" +
          `      ${mcpAddCommand(opts.pluginRoot)}`,
      );
      return existing;
    },

    removeInstallConfig(existing) {
      const disable = runHermesCli(["plugins", "disable", PLUGIN_NAME]);
      if (!disable.ok) {
        console.log(
          `      Could not auto-disable the plugin. Disable it manually with: hermes plugins disable ${PLUGIN_NAME}`,
        );
      }
      fs.rmSync(pluginDest(), { recursive: true, force: true });
      console.log(
        "      If you registered the MCP server, remove it with: hermes mcp remove panopticon",
      );
      return existing;
    },
  },

  shellEnv: {
    envVars(port) {
      return [
        ["PANOPTICON_HOST", "127.0.0.1"],
        ["PANOPTICON_PORT", String(port)],
      ];
    },
  },

  events: {
    // The installed plugin emits canonical Panopticon hook names directly.
    // Native Hermes names are mapped too so hand-crafted test events and older
    // plugin builds still normalize correctly.
    eventMap: {
      on_session_start: "SessionStart",
      on_session_finalize: "SessionEnd",
      on_session_reset: "SessionEnd",
      // Despite the name, pre_llm_call/post_llm_call fire once per user turn,
      // not once per LLM API request: hermes invokes them from
      // build_turn_context / turn_finalizer around run_conversation (one call
      // per user message), carrying original_user_message and the final
      // assistant_response — not inside the tool-continuation loop. So this 1:1
      // mapping to UserPromptSubmit/Stop does not over-count prompts.
      pre_llm_call: "UserPromptSubmit",
      post_llm_call: "Stop",
      api_request_error: "StopFailure",
      pre_tool_call: "PreToolUse",
      post_tool_call: "PostToolUse",
      pre_approval_request: "PermissionRequest",
      subagent_start: "SubagentStart",
      subagent_stop: "SubagentStop",
    },

    normalizePayload: normalizeHermesPayload,

    resolveSubagentSessionFromHook({ sessionId, data }) {
      const childSessionId =
        typeof data.child_session_id === "string" ? data.child_session_id : "";
      if (!childSessionId) return null;
      return {
        sessionId: childSessionId,
        parentSessionId:
          typeof data.parent_session_id === "string"
            ? data.parent_session_id
            : sessionId,
        relationshipType: "subagent",
      };
    },

    formatPermissionResponse(eventName, { allow, reason }) {
      if (eventName !== "PreToolUse") return {};
      return allow ? {} : { action: "block", message: reason };
    },
  },

  detect: {
    displayName: "Hermes Agent",
    isInstalled: () => fs.existsSync(hermesDir()),
    isConfigured() {
      if (!fs.existsSync(path.join(pluginDest(), "__init__.py"))) return false;
      try {
        const raw = fs.readFileSync(
          path.join(hermesDir(), "config.yaml"),
          "utf-8",
        );
        // Only the plugin is panopticon-managed. The MCP server is an optional
        // user-run step, so it isn't required for the install to be "configured".
        return raw.includes(PLUGIN_NAME);
      } catch {
        return false;
      }
    },
  },

  scanner: {
    normalizeToolCategory: hermesToolCategory,

    discover() {
      const dbPath = stateDbPath();
      return fs.existsSync(dbPath) ? [{ filePath: dbPath }] : [];
    },

    // Watermark semantics: the stored "byte offset" is the highest
    // messages.id seen at the last parse, NOT a byte position. state.db is
    // SQLite in WAL mode — writes land in state.db-wal while the main
    // file's byte size stays frozen between checkpoints, so file size can
    // never signal new data. Message rowids grow far slower than the
    // file's byte size, so the scanner loop's size<watermark truncation
    // check never fires spuriously; if state.db is pruned/recreated the
    // max-id check below handles the reset instead.
    parseFile(filePath: string, fromByteOffset: number): ParseResult | null {
      return parseHermesStateDb(filePath, fromByteOffset);
    },
  },
};

registerTarget(hermes);
