#!/usr/bin/env node

/**
 * Hook handler — thin stdin→HTTP→stdout bridge.
 *
 * Reads JSON from stdin (same format Claude Code / Gemini CLI / Codex CLI send),
 * POSTs it to the unified panopticon server at /hooks, and relays the response
 * to stdout. Falls back to direct DB write if the server is unreachable.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, ensureDataDir } from "../config.js";
import { refreshIfStale } from "../db/pricing.js";
import { openLogFd } from "../log.js";
import { type HookInput, processHookEvent } from "./ingest.js";

declare const __PANOPTICON_VERSION__: string;
function getAgentVersion(): string | undefined {
  return typeof __PANOPTICON_VERSION__ !== "undefined"
    ? __PANOPTICON_VERSION__
    : undefined;
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

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      process.exit(0);
    }

    const data: HookInput = JSON.parse(input);
    const eventType = data.hook_event_name ?? "Unknown";

    // On SessionStart, ensure the unified server is running
    if (eventType === "SessionStart" || eventType === "session_start") {
      if (!isServerRunning()) startServer();
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

    // Try posting to the server; fall back to direct DB write
    let result: Record<string, unknown>;
    try {
      result = await postToServer(data);
    } catch {
      // Server unreachable — fall back to direct processing
      result = processHookEvent(data);
    }

    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    // Silently fail — hooks must not block the calling CLI
    if (process.env.PANOPTICON_DEBUG) {
      console.error("panopticon hook error:", err);
    }
    process.stdout.write(JSON.stringify({ error: "panopticon hook failed" }));
  }
}

main();
