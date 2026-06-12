/**
 * Hermes Agent target adapter.
 *
 * Panopticon observes Hermes through a user-installed Hermes plugin. The
 * plugin runs in the Hermes Python process, receives native observer kwargs,
 * and posts Panopticon-shaped hook events to the local server.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/driver.js";
import type { HookInput } from "../hooks/ingest.js";
import { defaultToolCategory } from "../scanner/categories.js";
import { hasMcpServer } from "../yaml.js";
import { registerTarget } from "./registry.js";
import type { ParsedToolCall, ParseResult, TargetAdapter } from "./types.js";

const PLUGIN_NAME = "panopticon-observer";
const STRUCTURED_JSON_PREFIX = "\0json:";

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

function textFromStructuredContent(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    if (value.startsWith(STRUCTURED_JSON_PREFIX)) {
      return textFromStructuredContent(
        value.slice(STRUCTURED_JSON_PREFIX.length),
      );
    }
    const parsed = parseJson(value);
    return parsed === value ? value : textFromStructuredContent(parsed);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromStructuredContent(item))
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["text", "content", "message", "output", "result"]) {
    if (key in record) {
      const text = textFromStructuredContent(record[key]);
      if (text) return text;
    }
  }
  return stringifyJson(record) ?? "";
}

function hermesToolCategory(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower.includes("read")) return "Read";
  if (lower.includes("edit") || lower.includes("patch")) return "Edit";
  if (lower.includes("write") || lower.includes("create")) return "Write";
  if (
    lower.includes("bash") ||
    lower.includes("shell") ||
    lower.includes("terminal") ||
    lower.includes("command")
  ) {
    return "Bash";
  }
  if (lower.includes("grep") || lower.includes("search")) return "Grep";
  if (lower.includes("glob") || lower.includes("list")) return "Glob";
  if (lower.includes("web") || lower.includes("fetch")) return "Web";
  if (lower.includes("delegate") || lower.includes("subagent")) return "Task";
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

function enabledPlugins(config: Record<string, unknown>): string[] {
  const plugins = asRecord(config.plugins);
  return asArray(plugins?.enabled).filter(
    (value): value is string => typeof value === "string",
  );
}

function withEnabledPlugin(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const updated = structuredClone(config);
  const plugins = asRecord(updated.plugins) ?? {};
  const enabled = enabledPlugins(updated).filter(
    (name) => name !== PLUGIN_NAME,
  );
  enabled.push(PLUGIN_NAME);
  plugins.enabled = enabled;
  updated.plugins = plugins;
  return updated;
}

function withoutEnabledPlugin(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const updated = structuredClone(config);
  const plugins = asRecord(updated.plugins);
  if (!plugins) return updated;
  const enabled = enabledPlugins(updated).filter(
    (name) => name !== PLUGIN_NAME,
  );
  if (enabled.length === 0) {
    delete plugins.enabled;
  } else {
    plugins.enabled = enabled;
  }
  if (Object.keys(plugins).length === 0) delete updated.plugins;
  return updated;
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
    if (maxMessageId === fromWatermark) return null;

    // fromWatermark > maxMessageId means state.db was pruned or recreated;
    // fall through to a full re-snapshot (the upserts below are idempotent).
    const incremental = fromWatermark > 0 && maxMessageId > fromWatermark;

    // Each selected session is emitted as a FULL snapshot of that session
    // (absolute indices, INSERT OR IGNORE/upsert dedupes downstream). In
    // incremental mode only sessions with new messages are re-snapshotted.
    const changedSessionFilter = `id IN (SELECT DISTINCT session_id FROM messages WHERE id > ?)`;
    const sessions = (
      incremental
        ? db
            .prepare(
              `SELECT ${SESSION_COLUMNS} FROM sessions
                WHERE ${changedSessionFilter}
                ORDER BY COALESCE(started_at, 0), id`,
            )
            .all(fromWatermark)
        : db
            .prepare(
              `SELECT ${SESSION_COLUMNS} FROM sessions
                ORDER BY COALESCE(started_at, 0), id`,
            )
            .all()
    ) as HermesSessionRow[];
    if (sessions.length === 0) return null;

    const messages = (
      incremental
        ? db
            .prepare(
              `SELECT ${MESSAGE_COLUMNS} FROM messages
                WHERE COALESCE(active, 1) = 1
                  AND session_id IN (SELECT DISTINCT session_id FROM messages WHERE id > ?)
                ORDER BY session_id, id`,
            )
            .all(fromWatermark)
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

    const results = sessions.map((session) =>
      parseHermesSession(
        session,
        bySession.get(session.id) ?? [],
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

  for (const message of messages) {
    const tsMs = timestampMs(message.timestamp) ?? startedAtMs ?? message.id;
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
        inputTokens: 0,
        outputTokens:
          typeof message.token_count === "number" ? message.token_count : 0,
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
    relationshipType: session.parent_session_id ? "continuation" : undefined,
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
  },

  hooks: {
    events: [...HERMES_OBSERVER_HOOKS],

    applyInstallConfig(existing, opts) {
      writePluginFiles({ pluginRoot: opts.pluginRoot, port: opts.port });
      const updated = withEnabledPlugin(existing);
      // Register panopticon's MCP server so hermes sessions can query their
      // own history/costs. Absolute node path: hermes spawns MCP servers
      // from Python where PATH may be minimal (same rationale as
      // claude-desktop).
      const servers = asRecord(updated.mcp_servers) ?? {};
      servers.panopticon = {
        command: process.execPath,
        args: [path.join(opts.pluginRoot, "bin", "mcp-server")],
      };
      updated.mcp_servers = servers;
      return updated;
    },

    removeInstallConfig(existing) {
      fs.rmSync(pluginDest(), { recursive: true, force: true });
      const updated = withoutEnabledPlugin(existing);
      const servers = asRecord(updated.mcp_servers);
      if (servers) {
        delete servers.panopticon;
        if (Object.keys(servers).length === 0) delete updated.mcp_servers;
      }
      return updated;
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
      pre_llm_call: "UserPromptSubmit",
      post_llm_call: "Stop",
      api_request_error: "StopFailure",
      pre_tool_call: "PreToolUse",
      post_tool_call: "PostToolUse",
      subagent_start: "SubagentStart",
      subagent_stop: "SubagentStop",
    },

    normalizePayload: normalizeHermesPayload,

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
        // Requiring the MCP entry too makes doctor flag pre-MCP installs as
        // needing a re-run of `panopticon install --target hermes`.
        return raw.includes(PLUGIN_NAME) && hasMcpServer(raw, "panopticon");
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
