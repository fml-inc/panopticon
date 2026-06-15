import http from "node:http";
import { handleApiRequest } from "./api/routes.js";
import { getOrCreateAuthToken, requireBearerToken } from "./auth.js";
import { config } from "./config.js";
import { autoPrune } from "./db/prune.js";
import { syncAwarePrune } from "./db/sync-prune.js";
import {
  createFrenemySupervisor,
  type FrenemySupervisorHandle,
} from "./frenemy/supervisor.js";
import { type HookInput, processHookEvent } from "./hooks/ingest.js";
import { log } from "./log.js";
import { handleOtlpRequest } from "./otlp/server.js";
import { createReaperLoop, type ReaperHandle } from "./presence/reaper.js";
import { handleProxyRequest, tunnelWebSocket } from "./proxy/server.js";
import { createScannerLoop } from "./scanner/index.js";
import { readDatabaseRebuildStatus } from "./scanner/status.js";
import type { ScannerHandle } from "./scanner/types.js";
import {
  addBreadcrumb,
  captureException,
  flushSentry,
  initSentry,
  setTag,
} from "./sentry.js";
import { removePidFileIfOwned, writeOwnPidFile } from "./server-control.js";
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

function writeDatabaseRebuildResponse(res: http.ServerResponse): void {
  const status = readDatabaseRebuildStatus();
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error:
        "Panopticon is rebuilding its database. Retry when the rebuild completes.",
      phase: status?.phase ?? null,
      message: status?.message ?? "Database rebuild in progress",
    }),
  );
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
      res.end(
        JSON.stringify({ status: "ok", port: config.port, pid: process.pid }),
      );
      return;
    }

    // Hook event ingest — auth required (DB write surface).
    if (url === "/hooks" && method === "POST") {
      if (!requireBearerToken(req, res, authToken)) return;
      if (readDatabaseRebuildStatus()) {
        writeDatabaseRebuildResponse(res);
        return;
      }
      try {
        const body = await collectBody(req);
        const data: HookInput = JSON.parse(body.toString("utf-8"));
        addBreadcrumb("hooks", `${data.hook_event_name ?? "unknown"} event`, {
          session_id: data.session_id,
          tool_name: data.tool_name,
          target: data.target ?? data.source,
        });
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
      if (readDatabaseRebuildStatus()) {
        writeDatabaseRebuildResponse(res);
        return;
      }
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
      if (url === "/api/exec" && readDatabaseRebuildStatus()) {
        writeDatabaseRebuildResponse(res);
        return;
      }
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
  const BACKGROUND_START_DELAY_MS = 500;
  const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  function runPrune(): void {
    try {
      const cfg = loadUnifiedConfig();
      addBreadcrumb("prune", "Running scheduled prune");
      autoPrune(cfg.retention.maxAgeDays, cfg.retention.maxSizeMb);
      if (
        cfg.sync.enabled !== false &&
        cfg.sync.targets.length > 0 &&
        cfg.retention.syncedMaxAgeDays
      ) {
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
  let reaperHandle: ReaperHandle | null = null;
  let frenemySupervisor: FrenemySupervisorHandle | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let backgroundStartTimer: ReturnType<typeof setTimeout> | null = null;
  let postScannerBackgroundStarted = false;

  function startPostScannerBackgroundWork(): void {
    if (postScannerBackgroundStarted) return;
    postScannerBackgroundStarted = true;

    const cfg = loadUnifiedConfig();

    if (cfg.sync.enabled !== false && cfg.sync.targets.length > 0) {
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

    // Run prune after the startup scan/rebuild, then hourly. This keeps the
    // main thread from opening a DB handle while a worker reparse is swapping
    // the database file.
    runPrune();
    pruneTimer = setInterval(runPrune, PRUNE_INTERVAL_MS);
    pruneTimer.unref();
  }

  function startBackgroundWork(): void {
    backgroundStartTimer = null;

    // Instance presence reaper is always-on (independent of scanner/sync): it
    // actively probes agent pids so killed/crashed sessions are detected even
    // when they never fire a clean SessionEnd.
    reaperHandle = createReaperLoop();
    reaperHandle.start();

    if (config.enableFrenemy) {
      if (!config.enableBusDelivery) {
        log.server.warn(
          "Frenemy supervisor enabled while bus delivery is disabled; findings will be posted to the bus but agents will not receive hook nudges.",
        );
      }
      frenemySupervisor = createFrenemySupervisor();
      frenemySupervisor.start();
    }

    // Start session file scanner first — sync is deferred until scanner
    // finishes any initial resync so we don't sync stale/partial data.
    scannerHandle = createScannerLoop({
      runInWorker: true,
      onReady: () => {
        startPostScannerBackgroundWork();
      },
    });
    scannerHandle.start();
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.server.error(
        `Port ${config.port} is already in use on ${config.host}`,
      );
      process.exit(1);
      return;
    }
    captureException(err, { component: "server" });
    throw err;
  });
  server.listen(config.port, config.host, () => {
    writeOwnPidFile();
    log.server.info(`Listening on ${config.host}:${config.port}`);
    backgroundStartTimer = setTimeout(
      startBackgroundWork,
      BACKGROUND_START_DELAY_MS,
    );
    backgroundStartTimer.unref();
  });

  const shutdown = async () => {
    if (backgroundStartTimer) clearTimeout(backgroundStartTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    reaperHandle?.stop();
    frenemySupervisor?.stop();
    scannerHandle?.stop();
    syncHandle?.stop();
    otelSyncHandle?.stop();
    await flushSentry();
    server.close();
    removePidFileIfOwned(process.pid);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}
