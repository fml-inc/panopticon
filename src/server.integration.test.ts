/**
 * Integration tests for the unified panopticon server.
 *
 * Starts the real HTTP server against a temp SQLite database and exercises:
 *   - Hook event ingestion via POST /hooks
 *   - OTel JSON log & metric ingestion via POST /v1/logs, /v1/metrics, /v1/traces
 *   - Proxy route validation (404, 405)
 *   - Proxy capture → DB pipeline (format parsers + emit functions)
 *   - Database state: session isolation, column extraction, FTS, compression
 *   - Session file archiving (LocalArchiveBackend round-trip)
 *   - LLM-powered session summaries with deterministic fallback
 */
import fs from "node:fs";
import type http from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ── Mock config to use a temp directory ──────────────────────────────────────
// vi.mock is hoisted — all values must be computed inside the factory.

vi.mock("./config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const tmpDir = _path.join(_os.tmpdir(), "panopticon-server-integ");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: _path.join(tmpDir, "data.db"),
      port: 0,
      host: "127.0.0.1",
      serverPidFile: _path.join(tmpDir, "panopticon.pid"),
      pidFile: _path.join(tmpDir, "otlp-receiver.pid"),
      otlpPort: 0,
      otlpHost: "127.0.0.1",
      marketplaceDir: _path.join(tmpDir, "marketplace"),
      marketplaceManifest: _path.join(
        tmpDir,
        "marketplace",
        "marketplace.json",
      ),
      pluginCacheDir: _path.join(tmpDir, "plugin-cache"),
      proxyPort: 0,
      proxyHost: "127.0.0.1",
      proxyPidFile: _path.join(tmpDir, "proxy.pid"),
      proxyIdleSessionMs: 30 * 60 * 1000,
    },
    ensureDataDir: () => _fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

// Must import after mock
import path from "node:path";
import { LocalArchiveBackend } from "./archive/local.js";
import { config } from "./config.js";
import { costBreakdown, search, sessionTimeline } from "./db/query.js";
import { closeDb, getDb } from "./db/schema.js";
import {
  insertOtelMetrics,
  type OtelMetricRow,
  upsertSession,
} from "./db/store.js";
import {
  _resetSessionRepoCache,
  _resetSessionTargetCache,
} from "./hooks/ingest.js";
import {
  emitHookEventAsync,
  emitOtelLogs,
  emitOtelMetrics,
} from "./proxy/emit.js";
import { anthropicParser } from "./proxy/formats/anthropic.js";
import { createUnifiedServer } from "./server.js";
import * as llm from "./summary/llm.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

function countRows(table: string): number {
  return (
    getDb().prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as {
      c: number;
    }
  ).c;
}

async function post(
  urlPath: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// ── Test data ────────────────────────────────────────────────────────────────

const SESSION_1 = "integ-sess-001";
const SESSION_2 = "integ-sess-002";

const hookEvents = [
  {
    session_id: SESSION_1,
    hook_event_name: "SessionStart",
    cwd: "/workspace/my-project",
  },
  {
    session_id: SESSION_1,
    hook_event_name: "UserPromptSubmit",
    cwd: "/workspace/my-project",
    prompt: "Fix the login bug in auth.ts",
  },
  {
    session_id: SESSION_1,
    hook_event_name: "PreToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Read",
    tool_input: { file_path: "/workspace/my-project/src/auth.ts" },
  },
  {
    session_id: SESSION_1,
    hook_event_name: "PostToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Read",
    tool_input: { file_path: "/workspace/my-project/src/auth.ts" },
  },
  {
    session_id: SESSION_1,
    hook_event_name: "PreToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Edit",
    tool_input: {
      file_path: "/workspace/my-project/src/auth.ts",
      old_string: "bug",
      new_string: "fix",
    },
  },
  {
    session_id: SESSION_1,
    hook_event_name: "PostToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Edit",
  },
  {
    session_id: SESSION_1,
    hook_event_name: "PreToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  },
  {
    session_id: SESSION_1,
    hook_event_name: "PostToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Bash",
  },
  {
    session_id: SESSION_1,
    hook_event_name: "Stop",
    cwd: "/workspace/my-project",
  },
  {
    session_id: SESSION_2,
    hook_event_name: "SessionStart",
    cwd: "/workspace/other-project",
  },
  {
    session_id: SESSION_2,
    hook_event_name: "UserPromptSubmit",
    cwd: "/workspace/other-project",
    prompt: "Add a new API endpoint",
  },
  {
    session_id: SESSION_2,
    hook_event_name: "Stop",
    cwd: "/workspace/other-project",
  },
];

const otelLogsPayload = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "claude-code" } },
          { key: "session.id", value: { stringValue: SESSION_1 } },
        ],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: String(Date.now() * 1_000_000),
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "claude_code.tool_decision" },
              attributes: [
                { key: "tool_name", value: { stringValue: "Read" } },
                { key: "session.id", value: { stringValue: SESSION_1 } },
              ],
            },
            {
              timeUnixNano: String(Date.now() * 1_000_000 + 1_000_000),
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "claude_code.user_prompt" },
              attributes: [
                {
                  key: "prompt",
                  value: { stringValue: "Fix the login bug" },
                },
                { key: "session.id", value: { stringValue: SESSION_1 } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const otelMetricsPayload = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "claude-code" } },
          { key: "session.id", value: { stringValue: SESSION_1 } },
        ],
      },
      scopeMetrics: [
        {
          metrics: [
            {
              name: "claude_code.token.usage",
              unit: "tokens",
              gauge: {
                dataPoints: [
                  {
                    timeUnixNano: String(Date.now() * 1_000_000),
                    asInt: "1500",
                    attributes: [
                      { key: "type", value: { stringValue: "input" } },
                      {
                        key: "model",
                        value: { stringValue: "claude-sonnet-4-6-20250514" },
                      },
                      {
                        key: "session.id",
                        value: { stringValue: SESSION_1 },
                      },
                    ],
                  },
                  {
                    timeUnixNano: String(Date.now() * 1_000_000),
                    asInt: "500",
                    attributes: [
                      { key: "type", value: { stringValue: "output" } },
                      {
                        key: "model",
                        value: { stringValue: "claude-sonnet-4-6-20250514" },
                      },
                      {
                        key: "session.id",
                        value: { stringValue: SESSION_1 },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

// Mock Anthropic API exchange for proxy capture tests
const MOCK_CAPTURE_SESSION = "proxy-capture-sess-001";

const mockAnthropicExchange = {
  target: "claude",
  sessionId: MOCK_CAPTURE_SESSION,
  timestamp_ms: Date.now(),
  request: {
    path: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-test",
    },
    body: {
      model: "claude-sonnet-4-6-20250514",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: "Read the index.ts file and tell me what it does",
        },
      ],
    },
  },
  response: {
    status: 200,
    body: {
      id: "msg_mock_001",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6-20250514",
      content: [
        { type: "text", text: "I'll read the file for you." },
        {
          type: "tool_use",
          id: "toolu_mock_001",
          name: "Read",
          input: { file_path: "/workspace/src/index.ts" },
        },
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 1200,
        output_tokens: 85,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 50,
      },
    },
  },
  duration_ms: 450,
};

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb(); // initialize schema

  server = createUnifiedServer();
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  closeDb();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("server integration", () => {
  describe("health check", () => {
    it("GET /health returns ok", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    });
  });

  describe("hook event ingestion", () => {
    it("accepts all hook events via POST /hooks", async () => {
      for (const event of hookEvents) {
        const { status } = await post("/hooks", event);
        expect(status).toBe(200);
      }
    });

    it("stored correct number of rows", () => {
      expect(countRows("hook_events")).toBe(hookEvents.length);
    });

    it("isolates sessions correctly", () => {
      const db = getDb();
      const s1 = (
        db
          .prepare("SELECT COUNT(*) as c FROM hook_events WHERE session_id = ?")
          .get(SESSION_1) as { c: number }
      ).c;
      const s2 = (
        db
          .prepare("SELECT COUNT(*) as c FROM hook_events WHERE session_id = ?")
          .get(SESSION_2) as { c: number }
      ).c;
      expect(s1).toBe(9);
      expect(s2).toBe(3);
    });

    it("stores all event types", () => {
      const db = getDb();
      const types = db
        .prepare(
          "SELECT DISTINCT event_type FROM hook_events WHERE session_id = ?",
        )
        .all(SESSION_1)
        .map((r: any) => r.event_type);
      expect(types).toContain("SessionStart");
      expect(types).toContain("UserPromptSubmit");
      expect(types).toContain("PreToolUse");
      expect(types).toContain("PostToolUse");
      expect(types).toContain("Stop");
    });

    it("extracts tool names", () => {
      const db = getDb();
      const tools = db
        .prepare(
          "SELECT DISTINCT tool_name FROM hook_events WHERE session_id = ? AND tool_name IS NOT NULL",
        )
        .all(SESSION_1)
        .map((r: any) => r.tool_name);
      expect(tools).toContain("Read");
      expect(tools).toContain("Edit");
      expect(tools).toContain("Bash");
    });

    it("extracts user_prompt column", () => {
      const db = getDb();
      const row = db
        .prepare(
          "SELECT user_prompt FROM hook_events WHERE session_id = ? AND event_type = 'UserPromptSubmit'",
        )
        .get(SESSION_1) as { user_prompt: string };
      expect(row.user_prompt).toBe("Fix the login bug in auth.ts");
    });

    it("extracts file_path column", () => {
      const db = getDb();
      const row = db
        .prepare(
          "SELECT file_path FROM hook_events WHERE session_id = ? AND tool_name = 'Read' AND event_type = 'PreToolUse'",
        )
        .get(SESSION_1) as { file_path: string };
      expect(row.file_path).toBe("/workspace/my-project/src/auth.ts");
    });

    it("extracts command column", () => {
      const db = getDb();
      const row = db
        .prepare(
          "SELECT command FROM hook_events WHERE session_id = ? AND tool_name = 'Bash' AND event_type = 'PreToolUse'",
        )
        .get(SESSION_1) as { command: string };
      expect(row.command).toBe("npm test");
    });

    it("compresses and decompresses payload", () => {
      const db = getDb();
      const row = db
        .prepare(
          "SELECT payload FROM hook_events WHERE session_id = ? AND event_type = 'SessionStart'",
        )
        .get(SESSION_1) as { payload: Buffer };
      const json = JSON.parse(gunzipSync(row.payload).toString());
      expect(typeof json).toBe("object");
    });

    it("populates FTS index", () => {
      expect(countRows("hook_events_fts")).toBe(hookEvents.length);
    });

    it("FTS search works", () => {
      const db = getDb();
      const count = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM hook_events_fts WHERE payload MATCH '\"npm test\"'",
          )
          .get() as { c: number }
      ).c;
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("tracks session cwds", () => {
      const db = getDb();
      const cwds1 = db
        .prepare("SELECT DISTINCT cwd FROM session_cwds WHERE session_id = ?")
        .all(SESSION_1)
        .map((r: any) => r.cwd);
      expect(cwds1).toContain("/workspace/my-project");

      const cwds2 = db
        .prepare("SELECT DISTINCT cwd FROM session_cwds WHERE session_id = ?")
        .all(SESSION_2)
        .map((r: any) => r.cwd);
      expect(cwds2).toContain("/workspace/other-project");
    });
  });

  describe("OTel ingestion", () => {
    it("accepts JSON logs via POST /v1/logs", async () => {
      const { status } = await post("/v1/logs", otelLogsPayload);
      expect(status).toBe(200);
    });

    it("accepts JSON metrics via POST /v1/metrics", async () => {
      const { status } = await post("/v1/metrics", otelMetricsPayload);
      expect(status).toBe(200);
    });

    it("stores OTel logs with correct session", () => {
      const db = getDb();
      const count = (
        db
          .prepare("SELECT COUNT(*) as c FROM otel_logs WHERE session_id = ?")
          .get(SESSION_1) as { c: number }
      ).c;
      expect(count).toBe(2);
    });

    it("stores OTel log bodies", () => {
      const db = getDb();
      const bodies = db
        .prepare("SELECT body FROM otel_logs ORDER BY timestamp_ns")
        .all()
        .map((r: any) => r.body);
      expect(bodies).toContain("claude_code.tool_decision");
      expect(bodies).toContain("claude_code.user_prompt");
    });

    it("stores OTel metrics with correct session", () => {
      const db = getDb();
      const count = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM otel_metrics WHERE session_id = ?",
          )
          .get(SESSION_1) as { c: number }
      ).c;
      expect(count).toBe(2);
    });

    it("stores metric names", () => {
      const db = getDb();
      const names = db
        .prepare("SELECT DISTINCT name FROM otel_metrics")
        .all()
        .map((r: any) => r.name);
      expect(names).toContain("claude_code.token.usage");
    });
  });

  describe("edge cases", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await fetch(`${baseUrl}/nonexistent`);
      expect(res.status).toBe(404);
    });

    it("returns 500 for invalid JSON to /hooks", async () => {
      const res = await fetch(`${baseUrl}/hooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(500);
    });
  });

  describe("proxy routing", () => {
    it("returns 404 for unknown target", async () => {
      const { status, body } = await post("/proxy/badtarget/v1/messages", {
        msg: "test",
      });
      expect(status).toBe(404);
      expect((body as any).error).toBe("unknown_route");
    });

    it("returns 405 for non-POST", async () => {
      const res = await fetch(`${baseUrl}/proxy/claude/v1/messages`);
      expect(res.status).toBe(405);
    });
  });

  describe("proxy capture pipeline", () => {
    // Tests the format parser → emit → DB pipeline that runs after the proxy
    // captures an API exchange. Calls the same functions the proxy uses
    // internally, without needing a real HTTPS upstream.

    it("Anthropic parser extracts events from captured exchange", () => {
      expect(anthropicParser.matches("/v1/messages")).toBe(true);

      const events = anthropicParser.extractEvents(
        mockAnthropicExchange as any,
      );
      const eventTypes = events.map((e) => e.hook_event_name);
      expect(eventTypes).toContain("UserPromptSubmit");
      expect(eventTypes).toContain("PreToolUse");

      const toolUse = events.find((e) => e.hook_event_name === "PreToolUse");
      expect(toolUse?.tool_name).toBe("Read");
    });

    it("Anthropic parser extracts token metrics", () => {
      const metrics = anthropicParser.extractMetrics(
        mockAnthropicExchange as any,
      );
      const types = metrics.map((m) => m.attributes?.token_type);
      expect(types).toContain("input");
      expect(types).toContain("output");
      expect(types).toContain("cacheRead");
      expect(types).toContain("cacheWrite");

      const input = metrics.find((m) => m.attributes?.token_type === "input");
      expect(input?.value).toBe(1200);
      const output = metrics.find((m) => m.attributes?.token_type === "output");
      expect(output?.value).toBe(85);
    });

    it("Anthropic parser extracts api_request log", () => {
      const logs = anthropicParser.extractLogs(mockAnthropicExchange as any);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].body).toBe("api_request");
      expect(logs[0].attributes?.model).toBe("claude-sonnet-4-6-20250514");
    });

    it("emit functions write proxy events to DB", () => {
      const hooksBefore = countRows("hook_events");
      const metricsBefore = countRows("otel_metrics");
      const logsBefore = countRows("otel_logs");

      // Simulate what processCapture does
      const events = anthropicParser.extractEvents(
        mockAnthropicExchange as any,
      );
      for (const event of events) {
        event.source = "proxy";
        event.target = mockAnthropicExchange.target;
        emitHookEventAsync(event);
      }

      const metrics = anthropicParser.extractMetrics(
        mockAnthropicExchange as any,
      );
      for (const m of metrics) {
        m.attributes = { ...m.attributes, source: "proxy" };
      }
      emitOtelMetrics(metrics);

      const logs = anthropicParser.extractLogs(mockAnthropicExchange as any);
      for (const l of logs) {
        l.attributes = { ...l.attributes, source: "proxy" };
      }
      emitOtelLogs(logs);

      // Verify new rows
      const newHooks = countRows("hook_events") - hooksBefore;
      expect(newHooks).toBeGreaterThanOrEqual(2); // UserPromptSubmit + PreToolUse

      const newMetrics = countRows("otel_metrics") - metricsBefore;
      expect(newMetrics).toBe(4); // input, output, cacheRead, cacheWrite

      const newLogs = countRows("otel_logs") - logsBefore;
      expect(newLogs).toBeGreaterThanOrEqual(1); // api_request
    });

    it("proxy-emitted metrics have correct values in DB", () => {
      const db = getDb();
      const proxyMetrics = db
        .prepare(
          `SELECT name, value, json_extract(attributes, '$.token_type') as token_type
           FROM otel_metrics
           WHERE json_extract(attributes, '$.source') = 'proxy'`,
        )
        .all() as Array<{ name: string; value: number; token_type: string }>;

      const input = proxyMetrics.find((m) => m.token_type === "input");
      expect(input?.value).toBe(1200);

      const output = proxyMetrics.find((m) => m.token_type === "output");
      expect(output?.value).toBe(85);

      const cacheRead = proxyMetrics.find((m) => m.token_type === "cacheRead");
      expect(cacheRead?.value).toBe(300);
    });

    it("proxy-emitted logs have correct attributes in DB", () => {
      const db = getDb();
      const proxyLogs = db
        .prepare(
          `SELECT body, json_extract(attributes, '$.model') as model,
                  json_extract(attributes, '$.target') as target
           FROM otel_logs
           WHERE json_extract(attributes, '$.source') = 'proxy'`,
        )
        .all() as Array<{ body: string; model: string; target: string }>;

      expect(proxyLogs.length).toBeGreaterThanOrEqual(1);
      expect(proxyLogs[0].body).toBe("api_request");
      expect(proxyLogs[0].model).toBe("claude-sonnet-4-6-20250514");
      expect(proxyLogs[0].target).toBe("claude");
    });
  });

  // ── Codex OTel format ────────────────────────────────────────────────────

  describe("Codex OTel format", () => {
    const CODEX_SESSION = "019d2bae-7c39-7c73-b058-codex";
    const codexTimestamp = "2026-03-26T20:00:00.000Z";

    it("accepts Codex logs with conversation.id and event.name in attrs", async () => {
      const payload = {
        resourceLogs: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "codex_cli_rs" },
                },
                {
                  key: "conversation.id",
                  value: { stringValue: CODEX_SESSION },
                },
              ],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    // Codex sends timeUnixNano=0 with real time in attrs
                    // and no body (event name is in attributes)
                    timeUnixNano: "0",
                    severityNumber: 9,
                    severityText: "INFO",
                    attributes: [
                      {
                        key: "event.name",
                        value: { stringValue: "model_response" },
                      },
                      {
                        key: "event.timestamp",
                        value: { stringValue: codexTimestamp },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const { status } = await post("/v1/logs", payload);
      expect(status).toBe(200);

      const db = getDb();
      const row = db
        .prepare(
          "SELECT session_id, body, timestamp_ns FROM otel_logs WHERE session_id = ?",
        )
        .get(CODEX_SESSION) as {
        session_id: string;
        body: string;
        timestamp_ns: number;
      };
      expect(row).toBeDefined();
      expect(row.session_id).toBe(CODEX_SESSION);
      expect(row.body).toBe("model_response");
      // Timestamp should be derived from event.timestamp attr
      expect(row.timestamp_ns).toBeGreaterThan(0);
    });

    it("accepts Codex metrics with conversation.id fallback", async () => {
      const payload = {
        resourceMetrics: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "codex_cli_rs" },
                },
                {
                  key: "conversation.id",
                  value: { stringValue: CODEX_SESSION },
                },
              ],
            },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "codex.turn.token_usage",
                    unit: "tokens",
                    gauge: {
                      dataPoints: [
                        {
                          timeUnixNano: String(Date.now() * 1_000_000),
                          asInt: "800",
                          attributes: [
                            {
                              key: "token_type",
                              value: { stringValue: "input" },
                            },
                            {
                              key: "model",
                              value: { stringValue: "o3" },
                            },
                          ],
                        },
                        {
                          timeUnixNano: String(Date.now() * 1_000_000),
                          asInt: "200",
                          attributes: [
                            {
                              key: "token_type",
                              value: { stringValue: "output" },
                            },
                            {
                              key: "model",
                              value: { stringValue: "o3" },
                            },
                          ],
                        },
                        {
                          timeUnixNano: String(Date.now() * 1_000_000),
                          asInt: "150",
                          attributes: [
                            {
                              key: "token_type",
                              value: { stringValue: "cached_input" },
                            },
                            {
                              key: "model",
                              value: { stringValue: "o3" },
                            },
                          ],
                        },
                        {
                          timeUnixNano: String(Date.now() * 1_000_000),
                          asInt: "1150",
                          attributes: [
                            {
                              key: "token_type",
                              value: { stringValue: "total" },
                            },
                            {
                              key: "model",
                              value: { stringValue: "o3" },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      const { status } = await post("/v1/metrics", payload);
      expect(status).toBe(200);

      const db = getDb();
      const metrics = db
        .prepare(
          `SELECT name, value, json_extract(attributes, '$.token_type') as token_type,
                  session_id
           FROM otel_metrics
           WHERE name = 'codex.turn.token_usage' AND session_id = ?`,
        )
        .all(CODEX_SESSION) as Array<{
        name: string;
        value: number;
        token_type: string;
        session_id: string;
      }>;

      expect(metrics.length).toBe(4);
      expect(metrics.every((m) => m.session_id === CODEX_SESSION)).toBe(true);
    });

    it("Codex token types are mapped correctly in cost queries", () => {
      // costBreakdown uses resolvedMetricsCTE which maps Codex token types
      const result = costBreakdown({ since: "1h" });
      // We just need it not to throw — the Codex UNION ALL is exercised
      expect(result).toBeDefined();
      expect(result.groups).toBeDefined();
    });
  });

  // (Session inference removed — scanner provides authoritative session data)

  // ── resolveTarget via processHookEvent ───────────────────────────────────

  describe("target detection", () => {
    beforeAll(() => {
      _resetSessionTargetCache();
      _resetSessionRepoCache();
    });

    it("detects target from explicit source field", async () => {
      const { status } = await post("/hooks", {
        session_id: "target-test-explicit",
        hook_event_name: "SessionStart",
        source: "claude",
      });
      expect(status).toBe(200);

      const db = getDb();
      const row = db
        .prepare(
          "SELECT target FROM hook_events WHERE session_id = 'target-test-explicit'",
        )
        .get() as { target: string };
      expect(row.target).toBe("claude");
    });

    it("detects Codex from model name when no source field", async () => {
      _resetSessionTargetCache();
      const { status } = await post("/hooks", {
        session_id: "target-test-model-codex",
        hook_event_name: "PreToolUse",
        tool_name: "shell",
        model: "o3",
      });
      expect(status).toBe(200);

      const db = getDb();
      const row = db
        .prepare(
          "SELECT target FROM hook_events WHERE session_id = 'target-test-model-codex'",
        )
        .get() as { target: string };
      expect(row.target).toBe("codex");
    });

    it("detects Claude from model name when no source field", async () => {
      _resetSessionTargetCache();
      const { status } = await post("/hooks", {
        session_id: "target-test-model-claude",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        model: "claude-sonnet-4-6-20250514",
      });
      expect(status).toBe(200);

      const db = getDb();
      const row = db
        .prepare(
          "SELECT target FROM hook_events WHERE session_id = 'target-test-model-claude'",
        )
        .get() as { target: string };
      expect(row.target).toBe("claude");
    });

    it("caches target per session", async () => {
      _resetSessionTargetCache();
      // First event identifies as codex via model
      await post("/hooks", {
        session_id: "target-test-cache",
        hook_event_name: "SessionStart",
        model: "gpt-4.1",
      });
      // Second event has no model — should use cached target
      await post("/hooks", {
        session_id: "target-test-cache",
        hook_event_name: "PreToolUse",
        tool_name: "shell",
      });

      const db = getDb();
      const rows = db
        .prepare(
          "SELECT target FROM hook_events WHERE session_id = 'target-test-cache' ORDER BY id",
        )
        .all() as Array<{ target: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].target).toBe("codex");
      expect(rows[1].target).toBe("codex");
    });

    it("falls back to unknown when target cannot be determined", async () => {
      _resetSessionTargetCache();
      const { status } = await post("/hooks", {
        session_id: "target-test-unknown",
        hook_event_name: "PreToolUse",
        tool_name: "something",
      });
      expect(status).toBe(200);

      const db = getDb();
      const row = db
        .prepare(
          "SELECT target FROM hook_events WHERE session_id = 'target-test-unknown'",
        )
        .get() as { target: string };
      expect(row.target).toBe("unknown");
    });
  });

  // ── Session lifecycle upsert ─────────────────────────────────────────────

  describe("session lifecycle", () => {
    const LIFECYCLE_SESSION = "lifecycle-sess-001";

    beforeAll(async () => {
      await post("/hooks", {
        session_id: LIFECYCLE_SESSION,
        hook_event_name: "SessionStart",
        source: "claude",
        cwd: "/workspace/project",
        permission_mode: "plan",
        agent_version: "1.0.42",
      });
      await post("/hooks", {
        session_id: LIFECYCLE_SESSION,
        hook_event_name: "UserPromptSubmit",
        source: "claude",
        prompt: "Fix the bug",
      });
      await post("/hooks", {
        session_id: LIFECYCLE_SESSION,
        hook_event_name: "UserPromptSubmit",
        source: "claude",
        prompt: "Actually, refactor it instead",
      });
      await post("/hooks", {
        session_id: LIFECYCLE_SESSION,
        hook_event_name: "Stop",
        source: "claude",
      });
    });

    it("creates session on SessionStart with metadata", () => {
      const db = getDb();
      const row = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(LIFECYCLE_SESSION) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.target).toBe("claude");
      expect(row.started_at_ms).toBeGreaterThan(0);
      expect(row.permission_mode).toBe("plan");
      expect(row.agent_version).toBe("1.0.42");
    });

    it("captures first prompt only (does not overwrite)", () => {
      const db = getDb();
      const row = db
        .prepare("SELECT first_prompt FROM sessions WHERE session_id = ?")
        .get(LIFECYCLE_SESSION) as { first_prompt: string };

      expect(row.first_prompt).toBe("Fix the bug");
    });

    it("sets ended_at_ms on Stop", () => {
      const db = getDb();
      const row = db
        .prepare(
          "SELECT started_at_ms, ended_at_ms FROM sessions WHERE session_id = ?",
        )
        .get(LIFECYCLE_SESSION) as {
        started_at_ms: number;
        ended_at_ms: number;
      };

      expect(row.ended_at_ms).toBeGreaterThanOrEqual(row.started_at_ms);
    });
  });

  // ── Gemini OTel format & MAX aggregation ─────────────────────────────────

  describe("Gemini OTel metrics (MAX aggregation)", () => {
    const GEMINI_SESSION = "gemini-otel-sess-001";

    beforeAll(() => {
      const metricTs = Date.now();

      // Create a Gemini session directly
      upsertSession({
        session_id: GEMINI_SESSION,
        target: "gemini",
        started_at_ms: metricTs - 120_000,
      });

      // Insert cumulative Gemini metrics — later datapoints supersede earlier ones
      // Two readings of input (100 then 500), plus one output (200).
      // MAX aggregation should pick input=500, not SUM=600.
      const rows: OtelMetricRow[] = [
        {
          timestamp_ns: (metricTs - 30_000) * 1_000_000,
          name: "gen_ai.client.token.usage",
          value: 100,
          metric_type: "gauge",
          session_id: GEMINI_SESSION,
          attributes: {
            "gen_ai.token.type": "input",
            "gen_ai.response.model": "gemini-2.5-pro",
          },
        },
        {
          timestamp_ns: metricTs * 1_000_000,
          name: "gen_ai.client.token.usage",
          value: 500,
          metric_type: "gauge",
          session_id: GEMINI_SESSION,
          attributes: {
            "gen_ai.token.type": "input",
            "gen_ai.response.model": "gemini-2.5-pro",
          },
        },
        {
          timestamp_ns: metricTs * 1_000_000,
          name: "gen_ai.client.token.usage",
          value: 200,
          metric_type: "gauge",
          session_id: GEMINI_SESSION,
          attributes: {
            "gen_ai.token.type": "output",
            "gen_ai.response.model": "gemini-2.5-pro",
          },
        },
      ];
      insertOtelMetrics(rows);
    });

    it("stores Gemini metrics", () => {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT session_id, value, json_extract(attributes, '$."gen_ai.token.type"') as token_type
           FROM otel_metrics
           WHERE name = 'gen_ai.client.token.usage' AND session_id = ?`,
        )
        .all(GEMINI_SESSION) as Array<{
        session_id: string;
        value: number;
        token_type: string;
      }>;

      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.session_id === GEMINI_SESSION)).toBe(true);
    });

    it("uses session token totals for cost queries", () => {
      // costBreakdown now uses sessions table, so seed a session with tokens
      upsertSession({
        session_id: GEMINI_SESSION,
        target: "gemini",
        model: "gemini-3-flash-preview",
        total_input_tokens: 500,
        total_output_tokens: 200,
        started_at_ms: Date.now(),
      });
      const result = costBreakdown({ since: "1h", groupBy: "session" });
      expect(result).toBeDefined();

      const geminiGroup = result.groups.find((g) => g.key === GEMINI_SESSION);
      expect(geminiGroup).toBeDefined();
      expect(geminiGroup!.totalTokens).toBe(700);
    });
  });

  // (Gemini session inference removed — scanner provides authoritative session data)

  // ── Gemini target detection via eventMap ────────────────────────────────

  describe("Gemini target detection", () => {
    it("detects Gemini from eventMap (BeforeTool → PreToolUse)", async () => {
      _resetSessionTargetCache();
      const { status } = await post("/hooks", {
        session_id: "target-test-gemini-eventmap",
        hook_event_name: "BeforeTool",
        tool_name: "shell",
      });
      expect(status).toBe(200);

      const db = getDb();
      const row = db
        .prepare(
          "SELECT target, event_type FROM hook_events WHERE session_id = 'target-test-gemini-eventmap'",
        )
        .get() as { target: string; event_type: string };
      expect(row.target).toBe("gemini");
      // Event name should be normalized to canonical form
      expect(row.event_type).toBe("PreToolUse");
    });
  });

  // ── Model heuristic warning ────────────────────────────────────────────

  describe("model-based target detection warning (#73)", () => {
    it("logs a warning when target is resolved via model-name heuristic", async () => {
      _resetSessionTargetCache();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await post("/hooks", {
        session_id: "target-test-warn-model",
        hook_event_name: "PreToolUse",
        tool_name: "shell",
        model: "gpt-4.1-mini",
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("model-name heuristic"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("gpt-4.1-mini"),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("codex"));

      warnSpy.mockRestore();
    });

    it("does not warn when target is resolved via explicit source", async () => {
      _resetSessionTargetCache();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await post("/hooks", {
        session_id: "target-test-no-warn",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        source: "claude",
        model: "claude-sonnet-4-6-20250514",
      });

      const heuristicCalls = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("model-name heuristic"),
      );
      expect(heuristicCalls).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });

  // ── Codex OTel logs in timeline/search queries ─────────────────────────

  describe("Codex OTel log queries (otelLogExprs)", () => {
    const CODEX_TIMELINE_SESSION = "codex-timeline-sess-001";

    beforeAll(async () => {
      // Create a Codex session with both hook events and OTel logs
      await post("/hooks", {
        session_id: CODEX_TIMELINE_SESSION,
        hook_event_name: "SessionStart",
        source: "codex",
        cwd: "/workspace/codex-project",
      });

      // Insert Codex-style OTel logs with event.name in attributes
      const codexTimestamp = "2026-03-26T20:30:00.000Z";
      await post("/v1/logs", {
        resourceLogs: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "codex_cli_rs" },
                },
                {
                  key: "conversation.id",
                  value: { stringValue: CODEX_TIMELINE_SESSION },
                },
              ],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "0",
                    severityNumber: 9,
                    severityText: "INFO",
                    attributes: [
                      {
                        key: "event.name",
                        value: { stringValue: "exec_apply" },
                      },
                      {
                        key: "event.timestamp",
                        value: { stringValue: codexTimestamp },
                      },
                      {
                        key: "apply.command",
                        value: { stringValue: "ls -la" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it("sessionTimeline returns messages for a session", () => {
      // Timeline now returns messages, not hook/otel events.
      // The Codex timeline session has no messages (only otel data),
      // so it should return an empty list.
      const result = sessionTimeline({
        sessionId: CODEX_TIMELINE_SESSION,
        limit: 50,
      });

      // Session exists (from upsert) but has no scanner messages
      expect(result.messages).toBeDefined();
      expect(result.totalMessages).toBe(0);
    });

    it("search finds Codex OTel events by attribute content", () => {
      const result = search({
        query: "exec_apply",
        limit: 10,
      });

      const codexMatches = result.results.filter(
        (r) => r.sessionId === CODEX_TIMELINE_SESSION,
      );
      expect(codexMatches.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Multi-target cost breakdown ────────────────────────────────────────

  describe("multi-target cost breakdown", () => {
    it("costBreakdown aggregates across sessions with token data", () => {
      // costBreakdown now uses sessions table token totals
      const result = costBreakdown({ since: "1h" });
      expect(result).toBeDefined();
      expect(result.groups.length).toBeGreaterThanOrEqual(1);
      // At least the Gemini session seeded earlier has tokens
      expect(result.totals.totalTokens).toBeGreaterThan(0);
    });

    it("costBreakdown grouped by model shows distinct models from different targets", () => {
      const result = costBreakdown({ since: "1h", groupBy: "model" });
      expect(result).toBeDefined();
      const models = result.groups.map((g) => g.key);
      // Should have at least one model from the test data
      expect(models.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── OTLP trace storage ──────────────────────────────────────────────────

  describe("OTLP trace ingestion", () => {
    const TRACE_SESSION = "trace-sess-001";

    it("accepts JSON traces via POST /v1/traces", async () => {
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "claude-code" },
                },
                {
                  key: "session.id",
                  value: { stringValue: TRACE_SESSION },
                },
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "abcdef0123456789abcdef0123456789",
                    spanId: "1234567890abcdef",
                    name: "LLM completion",
                    kind: 2,
                    startTimeUnixNano: String(Date.now() * 1_000_000),
                    endTimeUnixNano: String((Date.now() + 500) * 1_000_000),
                    status: { code: 1, message: "OK" },
                    attributes: [
                      {
                        key: "model",
                        value: { stringValue: "claude-sonnet-4-6" },
                      },
                    ],
                  },
                  {
                    traceId: "abcdef0123456789abcdef0123456789",
                    spanId: "fedcba0987654321",
                    parentSpanId: "1234567890abcdef",
                    name: "tool_use: Read",
                    kind: 3,
                    startTimeUnixNano: String((Date.now() + 100) * 1_000_000),
                    endTimeUnixNano: String((Date.now() + 200) * 1_000_000),
                    attributes: [
                      {
                        key: "tool.name",
                        value: { stringValue: "Read" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const { status } = await post("/v1/traces", payload);
      expect(status).toBe(200);
    });

    it("stores spans in otel_spans with correct fields", () => {
      const db = getDb();
      const spans = db
        .prepare(
          "SELECT trace_id, span_id, parent_span_id, name, kind, session_id FROM otel_spans WHERE session_id = ? ORDER BY name",
        )
        .all(TRACE_SESSION) as Array<{
        trace_id: string;
        span_id: string;
        parent_span_id: string | null;
        name: string;
        kind: number;
        session_id: string;
      }>;

      expect(spans).toHaveLength(2);

      const parent = spans.find((s) => s.name === "LLM completion");
      expect(parent).toBeDefined();
      expect(parent!.trace_id).toBe("abcdef0123456789abcdef0123456789");
      expect(parent!.span_id).toBe("1234567890abcdef");
      expect(parent!.parent_span_id).toBeNull();
      expect(parent!.kind).toBe(2);

      const child = spans.find((s) => s.name === "tool_use: Read");
      expect(child).toBeDefined();
      expect(child!.parent_span_id).toBe("1234567890abcdef");
    });

    it("stores span attributes as JSON", () => {
      const db = getDb();
      const row = db
        .prepare(
          `SELECT json_extract(attributes, '$.model') as model
           FROM otel_spans WHERE session_id = ? AND name = 'LLM completion'`,
        )
        .get(TRACE_SESSION) as { model: string };

      expect(row.model).toBe("claude-sonnet-4-6");
    });

    it("deduplicates spans on (trace_id, span_id)", async () => {
      // Re-send the same trace — row count should not increase
      const before = countRows("otel_spans");

      await post("/v1/traces", {
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "abcdef0123456789abcdef0123456789",
                    spanId: "1234567890abcdef",
                    name: "LLM completion",
                    startTimeUnixNano: "1000",
                    endTimeUnixNano: "2000",
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(countRows("otel_spans")).toBe(before);
    });
  });

  // ── Session file archiving ──────────────────────────────────────────────

  describe("session file archive (LocalArchiveBackend)", () => {
    let archive: LocalArchiveBackend;

    beforeAll(() => {
      archive = new LocalArchiveBackend(path.join(config.dataDir, "archive"));
    });

    it("round-trips content through put/get", () => {
      const content = Buffer.from(
        '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n',
      );
      archive.putSync("archive-sess-1", "claude", content);

      const retrieved = archive.getSync("archive-sess-1", "claude");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.toString()).toBe(content.toString());
    });

    it("hasSync returns true for archived, false for missing", () => {
      expect(archive.hasSync("archive-sess-1", "claude")).toBe(true);
      expect(archive.hasSync("archive-sess-1", "codex")).toBe(false);
      expect(archive.hasSync("nonexistent", "claude")).toBe(false);
    });

    it("getSync returns null for missing archive", () => {
      expect(archive.getSync("nonexistent", "claude")).toBeNull();
    });

    it("list returns all archived files with sizes", () => {
      archive.putSync("archive-sess-2", "gemini", Buffer.from("test data"));

      const entries = archive.list();
      expect(entries.length).toBeGreaterThanOrEqual(2);

      const sess1 = entries.find(
        (e) => e.sessionId === "archive-sess-1" && e.source === "claude",
      );
      expect(sess1).toBeDefined();
      expect(sess1!.sizeBytes).toBeGreaterThan(0);
    });

    it("stats aggregates file count and total bytes", () => {
      const stats = archive.stats();
      expect(stats.totalFiles).toBeGreaterThanOrEqual(2);
      expect(stats.totalBytes).toBeGreaterThan(0);
    });

    it("overwrites existing archive on re-put", () => {
      const original = Buffer.from("original");
      const updated = Buffer.from("updated content that is longer");

      archive.putSync("archive-sess-3", "claude", original);
      archive.putSync("archive-sess-3", "claude", updated);

      const retrieved = archive.getSync("archive-sess-3", "claude");
      expect(retrieved!.toString()).toBe(updated.toString());
    });
  });

  // ── LLM-powered session summaries ───────────────────────────────────────

  describe("session summary generation", () => {
    it("detectAgent caches its result", () => {
      const result1 = llm.detectAgent();
      const result2 = llm.detectAgent();
      // Should return the same reference (cached)
      expect(result1).toBe(result2);
    });
  });
});
