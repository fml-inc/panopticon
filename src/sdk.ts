/**
 * Panopticon SDK shim for Claude Agent SDK.
 *
 * Wraps the `query()` async iterator to capture observability data and emit
 * it to the panopticon server. Zero-dependency on the SDK — uses duck typing.
 *
 * Usage:
 *   import { query } from "@anthropic-ai/claude-agent-sdk";
 *   import { observe } from "panopticon/sdk";
 *
 *   for await (const msg of observe(query({ prompt: "..." }))) {
 *     // use msg normally
 *   }
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Mirrors src/config.ts defaultPort() — offset by uid to avoid multi-user
// port collision on the OTLP standard port. Duplicated to keep this SDK
// shim dependency-free.
const DEFAULT_PORT_BASE = 4318;
const PORT = parseInt(
  process.env.PANOPTICON_PORT ??
    process.env.PANOPTICON_OTLP_PORT ??
    String(DEFAULT_PORT_BASE + ((process.getuid?.() ?? 0) % 100)),
  10,
);

// Mirrors src/config.ts defaultDataDir() — duplicated to keep dependency-free.
function defaultDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "panopticon",
      );
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "panopticon",
      );
    default:
      return path.join(os.homedir(), ".local", "share", "panopticon");
  }
}

// Read the bearer token once at module load. /hooks and /api/* require it;
// /v1/* (which this SDK uses for metrics) does not, so a missing token only
// breaks emitHook calls — emitMetrics still works.
const AUTH_TOKEN: string | null = (() => {
  if (process.env.PANOPTICON_AUTH_TOKEN)
    return process.env.PANOPTICON_AUTH_TOKEN;
  const dataDir = process.env.PANOPTICON_DATA_DIR ?? defaultDataDir();
  try {
    return (
      fs.readFileSync(path.join(dataDir, "auth-token"), "utf-8").trim() || null
    );
  } catch {
    return null;
  }
})();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function postJSON(path: string, body: unknown): void {
  const data = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(data)),
  };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: PORT,
      path,
      method: "POST",
      headers,
      timeout: 3000,
    },
    (res) => {
      res.resume();
    },
  );
  req.on("error", () => {}); // fire and forget
  req.on("timeout", () => req.destroy());
  req.write(data);
  req.end();
}

function emitHook(event: Record<string, unknown>): void {
  postJSON("/hooks", event);
}

function emitMetrics(
  metrics: Array<{
    name: string;
    value: number;
    attributes?: Record<string, unknown>;
    sessionId?: string;
  }>,
): void {
  if (metrics.length === 0) return;

  const now = String(Date.now() * 1_000_000);
  const sessionId = metrics[0].sessionId;

  const resourceAttrs: Array<{ key: string; value: { stringValue: string } }> =
    [];
  if (sessionId) {
    resourceAttrs.push({
      key: "session.id",
      value: { stringValue: sessionId },
    });
  }

  const byName = new Map<
    string,
    Array<{
      timeUnixNano: string;
      asDouble: number;
      attributes: Array<{
        key: string;
        value: { stringValue?: string; doubleValue?: number };
      }>;
    }>
  >();

  for (const m of metrics) {
    const dps = byName.get(m.name) ?? [];
    dps.push({
      timeUnixNano: now,
      asDouble: m.value,
      attributes: Object.entries(m.attributes ?? {}).map(([key, value]) => ({
        key,
        value:
          typeof value === "number"
            ? { doubleValue: value }
            : { stringValue: String(value) },
      })),
    });
    byName.set(m.name, dps);
  }

  postJSON("/v1/metrics", {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttrs },
        scopeMetrics: [
          {
            metrics: [...byName.entries()].map(([name, dataPoints]) => ({
              name,
              gauge: { dataPoints },
            })),
          },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Message type detection (duck typing — no SDK dependency)
// ---------------------------------------------------------------------------

interface AnyMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  message?: {
    id?: string;
    model?: string;
    content?: Array<{
      type: string;
      name?: string;
      input?: unknown;
      text?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    stop_reason?: string;
  };
  // ResultMessage fields
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  stop_reason?: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }
  >;
  // SystemMessage (init) fields
  model?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  // Rate limit
  rate_limit_info?: {
    status: string;
    resetsAt?: number;
    utilization?: number;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

export interface ObserveOptions {
  /** Override the panopticon server port (default: 4318 or PANOPTICON_PORT) */
  port?: number;
  /** Custom session ID. If not set, uses the SDK's session_id from init. */
  sessionId?: string;
}

/**
 * Wrap a Claude Agent SDK `query()` iterator to capture observability data.
 * Yields all messages unchanged — fully transparent to the consumer.
 */
export async function* observe<T extends AnyMessage>(
  source: AsyncIterable<T>,
  options?: ObserveOptions,
): AsyncGenerator<T, void, undefined> {
  let sessionId = options?.sessionId ?? "sdk-unknown";
  const seenMessageIds = new Set<string>();

  for await (const msg of source) {
    try {
      processMessage(msg, sessionId, seenMessageIds);

      // Capture session_id from init message
      if (
        msg.type === "system" &&
        msg.subtype === "init" &&
        msg.session_id &&
        !options?.sessionId
      ) {
        sessionId = msg.session_id;
        emitHook({
          session_id: sessionId,
          hook_event_name: "SessionStart",
          source: "sdk",
          cwd: msg.cwd,
          model: msg.model,
          tools: msg.tools,
        });
      }
    } catch {
      // Never block the consumer
    }

    yield msg;
  }

  // Stream ended — emit SessionEnd
  emitHook({
    session_id: sessionId,
    hook_event_name: "SessionEnd",
    source: "sdk",
  });
}

function processMessage(
  msg: AnyMessage,
  sessionId: string,
  seenMessageIds: Set<string>,
): void {
  if (msg.type === "assistant" && msg.message) {
    // Deduplicate by message.id (parallel tool calls share the same id)
    const msgId = msg.message.id;
    if (msgId && seenMessageIds.has(msgId)) return;
    if (msgId) seenMessageIds.add(msgId);

    const content = msg.message.content ?? [];
    const usage = msg.message.usage;
    const model = msg.message.model ?? "unknown";

    // Extract tool calls
    for (const block of content) {
      if (block.type === "tool_use" && block.name) {
        emitHook({
          session_id: sessionId,
          hook_event_name: "PreToolUse",
          source: "sdk",
          tool_name: block.name,
          tool_input: block.input as Record<string, unknown>,
        });
      }
    }

    // Emit per-turn token metrics
    if (usage) {
      const metrics: Array<{
        name: string;
        value: number;
        attributes?: Record<string, unknown>;
        sessionId?: string;
      }> = [];

      if (usage.input_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.input_tokens,
          attributes: { model, token_type: "input", source: "sdk" },
          sessionId,
        });
      }
      if (usage.output_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.output_tokens,
          attributes: { model, token_type: "output", source: "sdk" },
          sessionId,
        });
      }
      if (usage.cache_read_input_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.cache_read_input_tokens,
          attributes: { model, token_type: "cacheRead", source: "sdk" },
          sessionId,
        });
      }
      if (usage.cache_creation_input_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.cache_creation_input_tokens,
          attributes: { model, token_type: "cacheWrite", source: "sdk" },
          sessionId,
        });
      }

      emitMetrics(metrics);
    }
  }

  if (msg.type === "result") {
    // ResultMessage — authoritative totals
    emitHook({
      session_id: sessionId,
      hook_event_name: "Stop",
      source: "sdk",
      stop_reason: msg.stop_reason,
      num_turns: msg.num_turns,
      duration_ms: msg.duration_ms,
      duration_api_ms: msg.duration_api_ms,
      total_cost_usd: msg.total_cost_usd,
    });

    // Emit cost metric
    if (msg.total_cost_usd != null) {
      emitMetrics([
        {
          name: "cost.usage",
          value: msg.total_cost_usd,
          attributes: { source: "sdk" },
          sessionId,
        },
      ]);
    }

    // Emit per-model usage breakdown
    if (msg.modelUsage) {
      for (const [model, usage] of Object.entries(msg.modelUsage)) {
        const metrics: Array<{
          name: string;
          value: number;
          attributes?: Record<string, unknown>;
          sessionId?: string;
        }> = [];

        if (usage.costUSD != null) {
          metrics.push({
            name: "cost.usage",
            value: usage.costUSD,
            attributes: { model, source: "sdk" },
            sessionId,
          });
        }

        emitMetrics(metrics);
      }
    }
  }

  if (msg.type === "rate_limit_event" && msg.rate_limit_info) {
    emitHook({
      session_id: sessionId,
      hook_event_name: "RateLimit",
      source: "sdk",
      rate_limit_status: msg.rate_limit_info.status,
      rate_limit_utilization: msg.rate_limit_info.utilization,
      rate_limit_resets_at: msg.rate_limit_info.resetsAt,
    });
  }
}
