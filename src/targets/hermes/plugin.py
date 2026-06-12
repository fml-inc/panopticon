"""Panopticon observer plugin for Hermes Agent.

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
    "pre_approval_request": "PermissionRequest",
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
    # Hermes fires on_session_end at the end of every turn (run_conversation),
    # not at true session end. Use it purely as a per-turn durability
    # checkpoint: drain the queue so events land before the agent idles, but
    # emit no event of its own (it has no canonical Panopticon mapping).
    if event_name == "on_session_end":
        _flush()
        return None

    canonical = _EVENT_MAP.get(event_name)
    if canonical is None:
        # No canonical Panopticon event (pre/post_api_request,
        # post_approval_response, ...). Don't POST — these would be stored
        # under a non-canonical event_type and are pure downstream noise.
        return None

    payload = _payload(event_name, kwargs)

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
