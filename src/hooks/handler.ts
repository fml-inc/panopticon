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

function isServerRunning(): boolean {
  if (!fs.existsSync(config.serverPidFile)) return false;
  const pid = parseInt(
    fs.readFileSync(config.serverPidFile, "utf-8").trim(),
    10,
  );
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      fs.unlinkSync(config.serverPidFile);
    } catch {}
    return false;
  }
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

/** Poll the server until it responds or timeout (default 3s). */
async function waitForServer(timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  const interval = 50;
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: config.port,
            path: "/health",
            method: "GET",
            timeout: 500,
          },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("timeout"));
        });
        req.end();
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  return false;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function postToServer(data: HookInput): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: config.port,
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

/**
 * Run the hook handler. When targetId is provided (by per-target bin files),
 * it is injected as data.source so the server can identify the sender without
 * falling back to heuristics.
 */
export async function runHandler(targetId?: string): Promise<void> {
  try {
    logHook("hook-handler invoked", {
      pid: process.pid,
      cwd: process.cwd(),
      pwd: process.env.PWD,
      target: targetId,
    });

    const input = await readStdin();
    if (!input.trim()) {
      logHook("empty stdin");
      process.exit(0);
    }

    logHook("stdin received", { bytes: Buffer.byteLength(input) });

    const data: HookInput = JSON.parse(input);

    // Inject explicit source when invoked via a per-target hook handler
    if (targetId && !data.source && !data.target) {
      data.source = targetId;
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

    // On SessionStart, ensure the unified server is running
    if (eventType === "SessionStart" || eventType === "session_start") {
      const serverRunning = isServerRunning();
      logHook("session start", { serverRunning });
      if (!serverRunning) {
        logHook("starting server");
        startServer();
        const ready = await waitForServer();
        logHook("server readiness", { ready });
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
      logHook("posting to server", { port: config.port });
      result = await postToServer(data);
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

initSentry();
// When imported directly (generic bin/hook-handler), run without a target ID.
// Per-target bin files call runHandler(targetId) explicitly instead.
runHandler();
