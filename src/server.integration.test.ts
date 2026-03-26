/**
 * Integration tests for the unified panopticon server.
 *
 * Starts the real HTTP server against a temp SQLite database and exercises:
 *   - Hook event ingestion via POST /hooks
 *   - OTel JSON log & metric ingestion via POST /v1/logs and /v1/metrics
 *   - Proxy route validation (404, 405)
 *   - Proxy capture → DB pipeline (format parsers + emit functions)
 *   - Database state: session isolation, column extraction, FTS, compression
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
import { config } from "./config.js";
import { closeDb, getDb } from "./db/schema.js";
import {
  emitHookEventAsync,
  emitOtelLogs,
  emitOtelMetrics,
} from "./proxy/emit.js";
import { anthropicParser } from "./proxy/formats/anthropic.js";
import { createUnifiedServer } from "./server.js";

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
});
