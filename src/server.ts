import fs from "node:fs";
import http from "node:http";
import { handleApiRequest } from "./api/routes.js";
import { getOrCreateAuthToken, requireBearerToken } from "./auth.js";
import { config } from "./config.js";
import { autoPrune } from "./db/prune.js";
import { syncAwarePrune } from "./db/sync-prune.js";
import { type HookInput, processHookEvent } from "./hooks/ingest.js";
import { log } from "./log.js";
import { handleOtlpRequest } from "./otlp/server.js";
import { handleProxyRequest, tunnelWebSocket } from "./proxy/server.js";
import { createScannerLoop } from "./scanner/index.js";
import type { ScannerHandle } from "./scanner/types.js";
import {
  addBreadcrumb,
  captureException,
  flushSentry,
  initSentry,
  setTag,
} from "./sentry.js";
import { createSyncLoop } from "./sync/loop.js";
import {
  CORE_SESSION_TABLES,
  DEFAULT_NON_SESSION_TABLES,
  OTEL_SESSION_TABLES,
} from "./sync/registry.js";
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

function isSessionStartEvent(data: HookInput): boolean {
  return (
    data.hook_event_name === "SessionStart" ||
    data.hook_event_name === "session_start"
  );
}

function enqueueSessionStartIngest(data: HookInput): void {
  setImmediate(() => {
    try {
      processHookEvent(data);
    } catch (err) {
      log.hooks.error("Queued SessionStart ingest error:", err);
      captureException(err, {
        component: "hooks",
        event_type: data.hook_event_name,
      });
    }
  });
}

function writeOwnPidFile(): void {
  try {
    fs.writeFileSync(config.serverPidFile, String(process.pid));
  } catch (err) {
    log.server.warn("Failed to write server PID file:", err);
  }
}

function removeOwnPidFile(): void {
  try {
    const pid = parseInt(fs.readFileSync(config.serverPidFile, "utf-8"), 10);
    if (pid === process.pid) {
      fs.unlinkSync(config.serverPidFile);
    }
  } catch {}
}

export function createUnifiedServer(): http.Server {
  // Generate/load the bearer token at server boot so every request handler
  // checks against the same value without re-reading the file each time.
  const authToken = getOrCreateAuthToken();

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "";

    // Health check — unauthenticated by design (used by liveness probes,
    // including waitForServer() which runs before any client has the token).
    if (url === "/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port: config.port }));
      return;
    }

    // Hook event ingest — auth required (DB write surface).
    if (url === "/hooks" && method === "POST") {
      if (!requireBearerToken(req, res, authToken)) return;
      try {
        const body = await collectBody(req);
        const data: HookInput = JSON.parse(body.toString("utf-8"));
        addBreadcrumb("hooks", `${data.hook_event_name ?? "unknown"} event`, {
          session_id: data.session_id,
          tool_name: data.tool_name,
          target: data.target ?? data.source,
        });
        if (isSessionStartEvent(data)) {
          enqueueSessionStartIngest(data);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({}));
          return;
        }
        const result = processHookEvent(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        log.hooks.error("Hook ingest error:", err);
        captureException(err, { component: "hooks" });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "hook ingest failed" }));
        }
      }
      return;
    }

    // OTLP ingest — /v1/logs, /v1/metrics, /v1/traces, or bare "/" (Gemini).
    // Auth required: any local process can otherwise inject fake telemetry
    // and poison cost/session aggregates. Agent CLIs send the token via
    // OTEL_EXPORTER_OTLP_HEADERS, written into the install-time panopticon
    // env file (`env.sh` on Unix, `env.ps1` on Windows) and sourced by
    // anything that needs the panopticon environment.
    if (
      method === "POST" &&
      (url.startsWith("/v1/") || url === "/" || url === "")
    ) {
      if (!requireBearerToken(req, res, authToken)) return;
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

    // API routes — /api/tool, /api/exec — auth required (read-everything surface).
    if (url.startsWith("/api/") && method === "POST") {
      if (!requireBearerToken(req, res, authToken)) return;
      await handleApiRequest(req, res);
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
      log.server.error("Prune error:", err);
      captureException(err, { component: "prune" });
    }
  }

  const sentryActive = await initSentry();
  if (sentryActive) log.server.debug("Sentry: enabled");

  const server = createUnifiedServer();
  let syncHandle: SyncHandle | null = null;
  let otelSyncHandle: SyncHandle | null = null;
  let scannerHandle: ScannerHandle | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  let takeoverAttempted = false;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      if (takeoverAttempted) {
        log.server.warn(`Already running on ${config.host}:${config.port}`);
        removeOwnPidFile();
        process.exit(0);
      }
      takeoverAttempted = true;
      log.server.warn(`Port ${config.port} in use, attempting takeover...`);
      try {
        // Only kill the old panopticon server via PID file, not all
        // processes on the port (which could include Claude Code CLI)
        const pidFile = config.serverPidFile;
        const pidStr = fs.readFileSync(pidFile, "utf-8").trim();
        const oldPid = parseInt(pidStr, 10);
        if (oldPid && oldPid !== process.pid) {
          try {
            process.kill(oldPid, "SIGTERM");
          } catch {}
        }
        setTimeout(() => server.listen(config.port, config.host), 1500);
      } catch {
        log.server.warn(`Already running on ${config.host}:${config.port}`);
        removeOwnPidFile();
        process.exit(0);
      }
      return;
    }
    captureException(err, { component: "server" });
    throw err;
  });
  server.listen(config.port, config.host, () => {
    writeOwnPidFile();
    log.server.info(`Listening on ${config.host}:${config.port}`);

    const cfg = loadUnifiedConfig();

    // Start session file scanner first — sync is deferred until scanner
    // finishes any initial resync so we don't sync stale/partial data.
    scannerHandle = createScannerLoop({
      onReady: () => {
        if (cfg.sync.targets.length > 0) {
          log.sync.debug(
            `Targets: ${cfg.sync.targets.map((t) => t.name).join(", ")}`,
          );
          setTag("sync_targets", cfg.sync.targets.length);
          syncHandle = createSyncLoop({
            targets: cfg.sync.targets,
            filter: cfg.sync.filter,
            sessionTables: [...CORE_SESSION_TABLES],
            nonSessionTables: [...DEFAULT_NON_SESSION_TABLES],
          });
          syncHandle.start();

          otelSyncHandle = createSyncLoop({
            targets: cfg.sync.targets,
            filter: cfg.sync.filter,
            loopName: "otel",
            syncSessions: false,
            sessionTables: [...OTEL_SESSION_TABLES],
            nonSessionTables: [],
            sessionPendingMode: "watermark-gap",
            batchSize: 1000,
            sessionRowBudget: 1000,
            maxSessionsPerTick: 2,
            idleIntervalMs: 60_000,
            catchUpIntervalMs: 2_000,
          });
          otelSyncHandle.start();
        }
      },
    });
    scannerHandle.start();

    // Run prune on startup, then hourly
    runPrune();
    pruneTimer = setInterval(runPrune, PRUNE_INTERVAL_MS);
    pruneTimer.unref();
  });

  const shutdown = async () => {
    if (pruneTimer) clearInterval(pruneTimer);
    scannerHandle?.stop();
    syncHandle?.stop();
    otelSyncHandle?.stop();
    await flushSentry();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}
