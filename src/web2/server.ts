import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  addChatMessage,
  createChat,
  deleteChat,
  getChat,
  getChatMessages,
  listChats,
  updateChat,
} from "../db/chats.js";
import {
  costBreakdown,
  dbStats,
  getEvent,
  listSessions,
  rawQuery,
  searchEvents,
  sessionTimeline,
  toolStats,
} from "../db/query.js";
import {
  deleteSessionLabel,
  getSessionLabel,
  setSessionLabel,
} from "../db/session-labels.js";
import {
  createWidget,
  deleteWidget,
  executeWidgetQuery,
  listWidgets,
  updateWidget,
} from "../db/widgets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Port is resolved at startup and injected into the AI system prompt
let serverPort = 3000;

// API token generated at startup — required for write endpoints (POST/PUT/DELETE on /api/v2/)
const apiToken = crypto.randomUUID();

// Auth middleware: protects write endpoints, GETs are open
app.use("/api/v2/", (req, res, next) => {
  if (req.method === "GET") return next();
  const token =
    (req.query.token as string) ||
    req.headers.authorization?.replace("Bearer ", "");
  if (token === apiToken) return next();
  // Allow same-origin frontend requests via browser-set headers
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "same-origin" || fetchSite === "same-site") return next();
  // Also allow if Origin or Referer matches the server
  const origin = req.headers.origin || req.headers.referer || "";
  if (
    origin &&
    (origin.includes("localhost:") ||
      origin.includes("127.0.0.1:") ||
      origin.includes(".ts.net"))
  )
    return next();
  res.status(401).json({
    error:
      "Unauthorized — include ?token=<token> or Authorization: Bearer <token>",
  });
});

const DB_SCHEMA = `hook_events(id, session_id, event_type, timestamp_ms, cwd, repository, tool_name, payload JSON)
otel_logs(id, timestamp_ns, severity_text, body, attributes JSON, session_id, prompt_id, trace_id)
otel_metrics(id, timestamp_ns, name, value, metric_type, unit, attributes JSON, session_id)
widgets(id TEXT PK, type TEXT, title TEXT, query TEXT, config TEXT, position INTEGER, created_at, updated_at)

VIEW v_resolved_tokens(session_id, model, token_type, tokens, timestamp_ns)
  -- Pre-deduped token data. Handles Gemini cumulative counters (MAX) vs Claude per-request (SUM).
  -- token_type: 'input' | 'output' | 'cacheRead' | 'cacheCreation' | 'cache' | 'thought' | 'tool'
  -- model: 'claude-opus-4-6', 'claude-sonnet-4-20250514', 'gemini-2.5-flash', etc.
  -- ALWAYS use this view for token/cost queries instead of raw otel_metrics.`;

function buildSystemPrompt(): string {
  const base = `http://localhost:${serverPort}`;
  return `You are an AI assistant for Panopticon, an observability tool for Claude Code and Gemini CLI sessions.

DB Schema (SQLite):
${DB_SCHEMA}

API TOKEN: ${apiToken}
Include ?token=${apiToken} on all POST/PUT/DELETE requests (GETs don't need it).

DATA ENDPOINTS (read-only, no token needed):
- GET ${base}/api/v2/stats — DB row counts
- GET ${base}/api/v2/sessions — List sessions
- GET ${base}/api/v2/sessions/:id?limit=100&offset=0 — Session timeline
- GET ${base}/api/v2/events/:source/:id — Full event details (source: hook|otel)
- GET ${base}/api/v2/metrics — Tool stats + cost breakdown
- GET ${base}/api/v2/search?q=<query> — Full-text search
- POST ${base}/api/v2/query-preview?token=${apiToken} — Run ad-hoc SQL: {"sql": "SELECT ..."}

WIDGET CRUD ENDPOINTS (require token):
- GET  ${base}/api/v2/widgets — List all widgets
- POST ${base}/api/v2/widgets?token=${apiToken} — Create widget
  Body: {"type":"chart|table|kpi|markdown","title":"...","query":"SELECT ...","config":{...},"position":0}
- PUT  ${base}/api/v2/widgets/:id?token=${apiToken} — Update widget (partial update)
  Body: any subset of {"title","query","config","position"}
- DELETE ${base}/api/v2/widgets/:id?token=${apiToken} — Delete widget
- GET  ${base}/api/v2/widgets/:id/data — Execute widget query and return data

Widget types and config options:
- chart: {"chartType":"bar"|"line"|"area", "xKey":"column", "yKeys":["col1","col2"], "colors":["#3b82f6","#10b981"]}
- kpi: {"valueKey":"column", "format":"number"|"currency"|"percent", "prefix":"$", "suffix":" sessions"}
- table: {"pageSize": 50}
- markdown: {"template":"# {{column}}"}

COST FORMULA (use in widget SQL when you need dollar amounts):
  CASE
    WHEN model LIKE 'claude-opus%' THEN
      CASE WHEN token_type='input' THEN tokens*0.000015 WHEN token_type='output' THEN tokens*0.000075
           WHEN token_type IN ('cache','cacheRead') THEN tokens*0.0000015 WHEN token_type='cacheCreation' THEN tokens*0.00001875 ELSE 0 END
    WHEN model LIKE 'claude-sonnet%' THEN
      CASE WHEN token_type='input' THEN tokens*0.000003 WHEN token_type='output' THEN tokens*0.000015
           WHEN token_type IN ('cache','cacheRead') THEN tokens*0.0000003 WHEN token_type='cacheCreation' THEN tokens*0.00000375 ELSE 0 END
    WHEN model LIKE 'claude-haiku%' THEN
      CASE WHEN token_type='input' THEN tokens*0.0000008 WHEN token_type='output' THEN tokens*0.000004
           WHEN token_type IN ('cache','cacheRead') THEN tokens*0.00000008 WHEN token_type='cacheCreation' THEN tokens*0.000001 ELSE 0 END
    WHEN model LIKE '%flash%' THEN
      CASE WHEN token_type='input' THEN tokens*0.000000075 WHEN token_type='output' THEN tokens*0.0000003 ELSE 0 END
    WHEN model LIKE '%pro%' THEN
      CASE WHEN token_type='input' THEN tokens*0.00000125 WHEN token_type='output' THEN tokens*0.000005 ELSE 0 END
    ELSE 0 END

EXAMPLE WIDGET QUERIES (always use v_resolved_tokens for token/cost data):

-- Total cost KPI:
SELECT ROUND(SUM(<cost_formula>), 2) as value FROM v_resolved_tokens

-- Cost by model (chart):
SELECT CASE WHEN model LIKE '%opus%' THEN 'Opus' WHEN model LIKE '%sonnet%' THEN 'Sonnet' WHEN model LIKE '%haiku%' THEN 'Haiku' WHEN model LIKE '%flash%' THEN 'Flash' WHEN model LIKE '%pro%' THEN 'Pro' ELSE model END as model_name, ROUND(SUM(<cost_formula>), 2) as cost FROM v_resolved_tokens GROUP BY model_name HAVING cost > 0 ORDER BY cost DESC

-- Daily cost trend (chart):
SELECT date(timestamp_ns/1000000000, 'unixepoch') as day, ROUND(SUM(<cost_formula>), 2) as cost FROM v_resolved_tokens GROUP BY day ORDER BY day

-- Tokens by model (chart with input/output/cache breakdown):
SELECT CASE WHEN model LIKE '%opus%' THEN 'Opus' WHEN model LIKE '%sonnet%' THEN 'Sonnet' ELSE model END as model_name, ROUND(SUM(CASE WHEN token_type='input' THEN tokens ELSE 0 END)/1e6, 1) as input_M, ROUND(SUM(CASE WHEN token_type='output' THEN tokens ELSE 0 END)/1e6, 1) as output_M, ROUND(SUM(CASE WHEN token_type IN ('cache','cacheRead') THEN tokens ELSE 0 END)/1e6, 1) as cache_M FROM v_resolved_tokens GROUP BY model_name ORDER BY (input_M+output_M) DESC

CRITICAL: NEVER query otel_metrics directly for token/cost data — always use v_resolved_tokens. Raw otel_metrics has cumulative Gemini counters that produce wildly wrong results with SUM().

Widget workflow:
1. Use panopticon tools (panopticon_query, panopticon_costs, etc.) to verify the query works
2. Use curl to POST/PUT to create or update widgets on the dashboard
3. Use panopticon_ui_add_widget / panopticon_ui_update_widget tools as an alternative to curl

IMPORTANT RULES:
- You are running in non-interactive print mode. NEVER use AskUserQuestion, EnterPlanMode, or other interactive tools.
- For querying data, prefer the panopticon tools (panopticon_query, panopticon_sessions, panopticon_costs, etc.).
- For creating/updating widgets, use curl with the token or the widget MCP tools.
- Always respond concisely.`;
}

// API Endpoints
app.get("/api/v2/stats", (_req, res) => {
  res.json(dbStats());
});

app.get("/api/v2/sessions", (_req, res) => {
  res.json(listSessions({ limit: 50 }));
});

app.get("/api/v2/sessions/:id", (req, res) => {
  const sessionId = req.params.id;
  const limit = parseInt(req.query.limit as string, 10) || 1000;
  const offset = parseInt(req.query.offset as string, 10) || 0;
  const timeline = sessionTimeline({
    session_id: sessionId,
    limit,
    offset,
    full_payloads: false,
  });
  res.json(timeline);
});

app.get("/api/v2/events/:source/:id", (req, res) => {
  const { source, id } = req.params;
  const ev = getEvent({
    source: source as "hook" | "otel",
    id: parseInt(id, 10),
  });

  if (!ev) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  if (ev.payload && typeof ev.payload === "string") {
    try {
      ev.payload = JSON.parse(ev.payload);
    } catch (_e) {}
  }

  res.json(ev);
});

app.get("/api/v2/metrics", (_req, res) => {
  const stats = toolStats();
  const costs = costBreakdown({ group_by: "day" });
  const modelCosts = costBreakdown({ group_by: "model" });
  res.json({ stats, costs, modelCosts });
});

app.get("/api/v2/search", (req, res) => {
  const q = req.query.q as string;
  if (!q) {
    res.json({ total: 0, rows: [] });
    return;
  }
  const results = searchEvents({ query: q, limit: 100 });
  res.json(results);
});

// Widget CRUD
app.get("/api/v2/widgets", (_req, res) => {
  const widgets = listWidgets().map((w) => ({
    ...w,
    config: typeof w.config === "string" ? JSON.parse(w.config) : w.config,
  }));
  res.json(widgets);
});

app.post("/api/v2/widgets", (req, res) => {
  try {
    const { type, title, query, config, position } = req.body;
    if (!type || !title || !query) {
      res.status(400).json({ error: "type, title, and query are required" });
      return;
    }
    const widget = createWidget({ type, title, query, config, position });
    res.status(201).json({
      ...widget,
      config:
        typeof widget.config === "string"
          ? JSON.parse(widget.config)
          : widget.config,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/v2/widgets/:id", (req, res) => {
  const { title, query, config, position } = req.body;
  const updated = updateWidget(req.params.id, {
    title,
    query,
    config,
    position,
  });
  if (!updated) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  res.json({
    ...updated,
    config:
      typeof updated.config === "string"
        ? JSON.parse(updated.config)
        : updated.config,
  });
});

app.delete("/api/v2/widgets/:id", (req, res) => {
  const removed = deleteWidget(req.params.id);
  if (removed) {
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Widget not found" });
  }
});

app.get("/api/v2/widgets/:id/data", (req, res) => {
  try {
    const data = executeWidgetQuery(req.params.id);
    res.json(data);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/v2/query-preview", (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql) {
      res.status(400).json({ error: "sql is required" });
      return;
    }
    const rows = rawQuery(sql) as Record<string, any>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    res.json({ columns, rows });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Chat CRUD
app.get("/api/v2/chats", (_req, res) => {
  res.json(listChats());
});

app.post("/api/v2/chats", (req, res) => {
  const { title } = req.body || {};
  const chat = createChat(title);
  res.status(201).json(chat);
});

app.get("/api/v2/chats/:id", (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  const messages = getChatMessages(req.params.id);
  res.json({ ...chat, messages });
});

app.put("/api/v2/chats/:id", (req, res) => {
  const { title } = req.body || {};
  const chat = updateChat(req.params.id, { title });
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  res.json(chat);
});

app.delete("/api/v2/chats/:id", (req, res) => {
  const removed = deleteChat(req.params.id);
  if (removed) {
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Chat not found" });
  }
});

app.post("/api/v2/chats/:id/messages", (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  const { role, content, tool_calls, cost } = req.body;
  if (!role || content == null) {
    res.status(400).json({ error: "role and content are required" });
    return;
  }
  const msg = addChatMessage(req.params.id, {
    role,
    content,
    tool_calls,
    cost,
  });
  res.status(201).json(msg);
});

// Session labels
app.get("/api/v2/sessions/:id/label", (req, res) => {
  const name = getSessionLabel(req.params.id);
  res.json({ session_id: req.params.id, name });
});

app.put("/api/v2/sessions/:id/label", (req, res) => {
  const { name } = req.body || {};
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  setSessionLabel(req.params.id, name);
  res.json({ session_id: req.params.id, name });
});

app.delete("/api/v2/sessions/:id/label", (req, res) => {
  deleteSessionLabel(req.params.id);
  res.json({ ok: true });
});

// AI Analyze Endpoint — spawns Claude, streams response as SSE
// @ts-expect-error Express 5 auto-resolves async handlers which closes SSE; use sync handler
app.post("/api/v2/analyze", (req: any, res: any) => {
  const { prompt, model } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);
  res.flushHeaders();

  res.write(
    `event: status\ndata: ${JSON.stringify({ status: "starting" })}\n\n`,
  );

  const systemPrompt = buildSystemPrompt();
  const cliArgs = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    systemPrompt,
  ];
  if (model) cliArgs.push("--model", model);

  // Strip env vars that prevent claude from running as a nested subprocess.
  // Keep CLAUDE_CODE_ENABLE_TELEMETRY so panopticon still collects data.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }

  // Spawn via sh -c to avoid inheriting Node.js IPC channels that cause claude to hang.
  const shellCmd = ["claude", ...cliArgs]
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const claudeProcess = spawn("sh", ["-c", shellCmd], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let jsonBuffer = "";
  let lastTextContent = "";

  claudeProcess.stdout.on("data", (data) => {
    jsonBuffer += data.toString();
    const lines = jsonBuffer.split("\n");
    jsonBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);

        if (json.type === "assistant" && json.message?.content) {
          for (const block of json.message.content) {
            if (block.type === "text" && block.text) {
              const newText = block.text.startsWith(lastTextContent)
                ? block.text.slice(lastTextContent.length)
                : block.text;
              if (newText) {
                res.write(
                  `event: text\ndata: ${JSON.stringify({ content: newText })}\n\n`,
                );
                lastTextContent = block.text;
              }
            } else if (block.type === "tool_use") {
              res.write(
                `event: tool_use_start\ndata: ${JSON.stringify({ name: block.name, id: block.id, input: block.input })}\n\n`,
              );
            } else if (block.type === "tool_result") {
              res.write(
                `event: tool_result\ndata: ${JSON.stringify({ tool_use_id: block.tool_use_id, content: block.content })}\n\n`,
              );
            }
          }
        } else if (json.type === "result") {
          res.write(
            `event: result\ndata: ${JSON.stringify({ cost: json.total_cost_usd, duration: json.duration_ms, result: json.result })}\n\n`,
          );
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  });

  let stderrBuffer = "";
  claudeProcess.stderr.on("data", (data) => {
    stderrBuffer += data.toString();
  });

  claudeProcess.on("close", (code) => {
    if (code !== 0 && !jsonBuffer.trim() && stderrBuffer.trim()) {
      const errorMsg = stderrBuffer.trim().split("\n")[0];
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`,
      );
    }
    if (jsonBuffer.trim()) {
      try {
        const json = JSON.parse(jsonBuffer);
        if (json.type === "result") {
          res.write(
            `event: result\ndata: ${JSON.stringify({ cost: json.total_cost_usd, duration: json.duration_ms, result: json.result })}\n\n`,
          );
        }
      } catch {}
    }
    res.write(`event: done\ndata: {}\n\n`);
    res.end();
  });

  req.on("close", () => {
    if (req.socket?.destroyed) {
      claudeProcess.kill();
    }
  });
});

// Serve frontend build
const frontendPath = path.join(__dirname, "../../ui/dist");
app.use("/assets", express.static(path.join(frontendPath, "assets")));

// Catch-all route to serve the React app
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  res.sendFile(path.join(frontendPath, "index.html"));
});

export function startWeb2Server(port: number, host = "localhost") {
  // Strip Claude env vars so spawned claude subprocesses don't think they're nested
  for (const key of Object.keys(process.env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) {
      delete process.env[key];
    }
  }

  serverPort = port;
  const server = app.listen(port, host, () => {
    const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
    console.log(`Panopticon web2 dashboard running on ${url}`);
    console.log(`API token: ${apiToken}`);
  });
  server.timeout = 0;
  server.keepAliveTimeout = 0;
}

// Auto-start when run directly
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("/web2/server.js") ||
    process.argv[1].endsWith("/web2/server.ts"));
if (isMainModule) {
  const port = parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";
  startWeb2Server(port, host);
}
