#!/usr/bin/env node

/**
 * Hook handler — thin stdin→HTTP→stdout bridge.
 *
 * Reads JSON from stdin (same format Claude Code / Gemini CLI / Codex CLI send),
 * POSTs it to the unified panopticon server at /hooks, and relays the response
 * to stdout. Drops events if the server is unreachable.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isServerRunning, waitForServer } from "../api/util.js";
import { config, ensureDataDir } from "../config.js";
import { refreshIfStale } from "../db/pricing.js";
import { logPaths, openLogFd } from "../log.js";
import { addBreadcrumb, captureException, initSentry } from "../sentry.js";
import type { HookInput } from "./ingest.js";

declare const __PANOPTICON_VERSION__: string;
function getAgentVersion(): string | undefined {
  return typeof __PANOPTICON_VERSION__ !== "undefined"
    ? __PANOPTICON_VERSION__
    : undefined;
}

// NOTE: ensureDataDir() here can recreate the data dir. This is safe because
// logHook is only called inside runHandler(), which has an early-exit guard
// when the data dir is missing (preventing resurrection after --purge).
function logHook(message: string, meta?: Record<string, unknown>): void {
  try {
    ensureDataDir();
    const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
    fs.appendFileSync(
      logPaths.hook,
      `${new Date().toISOString()} ${message}${suffix}\n`,
    );
  } catch {}
}

/**
 * Atomically claim the right to start the server using O_EXCL on a lock file.
 * Returns true if this process won the race, false if another process already claimed it.
 */
function acquireStartLock(): boolean {
  ensureDataDir();
  const lockFile = `${config.serverPidFile}.lock`;
  try {
    const fd = fs.openSync(
      lockFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseStartLock(): void {
  try {
    fs.unlinkSync(`${config.serverPidFile}.lock`);
  } catch {}
}

function startServer(): void {
  ensureDataDir();

  const serverScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "server.js",
  );

  const logFd = openLogFd("server");

  const child = spawn("node", [serverScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PANOPTICON_PORT: String(config.port),
    },
  });

  if (child.pid) {
    fs.writeFileSync(config.serverPidFile, String(child.pid));
  }
  child.unref();
  fs.closeSync(logFd);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function postToServer(
  data: HookInput,
  port: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/hooks",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch {
            resolve({});
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

/** Parse CLI args: `node hook-handler [target] [port] [--proxy]` */
function parseArgs(argv: string[]): {
  targetId?: string;
  port: number;
  proxy: boolean;
} {
  const args = argv.slice(2);
  let targetId: string | undefined;
  let port = config.port;
  let proxy = false;

  for (const arg of args) {
    if (arg === "--proxy") {
      proxy = true;
    } else if (/^\d+$/.test(arg)) {
      port = parseInt(arg, 10);
    } else if (arg && !arg.startsWith("-")) {
      targetId = arg;
    }
  }

  return { targetId, port, proxy };
}

/**
 * Run the hook handler.
 *
 * CLI args set at install time provide:
 *   - targetId: which CLI invoked us (e.g. "gemini", "codex")
 *   - port: the panopticon server port to POST to
 *   - proxy: whether the API proxy is active for this target
 */
export async function runHandler(opts: {
  targetId?: string;
  port: number;
  proxy: boolean;
}): Promise<void> {
  // After uninstall --purge the data dir is gone. Exit silently to avoid
  // resurrecting it — hooks must never block the calling CLI.
  if (!fs.existsSync(config.dataDir)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const { targetId, port, proxy } = opts;

  try {
    logHook("hook-handler invoked", {
      pid: process.pid,
      cwd: process.cwd(),
      pwd: process.env.PWD,
      target: targetId,
      port,
      proxy,
    });

    const input = await readStdin();
    if (!input.trim()) {
      logHook("empty stdin");
      process.exit(0);
    }

    logHook("stdin received", { bytes: Buffer.byteLength(input) });

    const data: HookInput = JSON.parse(input);

    // Inject context from CLI args set at install time
    if (targetId && !data.source && !data.target) {
      data.source = targetId;
    }
    if (proxy) {
      data.proxy_enabled = true;
    }

    const eventType = data.hook_event_name ?? "Unknown";
    logHook("event parsed", {
      eventType,
      sessionId: data.session_id,
      toolName: data.tool_name,
      source: data.source,
    });

    addBreadcrumb("hook-handler", `Processing ${eventType}`, {
      session_id: data.session_id,
      tool_name: data.tool_name,
      source: data.source,
    });

    // On SessionStart, ensure the unified server is running. This is the
    // only event that triggers server startup — all other events POST to
    // the already-running server and silently drop if it's unreachable.
    // The server process outlives any single session and serves all
    // concurrent ones. Uses an atomic lock file (O_EXCL) to prevent two
    // concurrent hook invocations from both spawning a server (TOCTOU race).
    if (eventType === "SessionStart" || eventType === "session_start") {
      const serverRunning = isServerRunning();
      logHook("session start", { serverRunning });
      if (!serverRunning) {
        if (acquireStartLock()) {
          try {
            logHook("starting server (lock acquired)");
            startServer();
            const ready = await waitForServer(port);
            logHook("server readiness", { ready });
          } finally {
            releaseStartLock();
          }
        } else {
          // Another hook handler is starting the server — wait for it
          logHook("waiting for server (another handler starting)");
          const ready = await waitForServer(port);
          logHook("server readiness (waited)", { ready });
        }
      }
      refreshIfStale().catch(() => {});
    }

    // Tag with agent version for observability
    const agentVersion = getAgentVersion();
    if (agentVersion) data.agent_version = agentVersion;

    // Capture shell PWD (prefer what Claude Code sends over handler's own PWD)
    if (!data.shell_pwd) {
      const shellPwd = process.env.PWD ?? undefined;
      if (shellPwd) data.shell_pwd = shellPwd;
    }

    // Post to the panopticon server. If unreachable, drop the event —
    // direct DB writes add latency, risk lock contention, and mask a
    // misconfigured server. The server auto-starts on SessionStart above.
    let result: Record<string, unknown>;
    try {
      logHook("posting to server", { port });
      result = await postToServer(data, port);
      logHook("server post succeeded", { resultKeys: Object.keys(result) });
    } catch {
      logHook("server post failed, dropping event");
      result = {};
    }

    process.stdout.write(JSON.stringify(result));
    logHook("response written", {
      bytes: Buffer.byteLength(JSON.stringify(result)),
    });
  } catch (err) {
    // Silently fail — hooks must not block the calling CLI
    const errorMessage = err instanceof Error ? err.message : String(err);
    logHook("hook-handler failed", { error: errorMessage });
    captureException(err, { component: "hook-handler", event_type: "unknown" });
    if (process.env.PANOPTICON_DEBUG) {
      console.error("panopticon hook error:", err);
    }
    process.stdout.write(JSON.stringify({ error: "panopticon hook failed" }));
  }
}

await initSentry();
// CLI args are set at install time: `node hook-handler <target> <port> [--proxy]`
// When invoked without args (e.g. by Claude Code's plugin system), falls back
// to config defaults and server-side target detection.
runHandler(parseArgs(process.argv));
