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

const PLUGIN_INIT = `"""Panopticon observer plugin for Hermes Agent.

This plugin is installed by panopticon install --target hermes.
It is fail-open: telemetry errors must never interrupt Hermes execution.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import queue
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_EVENT_MAP = {
    "on_session_start": "SessionStart",
    "on_session_finalize": "SessionEnd",
    "on_session_reset": "SessionEnd",
    "pre_llm_call": "UserPromptSubmit",
    "post_llm_call": "Stop",
    "api_request_error": "StopFailure",
    "pre_tool_call": "PreToolUse",
    "post_tool_call": "PostToolUse",
    "subagent_start": "SubagentStart",
    "subagent_stop": "SubagentStop",
}

_PASSTHROUGH_FIELDS = (
    "telemetry_schema_version",
    "task_id",
    "turn_id",
    "api_request_id",
    "api_call_count",
    "tool_call_id",
    "parent_session_id",
    "child_session_id",
    "parent_subagent_id",
    "child_subagent_id",
    "parent_turn_id",
    "model",
    "platform",
    "sender_id",
    "provider",
    "base_url",
    "api_mode",
    "message_count",
    "tool_count",
    "approx_input_tokens",
    "request_char_count",
    "max_tokens",
    "started_at",
    "ended_at",
    "api_duration",
    "finish_reason",
    "response_model",
    "usage",
    "assistant_content_chars",
    "assistant_tool_call_count",
    "status_code",
    "retry_count",
    "max_retries",
    "retryable",
    "reason",
    "status",
    "duration_ms",
    "error_type",
    "error_message",
    "command",
    "description",
    "pattern_key",
    "pattern_keys",
    "session_key",
    "surface",
    "choice",
    "completed",
    "interrupted",
    "old_session_id",
    "new_session_id",
    "child_role",
    "child_goal",
    "child_summary",
)

_LOCK = threading.RLock()
_CONFIG: dict[str, Any] | None = None
_QUEUE: "queue.Queue[dict[str, Any] | None]" = queue.Queue(maxsize=1024)
_WORKER_STARTED = False
_SERVER_START_ATTEMPTED = False


def _plugin_dir() -> Path:
    return Path(__file__).resolve().parent


def _load_config() -> dict[str, Any]:
    global _CONFIG
    if _CONFIG is not None:
        return _CONFIG
    try:
        data = json.loads((_plugin_dir() / "panopticon.json").read_text(encoding="utf-8"))
        _CONFIG = data if isinstance(data, dict) else {}
    except Exception:
        _CONFIG = {}
    return _CONFIG


def _host() -> str:
    return str(os.environ.get("PANOPTICON_HOST") or _load_config().get("host") or "127.0.0.1")


def _port() -> int:
    raw = os.environ.get("PANOPTICON_PORT") or _load_config().get("port") or 4318
    try:
        return int(raw)
    except Exception:
        return 4318


def _timeout_seconds() -> float:
    raw = os.environ.get("PANOPTICON_HERMES_TIMEOUT_MS") or _load_config().get("request_timeout_ms") or 3000
    try:
        return max(0.1, float(raw) / 1000.0)
    except Exception:
        return 3.0


def _data_dir() -> Path:
    override = os.environ.get("PANOPTICON_DATA_DIR")
    if override:
        return Path(override)
    system = platform.system().lower()
    home = Path.home()
    if system == "darwin":
        return home / "Library" / "Application Support" / "panopticon"
    if system == "windows":
        appdata = os.environ.get("APPDATA")
        return Path(appdata) / "panopticon" if appdata else home / "AppData" / "Roaming" / "panopticon"
    return home / ".local" / "share" / "panopticon"


def _auth_token() -> str | None:
    env_token = os.environ.get("PANOPTICON_AUTH_TOKEN")
    if env_token:
        return env_token
    try:
        token = (_data_dir() / "auth-token").read_text(encoding="utf-8").strip()
        return token or None
    except Exception:
        return None


def _url(path: str) -> str:
    return f"http://{_host()}:{_port()}{path}"


def _jsonable(value: Any, *, depth: int = 0) -> Any:
    if depth > 6:
        return "<max-depth>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= 20000 else value[:20000] + "...<truncated>"
    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="replace")
        return text if len(text) <= 20000 else text[:20000] + "...<truncated>"
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        converted = [_jsonable(item, depth=depth + 1) for item in items[:100]]
        if len(items) > 100:
            converted.append(f"...<{len(items) - 100} more>")
        return converted
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 100:
                out["..."] = f"<{len(value) - 100} more>"
                break
            out[str(key)] = _jsonable(item, depth=depth + 1)
        return out
    return repr(value)


def _session_id(kwargs: dict[str, Any]) -> str:
    for key in ("session_id", "child_session_id", "parent_session_id", "new_session_id", "old_session_id"):
        value = kwargs.get(key)
        if value:
            return str(value)
    return "unknown"


def _canonical_tool_name(name: Any) -> str | None:
    if isinstance(name, str) and name:
        return name
    return None


def _payload(event_name: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    session_id = _session_id(kwargs)
    if event_name == "on_session_reset" and kwargs.get("old_session_id"):
        session_id = str(kwargs["old_session_id"])
    payload: dict[str, Any] = {
        "source": "hermes",
        "target": "hermes",
        "hook_event_name": _EVENT_MAP.get(event_name, event_name),
        "hermes_hook_event_name": event_name,
        "session_id": session_id,
        "cwd": str(kwargs.get("cwd") or os.getcwd()),
    }

    tool_name = _canonical_tool_name(kwargs.get("tool_name"))
    if tool_name:
        payload["tool_name"] = tool_name
    if isinstance(kwargs.get("args"), dict):
        payload["tool_input"] = _jsonable(kwargs.get("args"))
    if event_name == "post_tool_call":
        payload["tool_result"] = _jsonable(kwargs.get("result"))
    if event_name == "pre_llm_call" and isinstance(kwargs.get("user_message"), str):
        payload["prompt"] = kwargs["user_message"]
        payload["user_prompt"] = kwargs["user_message"]
    if event_name == "post_llm_call" and isinstance(kwargs.get("assistant_response"), str):
        payload["assistant_response"] = kwargs["assistant_response"]
    if event_name in {"pre_approval_request", "post_approval_response"}:
        payload["tool_name"] = "Bash" if kwargs.get("command") else "approval"
        payload["tool_input"] = _jsonable(
            {
                "command": kwargs.get("command"),
                "description": kwargs.get("description"),
                "pattern_key": kwargs.get("pattern_key"),
                "pattern_keys": kwargs.get("pattern_keys"),
                "surface": kwargs.get("surface"),
                "choice": kwargs.get("choice"),
            }
        )

    for field in _PASSTHROUGH_FIELDS:
        if field in kwargs:
            payload[field] = _jsonable(kwargs[field])

    for rich_field in ("request", "response", "assistant_message", "error"):
        if rich_field in kwargs:
            payload[rich_field] = _jsonable(kwargs[rich_field])

    history = kwargs.get("conversation_history")
    if isinstance(history, list):
        payload["conversation_history_length"] = len(history)

    return payload


def _post(payload: dict[str, Any]) -> dict[str, Any] | None:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
    }
    token = _auth_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(_url("/hooks"), data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=_timeout_seconds()) as response:
            raw = response.read() or b"{}"
        parsed = json.loads(raw.decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception as exc:
        logger.debug("panopticon hook post failed: %s", exc)
        return None


def _health_ok() -> bool:
    try:
        with urllib.request.urlopen(_url("/health"), timeout=0.5) as response:
            return 200 <= int(response.status) < 300
    except Exception:
        return False


def _start_server_once() -> None:
    global _SERVER_START_ATTEMPTED
    with _LOCK:
        if _SERVER_START_ATTEMPTED:
            return
        _SERVER_START_ATTEMPTED = True
    command = _load_config().get("start_command")
    if not isinstance(command, list) or not all(isinstance(part, str) for part in command):
        return
    try:
        subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception as exc:
        logger.debug("panopticon server start failed: %s", exc)


def _worker() -> None:
    while True:
        payload = _QUEUE.get()
        if payload is None:
            _QUEUE.task_done()
            return
        try:
            _post(payload)
        finally:
            _QUEUE.task_done()


def _ensure_worker() -> None:
    global _WORKER_STARTED
    with _LOCK:
        if _WORKER_STARTED:
            return
        thread = threading.Thread(target=_worker, name="panopticon-observer", daemon=True)
        thread.start()
        _WORKER_STARTED = True


def _enqueue(payload: dict[str, Any]) -> None:
    _ensure_worker()
    try:
        _QUEUE.put_nowait(payload)
    except queue.Full:
        logger.debug("panopticon observer queue full; dropping event")


def _flush(timeout: float = 2.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _QUEUE.unfinished_tasks == 0:
            return
        time.sleep(0.02)


def _emit(event_name: str, **kwargs: Any) -> dict[str, Any] | None:
    payload = _payload(event_name, kwargs)
    canonical = payload.get("hook_event_name")

    if canonical == "SessionStart":
        if not _health_ok():
            _start_server_once()
            time.sleep(0.8)
        response = _post(payload)
        if response is None and not _health_ok():
            _start_server_once()
            time.sleep(0.8)
            _post(payload)
        return None

    if canonical == "PreToolUse":
        response = _post(payload) or {}
        if response.get("action") == "block":
            message = response.get("message") or response.get("reason") or "Blocked by Panopticon"
            return {"action": "block", "message": str(message)}
        return None

    if canonical == "SessionEnd":
        _post(payload)
        _flush()
        return None

    if event_name == "on_session_end":
        # Hermes fires on_session_end at the end of every turn
        # (run_conversation), not at true session end. Use it as a per-turn
        # durability checkpoint so queued events land before the agent idles.
        _enqueue(payload)
        _flush()
        return None

    _enqueue(payload)
    return None


def register(ctx) -> None:
    ctx.register_hook("on_session_start", lambda **kw: _emit("on_session_start", **kw))
    ctx.register_hook("on_session_end", lambda **kw: _emit("on_session_end", **kw))
    ctx.register_hook("on_session_finalize", lambda **kw: _emit("on_session_finalize", **kw))
    ctx.register_hook("on_session_reset", lambda **kw: _emit("on_session_reset", **kw))
    ctx.register_hook("pre_llm_call", lambda **kw: _emit("pre_llm_call", **kw))
    ctx.register_hook("post_llm_call", lambda **kw: _emit("post_llm_call", **kw))
    ctx.register_hook("pre_api_request", lambda **kw: _emit("pre_api_request", **kw))
    ctx.register_hook("post_api_request", lambda **kw: _emit("post_api_request", **kw))
    ctx.register_hook("api_request_error", lambda **kw: _emit("api_request_error", **kw))
    ctx.register_hook("pre_tool_call", lambda **kw: _emit("pre_tool_call", **kw))
    ctx.register_hook("post_tool_call", lambda **kw: _emit("post_tool_call", **kw))
    ctx.register_hook("pre_approval_request", lambda **kw: _emit("pre_approval_request", **kw))
    ctx.register_hook("post_approval_response", lambda **kw: _emit("post_approval_response", **kw))
    ctx.register_hook("subagent_start", lambda **kw: _emit("subagent_start", **kw))
    ctx.register_hook("subagent_stop", lambda **kw: _emit("subagent_stop", **kw))
`;

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
  const dest = pluginDest();
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "plugin.yaml"), PLUGIN_YAML);
  fs.writeFileSync(path.join(dest, "__init__.py"), PLUGIN_INIT);
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
