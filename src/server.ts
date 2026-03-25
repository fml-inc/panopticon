import http from "node:http";
import { config } from "./config.js";
import { autoPrune } from "./db/prune.js";
import { syncAwarePrune } from "./db/sync-prune.js";
import { type HookInput, processHookEvent } from "./hooks/ingest.js";
import { handleOtlpRequest } from "./otlp/server.js";
import { handleProxyRequest, tunnelWebSocket } from "./proxy/server.js";
import {
  addBreadcrumb,
  captureException,
  flushSentry,
  initSentry,
  setTag,
} from "./sentry.js";
import { createSyncLoop } from "./sync/loop.js";
import type { SyncHandle } from "./sync/types.js";
import { loadUnifiedConfig } from "./unified-config.js";

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createUnifiedServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "";

    // Health check
    if (url === "/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port: config.port }));
      return;
    }

    // Hook event ingest
    if (url === "/hooks" && method === "POST") {
      try {
        const body = await collectBody(req);
        const data: HookInput = JSON.parse(body.toString("utf-8"));
        addBreadcrumb("hooks", `${data.hook_event_name ?? "unknown"} event`, {
          session_id: data.session_id,
          tool_name: data.tool_name,
          vendor: data.vendor ?? data.source,
        });
        const result = processHookEvent(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("Hook ingest error:", err);
        captureException(err, { component: "hooks" });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "hook ingest failed" }));
        }
      }
      return;
    }

    // OTLP ingest — /v1/logs, /v1/metrics, /v1/traces, or bare "/" (Gemini)
    if (
      method === "POST" &&
      (url.startsWith("/v1/") || url === "/" || url === "")
    ) {
      await handleOtlpRequest(req, res);
      return;
    }

    // Proxy routes — /proxy/anthropic/*, /proxy/openai/*, /proxy/codex/*, /proxy/google/*
    if (url.startsWith("/proxy/")) {
      if (method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      addBreadcrumb("proxy", `Proxy ${url}`);
      // Strip /proxy prefix so the proxy handler sees /anthropic/*, /openai/*, etc.
      req.url = url.slice(6);
      await handleProxyRequest(req, res);
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  // WebSocket upgrades for proxy routes
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (url.startsWith("/proxy/")) {
      req.url = url.slice(6);
      tunnelWebSocket(req, socket, head);
    } else {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    }
  });

  return server;
}

// When run directly, start the unified server
const entryScript = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (entryScript.endsWith("/server.js") || entryScript.endsWith("/server.ts")) {
  const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  function runPrune(): void {
    try {
      const cfg = loadUnifiedConfig();
      addBreadcrumb("prune", "Running scheduled prune");
      autoPrune(cfg.retention.maxAgeDays, cfg.retention.maxSizeMb);
      if (cfg.sync.targets.length > 0 && cfg.retention.syncedMaxAgeDays) {
        syncAwarePrune(cfg.sync.targets, cfg.retention);
      }
    } catch (err) {
      console.error("Prune error:", err);
      captureException(err, { component: "prune" });
    }
  }

  const sentryActive = initSentry();
  if (sentryActive) console.log("Sentry: enabled");

  const server = createUnifiedServer();
  let syncHandle: SyncHandle | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(
        `Panopticon already running on ${config.host}:${config.port}`,
      );
      process.exit(0);
    }
    captureException(err, { component: "server" });
    throw err;
  });
  server.listen(config.port, config.host, () => {
    console.log(`Panopticon server listening on ${config.host}:${config.port}`);

    const cfg = loadUnifiedConfig();

    // Start sync if targets are configured
    if (cfg.sync.targets.length > 0) {
      console.log(`Sync: ${cfg.sync.targets.map((t) => t.name).join(", ")}`);
      setTag("sync_targets", cfg.sync.targets.length);
      syncHandle = createSyncLoop({
        targets: cfg.sync.targets,
        filter: cfg.sync.filter,
        hooksInstalled: cfg.hooksInstalled,
      });
      syncHandle.start();
    }

    // Run prune on startup, then hourly
    runPrune();
    pruneTimer = setInterval(runPrune, PRUNE_INTERVAL_MS);
    pruneTimer.unref();
  });

  const shutdown = async () => {
    if (pruneTimer) clearInterval(pruneTimer);
    syncHandle?.stop();
    await flushSentry();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}
