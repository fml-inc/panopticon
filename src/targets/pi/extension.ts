/**
 * Panopticon extension for Pi coding agent.
 *
 * Captures Pi session events (prompts, tool calls, results) and sends them
 * to the local Panopticon server using the same HookInput format that
 * Claude Code and Gemini CLI use. All events are fire-and-forget —
 * failures are silently swallowed so the agent is never blocked.
 *
 * Install:
 *   panopticon install --target pi
 *   # or: pi install npm:@panopticon/pi-extension
 *
 * Requires Panopticon server running on localhost:4318 (default).
 * Set PANOPTICON_HOST and PANOPTICON_PORT to override the connection target.
 * Start with: panopticon start
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HOST = process.env.PANOPTICON_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.PANOPTICON_PORT ?? "4318", 10);

// Read the panopticon bearer token (mirrors src/auth.ts readAuthToken).
// /hooks requires it; without it events are 401'd and silently dropped.
function readAuthToken(): string | null {
  if (process.env.PANOPTICON_AUTH_TOKEN)
    return process.env.PANOPTICON_AUTH_TOKEN;
  const dataDir =
    process.env.PANOPTICON_DATA_DIR ??
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "panopticon")
      : process.platform === "win32"
        ? path.join(
            process.env.APPDATA ??
              path.join(os.homedir(), "AppData", "Roaming"),
            "panopticon",
          )
        : path.join(os.homedir(), ".local", "share", "panopticon"));
  try {
    return (
      fs.readFileSync(path.join(dataDir, "auth-token"), "utf-8").trim() || null
    );
  } catch {
    return null;
  }
}

const AUTH_TOKEN = readAuthToken();

interface HookEvent {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  repository?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  source: string;
  [key: string]: unknown;
}

function post(event: HookEvent): void {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
  };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  const req = http.request(
    {
      hostname: HOST,
      port: PORT,
      path: "/hooks",
      method: "POST",
      headers,
      timeout: 5000,
    },
    (res) => res.resume(),
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.write(body);
  req.end();
}

function detectRepo(dir: string): string | undefined {
  try {
    return (
      execSync("git remote get-url origin", {
        cwd: dir,
        timeout: 3000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export default function panopticon(pi: ExtensionAPI) {
  const sessionId = randomUUID();
  let cwd: string | undefined;
  let repo: string | undefined;

  function emit(
    event: Omit<HookEvent, "session_id" | "source" | "cwd" | "repository">,
  ) {
    post({
      session_id: sessionId,
      source: "pi",
      cwd,
      repository: repo,
      ...event,
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    repo = detectRepo(cwd);
    emit({ hook_event_name: "SessionStart" });
  });

  // Pi's input event has event.text (not event.input)
  pi.on("input", async (event) => {
    emit({ hook_event_name: "UserPromptSubmit", prompt: event.text });
  });

  // PreToolUse — capture the tool call
  pi.on("tool_call", async (event) => {
    emit({
      hook_event_name: "PreToolUse",
      tool_name: event.toolName,
      tool_input: event.input as Record<string, unknown>,
    });
  });

  // PostToolUse — capture the result
  pi.on("tool_result", async (event) => {
    emit({
      hook_event_name: event.isError ? "PostToolUseFailure" : "PostToolUse",
      tool_name: event.toolName,
      // Send result content as tool_input for PostToolUse
      tool_input: {
        content: event.content,
        details: event.details,
        isError: event.isError,
      },
    });
  });

  pi.on("session_shutdown", async () => {
    emit({ hook_event_name: "SessionEnd" });
  });
}
