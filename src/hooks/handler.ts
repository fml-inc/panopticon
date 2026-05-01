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
import { readAuthToken } from "../auth.js";
import { config, ensureDataDir } from "../config.js";
import { refreshIfStale } from "../db/pricing.js";
import {
  logPaths,
  openLogFd,
  type PanopticonLogLevelName,
  shouldWriteLog,
} from "../log.js";
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
function logHook(
  level: PanopticonLogLevelName,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (!shouldWriteLog(level)) {
    return;
  }
  try {
    ensureDataDir();
    const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
    fs.appendFileSync(
      logPaths.hook,
      `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`,
    );
  } catch {}
}

/**
 * Atomically claim the right to start the server using O_EXCL on a lock file.
 * Returns true if this process won the race, false if another process already
 * claimed it.
 *
 * If the existing lock file's writer is dead (SIGKILL, OOM, reboot mid-hook),
 * the lock is reclaimed and we retry once. Without this, a single hard crash
 * would wedge ingest until the user manually removed the lock file — every
 * subsequent hook would see the lock, skip startServer(), then waitForServer()
 * would time out and silently drop events.
 */
export function acquireStartLock(lockFile?: string): boolean {
  ensureDataDir();
  // Resolve the lock path lazily so PANOPTICON_DATA_DIR overrides apply
  // even when this module was imported before the env var was set
  // (matches auth.ts tokenPath() behavior).
  const fp =
    lockFile ??
    `${path.join(
      process.env.PANOPTICON_DATA_DIR ?? config.dataDir,
      "panopticon.pid",
    )}.lock`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(
        fp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // Only attempt reclaim once. If we lost the race after a successful
      // reclaim, the new holder is genuinely live — yield rather than fight.
      if (attempt > 0) return false;
      if (!reclaimStaleLock(fp)) return false;
    }
  }
  return false;
}

/**
 * If the lock file's PID points to a dead process, unlink the lock and
 * return true (the caller should retry). Returns false if the holder is
 * alive, the lock holds our own PID, the file is unreadable/corrupt, or
 * we couldn't unlink. The conservative bias (don't reclaim on uncertainty)
 * favors the rare false negative — manual recovery — over the dangerous
 * false positive of kicking out a live writer.
 */
export function reclaimStaleLock(lockFile: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(lockFile, "utf-8").trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0); // throws if no such process
    return false; // holder is alive — don't reclaim
  } catch {
    try {
      fs.unlinkSync(lockFile);
      logHook("warn", "reclaimed stale start lock", { stalePid: pid });
      return true;
    } catch {
      return false;
    }
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

  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    windowsHide: true,
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

function writeJsonResponse(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(value), () => resolve());
  });
}

function postToServer(
  data: HookInput,
  port: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const token = readAuthToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/hooks",
        method: "POST",
        headers,
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseText = Buffer.concat(chunks).toString("utf-8");
          if (
            res.statusCode &&
            (res.statusCode < 200 || res.statusCode >= 300)
          ) {
            reject(
              new Error(
                `server returned ${res.statusCode}: ${responseText.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(responseText);
            resolve(
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {},
            );
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

/**
 * Codex validates hook stdout against the event-specific hook-output schema.
 * Panopticon server/client failures are operational errors, not hook decisions,
 * so never surface a bare `{ "error": ... }` object to the calling CLI.
 */
export function normalizeHookOutput(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(result, "error")) {
    return result;
  }

  const sanitized = { ...result };
  delete sanitized.error;
  return sanitized;
}

function isPanopticonMcpToolName(toolName: string): boolean {
  return (
    toolName.startsWith("mcp__plugin_panopticon_panopticon__") ||
    toolName.startsWith("mcp__panopticon__") ||
    toolName.startsWith("panopticon/")
  );
}

export function localHookFallback(
  data: HookInput,
): Record<string, unknown> | null {
  const eventType = data.hook_event_name;
  const source = data.source ?? data.target;
  const toolName = data.tool_name;

  if (
    source === "codex" &&
    eventType === "PermissionRequest" &&
    typeof toolName === "string" &&
    isPanopticonMcpToolName(toolName)
  ) {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    };
  }

  return null;
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
    await writeJsonResponse({});
    return;
  }

  const { targetId, port, proxy } = opts;

  try {
    logHook("debug", "hook-handler invoked", {
      pid: process.pid,
      cwd: process.cwd(),
      pwd: process.env.PWD,
      target: targetId,
      port,
      proxy,
    });

    const input = await readStdin();
    if (!input.trim()) {
      logHook("debug", "empty stdin");
      await writeJsonResponse({});
      return;
    }

    logHook("debug", "stdin received", { bytes: Buffer.byteLength(input) });

    const data: HookInput = JSON.parse(input);

    // Inject context from CLI args set at install time
    if (targetId && !data.source && !data.target) {
      data.source = targetId;
    }
    if (proxy) {
      data.proxy_enabled = true;
    }

    const eventType = data.hook_event_name ?? "Unknown";
    logHook("debug", "event parsed", {
      eventType,
      sessionId: data.session_id,
      toolName: data.tool_name,
      source: data.source,
    });

    const localFallback = localHookFallback(data);
    if (localFallback) {
      logHook("debug", "using local hook fallback", {
        eventType,
        toolName: data.tool_name,
        source: data.source,
      });
      await writeJsonResponse(localFallback);
      return;
    }

    addBreadcrumb("hook-handler", `Processing ${eventType}`, {
      session_id: data.session_id,
      tool_name: data.tool_name,
      source: data.source,
    });

    // On SessionStart, ensure the unified server is running. This is the
    // only event that triggers server startup; all other events POST to the
    // already-running server and silently drop if it's unreachable.
    // The server process outlives any single session and serves all
    // concurrent ones. Uses an atomic lock file (O_EXCL) to prevent two
    // concurrent hook invocations from both spawning a server (TOCTOU race).
    if (eventType === "SessionStart" || eventType === "session_start") {
      if (process.env.PANOPTICON_SKIP_SESSION_START_BOOTSTRAP === "1") {
        logHook("debug", "session start bootstrap skipped for flash isolation");
      } else {
        const serverRunning = isServerRunning();
        logHook("debug", "session start", { serverRunning });
        if (!serverRunning) {
          if (acquireStartLock()) {
            try {
              logHook("info", "starting server (lock acquired)");
              startServer();
              const ready = await waitForServer(port);
              logHook("info", "server readiness", { ready });
            } finally {
              releaseStartLock();
            }
          } else {
            // Another hook handler is starting the server; wait for it.
            logHook("debug", "waiting for server (another handler starting)");
            const ready = await waitForServer(port);
            logHook("debug", "server readiness (waited)", { ready });
          }
        }
        refreshIfStale().catch(() => {});
      }
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
      logHook("debug", "posting to server", { port });
      result = normalizeHookOutput(await postToServer(data, port));
      logHook("debug", "server post succeeded", {
        resultKeys: Object.keys(result),
      });
    } catch (err) {
      logHook("warn", "server post failed, dropping event", {
        error: err instanceof Error ? err.message : String(err),
      });
      result = localHookFallback(data) ?? {};
    }

    await writeJsonResponse(result);
    logHook("debug", "response written", {
      bytes: Buffer.byteLength(JSON.stringify(result)),
    });
  } catch (err) {
    // Silently fail — hooks must not block the calling CLI
    const errorMessage = err instanceof Error ? err.message : String(err);
    logHook("error", "hook-handler failed", { error: errorMessage });
    captureException(err, { component: "hook-handler", event_type: "unknown" });
    if (process.env.PANOPTICON_DEBUG) {
      console.error("panopticon hook error:", err);
    }
    await writeJsonResponse({});
  }
}

// Guard the CLI dispatch so this file is safely importable in tests.
// Same convention as src/server.ts.
const entryScript = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  entryScript.endsWith("/handler.js") ||
  entryScript.endsWith("/handler.ts") ||
  entryScript.endsWith("/hook-handler") ||
  entryScript.endsWith("/hook-handler.js")
) {
  await initSentry();
  // CLI args are set at install time: `node hook-handler <target> <port> [--proxy]`
  // When invoked without args (e.g. by Claude Code's plugin system), falls back
  // to config defaults and server-side target detection.
  await runHandler(parseArgs(process.argv));
  process.exit(0);
}
