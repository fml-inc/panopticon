#!/usr/bin/env node

/**
 * Tier 1 integration test for Panopticon.
 *
 * Starts the real unified server, sends synthetic hook events and OTel JSON
 * payloads over HTTP, then queries the SQLite database to verify everything
 * was ingested and correlated correctly.
 *
 * Exit 0 = all checks pass, non-zero = failure.
 */

import { createUnifiedServer } from "../../dist/server.js";
import Database from "better-sqlite3";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const PORT = parseInt(process.env.PANOPTICON_PORT ?? "4318", 10);
const DATA_DIR = process.env.PANOPTICON_DATA_DIR ?? "/tmp/panopticon-test";
const DB_PATH = path.join(DATA_DIR, "data.db");
const BASE = `http://127.0.0.1:${PORT}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message} (expected ${expected}, got ${actual})`);
  }
}

function assertGte(actual, min, message) {
  if (actual >= min) {
    passed++;
    console.log(`  ✓ ${message} (${actual})`);
  } else {
    failed++;
    console.error(`  ✗ ${message} (expected >= ${min}, got ${actual})`);
  }
}

async function post(urlPath, body, contentType = "application/json") {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: JSON.stringify(body),
  });
  return res;
}

// ── Test data ────────────────────────────────────────────────────────────────

const SESSION_ID = "integ-test-session-001";
const SESSION_ID_2 = "integ-test-session-002";

const hookEvents = [
  {
    session_id: SESSION_ID,
    hook_event_name: "SessionStart",
    cwd: "/workspace/my-project",
  },
  {
    session_id: SESSION_ID,
    hook_event_name: "UserPromptSubmit",
    cwd: "/workspace/my-project",
    prompt: "Fix the login bug in auth.ts",
  },
  {
    session_id: SESSION_ID,
    hook_event_name: "PreToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Read",
    tool_input: { file_path: "/workspace/my-project/src/auth.ts" },
  },
  {
    session_id: SESSION_ID,
    hook_event_name: "PostToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Read",
    tool_input: { file_path: "/workspace/my-project/src/auth.ts" },
  },
  {
    session_id: SESSION_ID,
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
    session_id: SESSION_ID,
    hook_event_name: "PostToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Edit",
  },
  {
    session_id: SESSION_ID,
    hook_event_name: "PreToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  },
  {
    session_id: SESSION_ID,
    hook_event_name: "PostToolUse",
    cwd: "/workspace/my-project",
    tool_name: "Bash",
  },
  {
    session_id: SESSION_ID,
    hook_event_name: "Stop",
    cwd: "/workspace/my-project",
  },
  // Second session — verifies multi-session isolation
  {
    session_id: SESSION_ID_2,
    hook_event_name: "SessionStart",
    cwd: "/workspace/other-project",
  },
  {
    session_id: SESSION_ID_2,
    hook_event_name: "UserPromptSubmit",
    cwd: "/workspace/other-project",
    prompt: "Add a new API endpoint",
  },
  {
    session_id: SESSION_ID_2,
    hook_event_name: "Stop",
    cwd: "/workspace/other-project",
  },
];

// OTLP JSON log payload (matches OpenTelemetry JSON format)
const otelLogsPayload = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "claude-code" } },
          { key: "session.id", value: { stringValue: SESSION_ID } },
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
                {
                  key: "session.id",
                  value: { stringValue: SESSION_ID },
                },
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
                {
                  key: "session.id",
                  value: { stringValue: SESSION_ID },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// OTLP JSON metrics payload
const otelMetricsPayload = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "claude-code" } },
          { key: "session.id", value: { stringValue: SESSION_ID } },
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
                        value: { stringValue: SESSION_ID },
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
                        value: { stringValue: SESSION_ID },
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

// ── Mock Anthropic API response ──────────────────────────────────────────────

const MOCK_ANTHROPIC_RESPONSE = {
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
};

const MOCK_ANTHROPIC_REQUEST = {
  model: "claude-sonnet-4-6-20250514",
  max_tokens: 4096,
  messages: [
    { role: "user", content: "Read the index.ts file and tell me what it does" },
  ],
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  // Ensure clean data dir
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ── Set up mock upstream for proxy tests ─────────────────────────────
  let mockUpstream = null;
  let proxyTestsEnabled = false;
  let mockRequestsReceived = [];

  try {
    // Check if we can set up the mock (need openssl + write access to /etc/hosts)
    const { execSync } = await import("node:child_process");

    // Generate self-signed cert
    const certDir = "/tmp/mock-certs";
    fs.mkdirSync(certDir, { recursive: true });
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${certDir}/key.pem -out ${certDir}/cert.pem -days 1 -nodes -subj "/CN=api.anthropic.com" 2>/dev/null`,
    );
    const tlsOpts = {
      key: fs.readFileSync(`${certDir}/key.pem`),
      cert: fs.readFileSync(`${certDir}/cert.pem`),
    };

    // Start mock HTTPS server on port 443
    mockUpstream = https.createServer(tlsOpts, (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        mockRequestsReceived.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body ? JSON.parse(body) : null,
        });

        // Return canned Anthropic response
        if (req.url.includes("/v1/messages")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(MOCK_ANTHROPIC_RESPONSE));
        } else {
          res.writeHead(404);
          res.end("{}");
        }
      });
    });

    await new Promise((resolve, reject) => {
      mockUpstream.on("error", reject);
      mockUpstream.listen(443, "127.0.0.1", resolve);
    });

    // Redirect api.anthropic.com to localhost
    const hostsLine = "127.0.0.1 api.anthropic.com\n";
    fs.appendFileSync("/etc/hosts", hostsLine);

    proxyTestsEnabled = true;
    console.log("Mock upstream HTTPS server started on :443");
    console.log("Proxy tests: ENABLED\n");
  } catch (err) {
    console.log(`Proxy tests: SKIPPED (${err.message})\n`);
  }

  console.log("Starting panopticon server...");
  const server = createUnifiedServer();

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
  console.log(`Server listening on 127.0.0.1:${PORT}\n`);

  try {
    // ── 1. Health check ────────────────────────────────────────────────
    console.log("1. Health check");
    const healthRes = await fetch(`${BASE}/health`);
    assertEqual(healthRes.status, 200, "GET /health returns 200");
    const healthBody = await healthRes.json();
    assertEqual(healthBody.status, "ok", "Health response has status: ok");

    // ── 2. Hook event ingestion ────────────────────────────────────────
    console.log("\n2. Hook event ingestion");
    for (const event of hookEvents) {
      const res = await post("/hooks", event);
      assertEqual(res.status, 200, `POST /hooks ${event.hook_event_name} (${event.session_id.slice(-3)}) returns 200`);
    }

    // ── 3. OTel log ingestion (JSON) ───────────────────────────────────
    console.log("\n3. OTel log ingestion (JSON)");
    const logsRes = await post("/v1/logs", otelLogsPayload);
    assertEqual(logsRes.status, 200, "POST /v1/logs returns 200");

    // ── 4. OTel metrics ingestion (JSON) ───────────────────────────────
    console.log("\n4. OTel metrics ingestion (JSON)");
    const metricsRes = await post("/v1/metrics", otelMetricsPayload);
    assertEqual(metricsRes.status, 200, "POST /v1/metrics returns 200");

    // ── 5. Verify database state ───────────────────────────────────────
    console.log("\n5. Database verification");

    const db = new Database(DB_PATH, { readonly: true });
    db.function("decompress", (blob) =>
      blob ? gunzipSync(blob).toString() : null,
    );

    // Hook events count
    const hookCount = db
      .prepare("SELECT COUNT(*) as c FROM hook_events")
      .get().c;
    assertEqual(hookCount, hookEvents.length, `hook_events has ${hookEvents.length} rows`);

    // Session isolation
    const sess1Count = db
      .prepare("SELECT COUNT(*) as c FROM hook_events WHERE session_id = ?")
      .get(SESSION_ID).c;
    assertEqual(sess1Count, 9, "Session 1 has 9 hook events");

    const sess2Count = db
      .prepare("SELECT COUNT(*) as c FROM hook_events WHERE session_id = ?")
      .get(SESSION_ID_2).c;
    assertEqual(sess2Count, 3, "Session 2 has 3 hook events");

    // Event types stored correctly
    const eventTypes = db
      .prepare(
        "SELECT DISTINCT event_type FROM hook_events WHERE session_id = ? ORDER BY event_type",
      )
      .all(SESSION_ID)
      .map((r) => r.event_type);
    assert(eventTypes.includes("SessionStart"), "Has SessionStart event");
    assert(eventTypes.includes("UserPromptSubmit"), "Has UserPromptSubmit event");
    assert(eventTypes.includes("PreToolUse"), "Has PreToolUse event");
    assert(eventTypes.includes("PostToolUse"), "Has PostToolUse event");
    assert(eventTypes.includes("Stop"), "Has Stop event");

    // Tool names extracted correctly
    const toolNames = db
      .prepare(
        "SELECT DISTINCT tool_name FROM hook_events WHERE session_id = ? AND tool_name IS NOT NULL ORDER BY tool_name",
      )
      .all(SESSION_ID)
      .map((r) => r.tool_name);
    assert(toolNames.includes("Read"), "Tool name 'Read' extracted");
    assert(toolNames.includes("Edit"), "Tool name 'Edit' extracted");
    assert(toolNames.includes("Bash"), "Tool name 'Bash' extracted");

    // Extracted columns populated
    const promptRow = db
      .prepare(
        "SELECT user_prompt FROM hook_events WHERE session_id = ? AND event_type = 'UserPromptSubmit'",
      )
      .get(SESSION_ID);
    assertEqual(
      promptRow.user_prompt,
      "Fix the login bug in auth.ts",
      "user_prompt column extracted correctly",
    );

    const filePathRow = db
      .prepare(
        "SELECT file_path FROM hook_events WHERE session_id = ? AND tool_name = 'Read' AND event_type = 'PreToolUse'",
      )
      .get(SESSION_ID);
    assertEqual(
      filePathRow.file_path,
      "/workspace/my-project/src/auth.ts",
      "file_path column extracted correctly",
    );

    const commandRow = db
      .prepare(
        "SELECT command FROM hook_events WHERE session_id = ? AND tool_name = 'Bash' AND event_type = 'PreToolUse'",
      )
      .get(SESSION_ID);
    assertEqual(commandRow.command, "npm test", "command column extracted correctly");

    // Payload is compressed and decompressible
    const payloadRow = db
      .prepare(
        "SELECT decompress(payload) as p FROM hook_events WHERE session_id = ? AND event_type = 'SessionStart'",
      )
      .get(SESSION_ID);
    const decompressed = JSON.parse(payloadRow.p);
    assert(typeof decompressed === "object", "Payload decompresses to valid JSON");

    // FTS index populated
    const ftsCount = db
      .prepare("SELECT COUNT(*) as c FROM hook_events_fts")
      .get().c;
    assertEqual(ftsCount, hookEvents.length, "FTS index has matching row count");

    // FTS search works
    const ftsResults = db
      .prepare(
        "SELECT COUNT(*) as c FROM hook_events_fts WHERE payload MATCH '\"npm test\"'",
      )
      .get().c;
    assertGte(ftsResults, 1, "FTS search for 'npm test' finds results");

    // CWD tracking
    const cwds = db
      .prepare("SELECT DISTINCT cwd FROM session_cwds WHERE session_id = ?")
      .all(SESSION_ID)
      .map((r) => r.cwd);
    assert(
      cwds.includes("/workspace/my-project"),
      "session_cwds tracks cwd for session 1",
    );

    const cwds2 = db
      .prepare("SELECT DISTINCT cwd FROM session_cwds WHERE session_id = ?")
      .all(SESSION_ID_2)
      .map((r) => r.cwd);
    assert(
      cwds2.includes("/workspace/other-project"),
      "session_cwds tracks cwd for session 2",
    );

    // ── 6. Verify OTel data ────────────────────────────────────────────
    console.log("\n6. OTel data verification");

    const logCount = db
      .prepare("SELECT COUNT(*) as c FROM otel_logs")
      .get().c;
    assertEqual(logCount, 2, "otel_logs has 2 rows");

    const logSession = db
      .prepare(
        "SELECT COUNT(*) as c FROM otel_logs WHERE session_id = ?",
      )
      .get(SESSION_ID).c;
    assertEqual(logSession, 2, "OTel logs correlated to correct session");

    const logBodies = db
      .prepare("SELECT body FROM otel_logs ORDER BY timestamp_ns")
      .all()
      .map((r) => r.body);
    assert(
      logBodies.includes("claude_code.tool_decision"),
      "OTel log body 'claude_code.tool_decision' stored",
    );
    assert(
      logBodies.includes("claude_code.user_prompt"),
      "OTel log body 'claude_code.user_prompt' stored",
    );

    const metricCount = db
      .prepare("SELECT COUNT(*) as c FROM otel_metrics")
      .get().c;
    assertEqual(metricCount, 2, "otel_metrics has 2 rows (input + output)");

    const metricSession = db
      .prepare(
        "SELECT COUNT(*) as c FROM otel_metrics WHERE session_id = ?",
      )
      .get(SESSION_ID).c;
    assertEqual(metricSession, 2, "OTel metrics correlated to correct session");

    const metricNames = db
      .prepare("SELECT DISTINCT name FROM otel_metrics")
      .all()
      .map((r) => r.name);
    assert(
      metricNames.includes("claude_code.token.usage"),
      "Metric name 'claude_code.token.usage' stored",
    );

    // ── 7. Edge cases ────────────────────────────────────────────────────
    console.log("\n7. Edge cases");
    const notFoundRes = await fetch(`${BASE}/nonexistent`);
    assertEqual(notFoundRes.status, 404, "Unknown route returns 404");

    // Invalid JSON to /hooks
    const badRes = await fetch(`${BASE}/hooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assertEqual(badRes.status, 500, "Invalid JSON to /hooks returns 500");

    db.close();

    // ── 8. Proxy path tests ────────────────────────────────────────────
    console.log("\n8. Proxy path tests");

    // 8a. Unknown vendor returns 404
    const proxyUnknownRes = await post("/proxy/badvendor/v1/messages", { msg: "test" });
    assertEqual(proxyUnknownRes.status, 404, "Proxy unknown vendor returns 404");
    const proxyUnknownBody = await proxyUnknownRes.json();
    assertEqual(proxyUnknownBody.error, "unknown_route", "Proxy 404 has error: unknown_route");

    // 8b. Non-POST to proxy returns 405
    const proxyGetRes = await fetch(`${BASE}/proxy/claude/v1/messages`);
    assertEqual(proxyGetRes.status, 405, "GET to proxy route returns 405");

    if (proxyTestsEnabled) {
      // Record DB counts before proxy test
      const dbBefore = new Database(DB_PATH, { readonly: true });
      const hooksBefore = dbBefore.prepare("SELECT COUNT(*) as c FROM hook_events").get().c;
      const metricsBefore = dbBefore.prepare("SELECT COUNT(*) as c FROM otel_metrics").get().c;
      const logsBefore = dbBefore.prepare("SELECT COUNT(*) as c FROM otel_logs").get().c;
      dbBefore.close();

      // 8c. Proxy forwards to mock upstream and captures the exchange
      console.log("\n  Proxy → mock upstream (Anthropic):");
      const proxyRes = await fetch(`${BASE}/proxy/claude/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "sk-ant-test-fake-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(MOCK_ANTHROPIC_REQUEST),
      });

      assertEqual(proxyRes.status, 200, "Proxy returns 200 from mock upstream");
      const proxyBody = await proxyRes.json();
      assertEqual(proxyBody.id, "msg_mock_001", "Proxy forwards upstream response body");
      assertEqual(proxyBody.model, "claude-sonnet-4-6-20250514", "Response model preserved");

      // Verify mock upstream received the request
      assertGte(mockRequestsReceived.length, 1, "Mock upstream received request(s)");
      const mockReq = mockRequestsReceived[mockRequestsReceived.length - 1];
      assert(mockReq.url.includes("/v1/messages"), "Mock received /v1/messages request");
      assertEqual(mockReq.body?.model, "claude-sonnet-4-6-20250514", "Request body forwarded correctly");

      // Give the async emitters a moment to flush to DB
      await new Promise((r) => setTimeout(r, 200));

      // 8d. Verify proxy captured data in the database
      console.log("\n  Proxy capture verification:");
      const dbAfter = new Database(DB_PATH, { readonly: true });
      dbAfter.function("decompress", (blob) =>
        blob ? gunzipSync(blob).toString() : null,
      );

      // Hook events emitted by proxy
      const hooksAfter = dbAfter.prepare("SELECT COUNT(*) as c FROM hook_events").get().c;
      const proxyHookCount = hooksAfter - hooksBefore;
      assertGte(proxyHookCount, 2, `Proxy emitted hook events (${proxyHookCount} new)`);

      // Check for proxy-emitted SessionStart
      const proxySessionStarts = dbAfter
        .prepare(
          `SELECT * FROM hook_events
           WHERE event_type = 'SessionStart'
           AND decompress(payload) LIKE '%"source":"proxy"%'`,
        )
        .all();
      assertGte(proxySessionStarts.length, 1, "Proxy emitted SessionStart event");

      // Check for proxy-emitted UserPromptSubmit (extracted from request messages)
      const proxyPrompts = dbAfter
        .prepare(
          `SELECT user_prompt FROM hook_events
           WHERE event_type = 'UserPromptSubmit'
           AND decompress(payload) LIKE '%"source":"proxy"%'`,
        )
        .all();
      assertGte(proxyPrompts.length, 1, "Proxy emitted UserPromptSubmit event");

      // Check for proxy-emitted PreToolUse (extracted from tool_use response blocks)
      const proxyToolUse = dbAfter
        .prepare(
          `SELECT tool_name FROM hook_events
           WHERE event_type = 'PreToolUse'
           AND decompress(payload) LIKE '%"source":"proxy"%'`,
        )
        .all();
      assertGte(proxyToolUse.length, 1, "Proxy emitted PreToolUse event");
      if (proxyToolUse.length > 0) {
        assertEqual(proxyToolUse[0].tool_name, "Read", "Proxy extracted tool name 'Read' from response");
      }

      // OTel metrics emitted by proxy (token usage)
      const metricsAfter = dbAfter.prepare("SELECT COUNT(*) as c FROM otel_metrics").get().c;
      const proxyMetricCount = metricsAfter - metricsBefore;
      assertGte(proxyMetricCount, 2, `Proxy emitted token metrics (${proxyMetricCount} new)`);

      // Verify token metric values
      const proxyTokenMetrics = dbAfter
        .prepare(
          `SELECT name, value, json_extract(attributes, '$.token_type') as token_type,
                  json_extract(attributes, '$.source') as source
           FROM otel_metrics
           WHERE json_extract(attributes, '$.source') = 'proxy'
           ORDER BY id DESC LIMIT 10`,
        )
        .all();
      const inputMetric = proxyTokenMetrics.find((m) => m.token_type === "input");
      const outputMetric = proxyTokenMetrics.find((m) => m.token_type === "output");
      assert(inputMetric !== undefined, "Proxy captured input token metric");
      assert(outputMetric !== undefined, "Proxy captured output token metric");
      if (inputMetric) {
        assertEqual(inputMetric.value, 1200, "Input token count matches mock response");
      }
      if (outputMetric) {
        assertEqual(outputMetric.value, 85, "Output token count matches mock response");
      }

      // Check for cache metrics too
      const cacheReadMetric = proxyTokenMetrics.find((m) => m.token_type === "cacheRead");
      assert(cacheReadMetric !== undefined, "Proxy captured cache_read token metric");
      if (cacheReadMetric) {
        assertEqual(cacheReadMetric.value, 300, "Cache read token count matches mock response");
      }

      // OTel logs emitted by proxy (api_request)
      const logsAfter = dbAfter.prepare("SELECT COUNT(*) as c FROM otel_logs").get().c;
      const proxyLogCount = logsAfter - logsBefore;
      assertGte(proxyLogCount, 1, `Proxy emitted OTel log(s) (${proxyLogCount} new)`);

      const proxyApiLogs = dbAfter
        .prepare(
          `SELECT body, json_extract(attributes, '$.source') as source,
                  json_extract(attributes, '$.model') as model,
                  json_extract(attributes, '$.vendor') as vendor
           FROM otel_logs
           WHERE body = 'api_request'
           AND json_extract(attributes, '$.source') = 'proxy'`,
        )
        .all();
      assertGte(proxyApiLogs.length, 1, "Proxy emitted 'api_request' log entry");
      if (proxyApiLogs.length > 0) {
        assertEqual(proxyApiLogs[0].model, "claude-sonnet-4-6-20250514", "Log has correct model");
        assertEqual(proxyApiLogs[0].vendor, "claude", "Log has vendor: claude");
      }

      dbAfter.close();
    } else {
      console.log("  (proxy upstream tests skipped — mock not available)");
    }

    // ── Summary ────────────────────────────────────────────────────────
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (!proxyTestsEnabled) {
      console.log("  (proxy upstream tests were skipped)");
    }
    console.log("=".repeat(50));

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    server.close();
    if (mockUpstream) mockUpstream.close();
  }
}

run().catch((err) => {
  console.error("Integration test crashed:", err);
  process.exit(2);
});
