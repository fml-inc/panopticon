import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import {
  insertHookEvent,
  upsertSessionCwd,
  upsertSessionRepository,
} from "../db/store.js";
import { resolveRepoFromCwd } from "../repo.js";
import { checkBashPermission } from "./permissions.js";

// Last resolved repo per session — used as fallback for events without paths
// (e.g. Stop, UserPromptSubmit). Long-lived in the server process.
const lastSessionRepo = new Map<string, string>();

export interface HookInput {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  repository?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  source?: string;
  vendor?: string;
  prompt?: string;
  [key: string]: unknown;
}

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

/**
 * Extract the shell_pwd from hook event data.
 * Claude Code may send it at the top level or nested in tool_input.
 */
export function extractShellPwd(data: HookInput): string | null {
  if (typeof data.shell_pwd === "string") return data.shell_pwd;
  if (typeof data.tool_input?.shell_pwd === "string")
    return data.tool_input.shell_pwd;
  return null;
}

/**
 * Resolve the repository for an event, trying multiple sources in priority order:
 * 1. Explicit repository field
 * 2. shell_pwd (actual cwd at event time)
 * 3. tool_input.file_path / path
 * 4. Session cwd
 * 5. Last resolved repo for this session (cumulative cache)
 */
export function resolveEventRepo(
  data: HookInput,
  resolveFn: (dir: string) => string | null = resolveRepoFromCwd,
): string | null {
  const sessionId = data.session_id ?? "unknown";

  let repo = data.repository ?? null;

  if (!repo) {
    const shellPwd = extractShellPwd(data);
    if (shellPwd) {
      repo = resolveFn(shellPwd);
    }
  }

  if (!repo) {
    const toolInput = data.tool_input;
    if (toolInput && typeof toolInput === "object") {
      const filePath =
        (toolInput as Record<string, unknown>).file_path ??
        (toolInput as Record<string, unknown>).path;
      if (typeof filePath === "string" && path.isAbsolute(filePath)) {
        repo = resolveFn(path.dirname(filePath));
      }
    }
  }

  if (!repo && data.cwd) {
    repo = resolveFn(data.cwd as string);
  }

  // Fallback: use the last resolved repo for this session
  if (!repo) {
    repo = lastSessionRepo.get(sessionId) ?? null;
  }

  // Cache for future events in this session
  if (repo) {
    lastSessionRepo.set(sessionId, repo);
  }

  return repo;
}

/** Clear the session repo cache (for testing). */
export function _resetSessionRepoCache(): void {
  lastSessionRepo.clear();
}

/**
 * Process a hook event: normalize, store, and optionally enforce permissions.
 * Returns a JSON-serializable response body (permission decision or {}).
 */
export function processHookEvent(data: HookInput): Record<string, unknown> {
  const sessionId = data.session_id ?? "unknown";
  const rawEventType = data.hook_event_name ?? "Unknown";
  let eventType = rawEventType;
  const toolName = data.tool_name ?? null;
  const timestampMs = Date.now();

  // Normalize Gemini CLI event types to Claude Code equivalents
  if (eventType === "BeforeTool") eventType = "PreToolUse";
  else if (eventType === "AfterTool") eventType = "PostToolUse";
  else if (eventType === "BeforeModel") {
    eventType = "UserPromptSubmit";
    // Extract user_prompt from Gemini's llm_request format
    const messages = (data as any).llm_request?.messages;
    if (Array.isArray(messages)) {
      const lastUser = [...messages]
        .reverse()
        .find((m: any) => m.role === "user");
      if (lastUser?.content) {
        const text =
          typeof lastUser.content === "string"
            ? lastUser.content
            : Array.isArray(lastUser.content)
              ? lastUser.content
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join("\n")
              : "";
        if (text) (data as any).user_prompt = text;
      }
    }
  }

  const repo = resolveEventRepo(data);

  insertHookEvent({
    session_id: sessionId,
    event_type: eventType,
    timestamp_ms: timestampMs,
    cwd: data.cwd,
    repository: repo ?? undefined,
    tool_name: toolName ?? undefined,
    payload: data,
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
          const command = data.tool_input?.command;
          if (typeof command === "string" && allowed.bash_commands?.length) {
            decision = checkBashPermission(command, allowed.bash_commands);
          }
        } else if (allowed.tools?.includes(toolName)) {
          decision = { allow: true, reason: `Tool "${toolName}" is allowed` };
        }
      }
    }

    if (decision) {
      // Gemini CLI expects {decision, reason} at top level
      if (rawEventType === "BeforeTool") {
        return { decision: "allow", reason: decision.reason };
      }
      // Claude Code expects hookSpecificOutput format
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: decision.reason,
        },
      };
    }
  }

  return {};
}
