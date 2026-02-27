#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { insertHookEvent } from "../db/store.js";
import { config, ensureDataDir } from "../config.js";
import { autoPrune } from "../db/prune.js";

interface HookInput {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  repository?: string;
  tool_name?: string;
  [key: string]: unknown;
}

function isReceiverRunning(): boolean {
  if (!fs.existsSync(config.pidFile)) return false;
  const pid = parseInt(fs.readFileSync(config.pidFile, "utf-8").trim());
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Stale PID file
    try { fs.unlinkSync(config.pidFile); } catch {}
    return false;
  }
}

function startReceiver(): void {
  ensureDataDir();

  const serverScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "otlp",
    "server.js"
  );

  const child = spawn("node", [serverScript], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PANOPTICON_OTLP_PORT: String(config.otlpPort),
    },
  });

  if (child.pid) {
    fs.writeFileSync(config.pidFile, String(child.pid));
  }
  child.unref();
}

function isSyncRunning(): boolean {
  if (!fs.existsSync(config.syncPidFile)) return false;
  const pid = parseInt(fs.readFileSync(config.syncPidFile, "utf-8").trim());
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try { fs.unlinkSync(config.syncPidFile); } catch {}
    return false;
  }
}

function startSyncDaemon(): void {
  // Only start if sync is configured
  if (!fs.existsSync(config.syncConfigFile)) return;

  const daemonScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "sync",
    "daemon.js"
  );

  const child = spawn("node", [daemonScript], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  child.unref();
}

function tryAutoPrune(): void {
  try {
    autoPrune(config.autoMaxAgeDays, config.autoMaxSizeMb);
  } catch {
    // Never fail the hook due to pruning
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      process.exit(0);
    }

    const data: HookInput = JSON.parse(input);

    const sessionId = data.session_id ?? "unknown";
    const eventType = data.hook_event_name ?? "Unknown";
    const toolName = data.tool_name ?? null;

    // On SessionStart, ensure background processes are running
    if (eventType === "SessionStart") {
      if (!isReceiverRunning()) startReceiver();
      if (!isSyncRunning()) startSyncDaemon();
      tryAutoPrune();
    }

    insertHookEvent({
      session_id: sessionId,
      event_type: eventType,
      timestamp_ms: Date.now(),
      cwd: data.cwd,
      repository: data.repository,
      tool_name: toolName ?? undefined,
      payload: data,
    });
  } catch (err) {
    // Silently fail — hooks must not block Claude Code
    if (process.env.PANOPTICON_DEBUG) {
      console.error("panopticon hook error:", err);
    }
  }
}

main();
