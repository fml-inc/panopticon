import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import {
  insertHookEvent,
  upsertSession,
  upsertSessionCwd,
  upsertSessionRepository,
} from "../db/store.js";
import { resolveRepoFromCwd } from "../repo.js";
import { allTargets } from "../targets/index.js";
import type { TargetAdapter } from "../targets/types.js";
import { checkBashPermission } from "./permissions.js";

// Cache: cwd → { name, email }
const gitIdentityCache = new Map<
  string,
  { name: string | null; email: string | null }
>();

function resolveGitIdentity(cwd: string): {
  name: string | null;
  email: string | null;
} {
  const cached = gitIdentityCache.get(cwd);
  if (cached) return cached;

  const result = { name: null as string | null, email: null as string | null };
  try {
    result.name =
      execFileSync("git", ["-C", cwd, "config", "user.name"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    // no user.name configured
  }
  try {
    result.email =
      execFileSync("git", ["-C", cwd, "config", "user.email"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    // no user.email configured
  }
  gitIdentityCache.set(cwd, result);
  return result;
}

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
  target?: string;
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

export function isPanopticonMcpTool(toolName: string): boolean {
  return (
    toolName.startsWith("mcp__plugin_panopticon_panopticon__") ||
    toolName.startsWith("mcp__panopticon__")
  );
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
/** Cache of resolved target per session — once identified, reuse for all events. */
const sessionTargetCache = new Map<string, string>();

/** Clear the session target cache (for testing). */
export function _resetSessionTargetCache(): void {
  sessionTargetCache.clear();
}

/**
 * Resolve which target adapter sent this event, using the source/target
 * field, session cache, eventMap matching, or payload heuristics.
 */
function resolveTarget(data: HookInput): TargetAdapter | undefined {
  const targets = allTargets();
  const sessionId = data.session_id;

  // 1. Explicit source/target field
  const source = data.source ?? data.target;
  if (source) {
    for (const v of targets) {
      if (v.id === source) {
        if (sessionId) sessionTargetCache.set(sessionId, v.id);
        return v;
      }
    }
  }

  // 2. Session cache — reuse previously identified target
  if (sessionId) {
    const cached = sessionTargetCache.get(sessionId);
    if (cached) {
      return targets.find((v) => v.id === cached);
    }
  }

  // 3. eventMap match (catches Gemini's BeforeTool, AfterTool, BeforeModel)
  const rawEvent = data.hook_event_name;
  if (rawEvent) {
    let matched: TargetAdapter | undefined;
    for (const v of targets) {
      if (rawEvent in v.events.eventMap) {
        if (matched) {
          console.warn(
            `[panopticon] Event "${rawEvent}" claimed by both "${matched.id}" and "${v.id}" — using "${matched.id}"`,
          );
          break;
        }
        matched = v;
      }
    }
    if (matched) {
      if (sessionId) sessionTargetCache.set(sessionId, matched.id);
      return matched;
    }
  }

  // 4. Model-based detection (last resort) — iterate adapter ident specs.
  //    Logs a warning so operators know detection was ambiguous (see #73).
  const model = typeof data.model === "string" ? data.model : null;
  if (model) {
    let matched: TargetAdapter | undefined;
    for (const v of targets) {
      if (v.ident?.modelPatterns?.some((re) => re.test(model))) {
        matched = v;
        break;
      }
    }
    if (matched) {
      console.warn(
        `[panopticon] Target resolved via model-name heuristic: model="${model}" → "${matched.id}". ` +
          `Set an explicit source/target field to avoid ambiguous detection.`,
      );
      if (sessionId) sessionTargetCache.set(sessionId, matched.id);
      return matched;
    }
  }

  return undefined;
}

export function processHookEvent(data: HookInput): Record<string, unknown> {
  const sessionId = data.session_id ?? "unknown";
  const rawEventType = data.hook_event_name ?? "Unknown";
  let eventType = rawEventType;
  const toolName = data.tool_name ?? null;
  const timestampMs = Date.now();

  // Resolve target and normalize event type + payload via adapter
  const target = resolveTarget(data);
  if (target) {
    const mapped = target.events.eventMap[eventType];
    if (mapped) eventType = mapped;
    if (target.events.normalizePayload) {
      data = target.events.normalizePayload(data);
    }
  }

  const repo = resolveEventRepo(data);

  const targetId = target?.id ?? "unknown";

  insertHookEvent({
    session_id: sessionId,
    event_type: eventType,
    timestamp_ms: timestampMs,
    cwd: data.cwd,
    repository: repo ?? undefined,
    tool_name: toolName ?? undefined,
    target: targetId,
    payload: data,
  });

  // Upsert session — each event type contributes different fields
  const sessionFields: Parameters<typeof upsertSession>[0] = {
    session_id: sessionId,
    target: targetId,
  };
  if (eventType === "SessionStart") {
    sessionFields.started_at_ms = timestampMs;
    sessionFields.cwd = data.cwd;
    sessionFields.permission_mode =
      typeof data.permission_mode === "string"
        ? data.permission_mode
        : undefined;
    sessionFields.agent_version =
      typeof data.agent_version === "string" ? data.agent_version : undefined;
  }
  if (eventType === "UserPromptSubmit") {
    const prompt =
      typeof data.prompt === "string"
        ? data.prompt
        : typeof data.user_prompt === "string"
          ? data.user_prompt
          : undefined;
    if (prompt) sessionFields.first_prompt = prompt;
  }
  if (eventType === "Stop" || eventType === "SessionEnd") {
    sessionFields.ended_at_ms = timestampMs;
  }
  upsertSession(sessionFields);

  // Populate session junction tables
  if (repo) {
    const cwd = extractShellPwd(data) ?? (data.cwd as string | undefined);
    const gitId = cwd ? resolveGitIdentity(cwd) : undefined;
    upsertSessionRepository(sessionId, repo, timestampMs, gitId);
  }
  if (data.cwd) {
    upsertSessionCwd(sessionId, data.cwd as string, timestampMs);
  }

  // Permission enforcement via allowed.json
  if (eventType === "PreToolUse" && toolName) {
    let decision: { allow: true; reason: string } | null = null;

    // Always auto-allow panopticon's own MCP tools
    if (isPanopticonMcpTool(toolName)) {
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
      // Use target adapter to format the response, fall back to Claude Code format
      if (target) {
        return target.events.formatPermissionResponse(decision);
      }
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
