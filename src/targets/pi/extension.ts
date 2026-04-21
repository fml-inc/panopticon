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
 *
 * Requires Panopticon server running on localhost:4318 (default).
 * Set PANOPTICON_HOST and PANOPTICON_PORT to override the connection target.
 * Start with: panopticon start
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HOST = process.env.PANOPTICON_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.PANOPTICON_PORT ?? "4318", 10);

interface HookEvent {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  repository?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: Record<string, unknown>;
  prompt?: string;
  source: string;
  [key: string]: unknown;
}

function post(event: HookEvent): void {
  const body = JSON.stringify(event);
  const req = http.request(
    {
      hostname: HOST,
      port: PORT,
      path: "/hooks",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
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

  // PostToolUse — preserve the original tool_input (so file_path/command
  // columns populate) and carry the result separately in tool_result
  // (which insertHookEvent reads for the tool_result column).
  pi.on("tool_result", async (event) => {
    emit({
      hook_event_name: event.isError ? "PostToolUseFailure" : "PostToolUse",
      tool_name: event.toolName,
      tool_input: event.input,
      tool_result: { content: event.content, details: event.details },
    });
  });

  pi.on("session_shutdown", async () => {
    emit({ hook_event_name: "SessionEnd" });
  });
}
