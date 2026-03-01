#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDataDir } from "../config.js";
import { autoPrune } from "../db/prune.js";
import { insertHookEvent } from "../db/store.js";
import { openLogFd } from "../log.js";

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
  const pid = parseInt(fs.readFileSync(config.pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Stale PID file
    try {
      fs.unlinkSync(config.pidFile);
    } catch {}
    return false;
  }
}

function isPortInUse(port: number): boolean {
  try {
    execSync(`ss -tlnp 'sport = :${port}' 2>/dev/null | grep -q LISTEN`, {
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

function startReceiver(): void {
  ensureDataDir();

  // Don't spawn if port is already held by an orphan process
  if (isPortInUse(config.otlpPort)) {
    return;
  }

  const serverScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "otlp",
    "server.js",
  );

  const logFd = openLogFd("otlp");

  const child = spawn("node", [serverScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PANOPTICON_OTLP_PORT: String(config.otlpPort),
    },
  });

  if (child.pid) {
    fs.writeFileSync(config.pidFile, String(child.pid));
  }
  child.unref();
  fs.closeSync(logFd);
}

function isSyncRunning(): boolean {
  if (!fs.existsSync(config.syncPidFile)) return false;
  const pid = parseInt(fs.readFileSync(config.syncPidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      fs.unlinkSync(config.syncPidFile);
    } catch {}
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
    "daemon.js",
  );

  const logFd = openLogFd("sync");

  const child = spawn("node", [daemonScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  child.unref();
  fs.closeSync(logFd);
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
    let eventType = data.hook_event_name ?? "Unknown";
    const toolName = data.tool_name ?? null;

    // Normalize Gemini CLI event types to Claude Code equivalents for FML and query compatibility
    if (eventType === "BeforeTool") {
      eventType = "PreToolUse";
    } else if (eventType === "AfterTool") {
      eventType = "PostToolUse";
    } else if (eventType === "BeforeModel") {
      eventType = "UserPromptSubmit";
      // Extract user_prompt for Gemini CLI
      const llmRequest = data.llm_request as any;
      if (llmRequest?.messages && Array.isArray(llmRequest.messages)) {
        const lastUserMessage = [...llmRequest.messages]
          .reverse()
          .find((m) => m.role === "user");
        if (lastUserMessage && typeof lastUserMessage.content === "string") {
          data.user_prompt = lastUserMessage.content;
        }
      }
    }

    // On SessionStart, ensure background processes are running
    if (eventType === "SessionStart") {
      if (!isReceiverRunning()) startReceiver();
      if (!isSyncRunning()) startSyncDaemon();
      tryAutoPrune();
    }

    // Capture the shell's PWD — may differ from data.cwd if Claude Code
    // changed its internal working directory after launch.
    const shellPwd = process.env.PWD ?? undefined;
    const payload = shellPwd ? { ...data, shell_pwd: shellPwd } : data;

    await insertHookEvent({
      session_id: sessionId,
      event_type: eventType,
      timestamp_ms: Date.now(),
      cwd: data.cwd,
      repository: data.repository,
      tool_name: toolName ?? undefined,
      payload,
    });

    if (eventType === "PostToolUse" && toolName === "run_shell_command") {
      const cmd = (data.tool_input as any)?.command;
      if (typeof cmd === "string" && cmd.includes("git commit")) {
        try {
          const sha = execSync("git log -1 --format=%H", {
            cwd: data.cwd || process.cwd(),
            encoding: "utf-8",
          }).trim();
          if (sha) {
            await insertHookEvent({
              session_id: sessionId,
              event_type: "GitCommit",
              timestamp_ms: Date.now(),
              cwd: data.cwd,
              repository: data.repository,
              payload: { commit_sha: sha, original_command: cmd },
            });
          }
        } catch (_e) {
          // Ignore git errors silently
        }
      }
    }

    // Output empty JSON to satisfy Gemini CLI hooks
    console.log("{}");
  } catch (err) {
    // Silently fail — hooks must not block Claude Code or Gemini CLI
    if (process.env.PANOPTICON_DEBUG) {
      console.error("panopticon hook error:", err);
    }
    // Output error JSON so Gemini CLI can log the warning
    console.log(JSON.stringify({ error: "panopticon hook failed" }));
  }
}

main();
