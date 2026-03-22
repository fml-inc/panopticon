#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, ensureDataDir } from "../config.js";
import { autoPrune } from "../db/prune.js";
import {
  insertHookEvent,
  upsertSessionCwd,
  upsertSessionRepository,
} from "../db/store.js";
import { openLogFd } from "../log.js";
import { resolveRepoFromCwd } from "../repo.js";

interface HookInput {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  repository?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

// --- Chain-aware Bash permission enforcement ---

import { checkBashPermission } from "./permissions.js";

const ALLOWED_PATH = path.join(config.dataDir, "permissions", "allowed.json");

interface AllowedList {
  bash_commands: string[];
  tools: string[];
}

function loadAllowed(): AllowedList | null {
  try {
    return JSON.parse(fs.readFileSync(ALLOWED_PATH, "utf-8"));
  } catch {
    return null;
  }
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

function startReceiver(): void {
  ensureDataDir();

  const serverScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
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
    const timestampMs = Date.now();

    // On SessionStart, ensure background processes are running
    if (eventType === "SessionStart") {
      if (!isReceiverRunning()) startReceiver();
      tryAutoPrune();
    }

    // Resolve repository at capture time
    let repo = data.repository ?? null;
    if (!repo) {
      // Try file_path / path from tool_input
      const toolInput = data.tool_input;
      if (toolInput && typeof toolInput === "object") {
        const filePath =
          (toolInput as Record<string, unknown>).file_path ??
          (toolInput as Record<string, unknown>).path;
        if (typeof filePath === "string" && path.isAbsolute(filePath)) {
          repo = resolveRepoFromCwd(path.dirname(filePath));
        }
      }
    }
    if (!repo && data.cwd) {
      repo = resolveRepoFromCwd(data.cwd as string);
    }

    // Capture the shell's PWD — may differ from data.cwd if Claude Code
    // changed its internal working directory after launch.
    const shellPwd = process.env.PWD ?? undefined;
    const payload = shellPwd ? { ...data, shell_pwd: shellPwd } : data;

    insertHookEvent({
      session_id: sessionId,
      event_type: eventType,
      timestamp_ms: timestampMs,
      cwd: data.cwd,
      repository: repo ?? undefined,
      tool_name: toolName ?? undefined,
      payload,
    });

    // Populate session junction tables
    if (repo) {
      upsertSessionRepository(sessionId, repo, timestampMs);
    }
    if (data.cwd) {
      upsertSessionCwd(sessionId, data.cwd as string, timestampMs);
    }

    // Permission enforcement via allowed.json
    if (eventType === "PreToolUse" && toolName) {
      let decision: { allow: true; reason: string } | null = null;

      // Always auto-allow panopticon's own MCP tools
      if (toolName.startsWith("mcp__plugin_panopticon_panopticon__")) {
        decision = { allow: true, reason: "Panopticon tool (always allowed)" };
      } else {
        const allowed = loadAllowed();
        if (allowed) {
          if (toolName === "Bash") {
            // Chain-aware enforcement for Bash commands
            const command = data.tool_input?.command;
            if (typeof command === "string" && allowed.bash_commands?.length) {
              decision = checkBashPermission(command, allowed.bash_commands);
            }
          } else if (allowed.tools?.includes(toolName)) {
            // Exact match for non-Bash tools
            decision = { allow: true, reason: `Tool "${toolName}" is allowed` };
          }
        }
      }

      if (decision) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: decision.reason,
            },
          }),
        );
      }
    }
  } catch (err) {
    // Silently fail — hooks must not block Claude Code
    if (process.env.PANOPTICON_DEBUG) {
      console.error("panopticon hook error:", err);
    }
  }
}

main();
