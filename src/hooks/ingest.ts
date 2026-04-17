import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import {
  captureUserConfigSnapshot,
  extractWrittenFilePath,
  isTrackedUserConfigPath,
} from "../config-capture.js";
import {
  incrementEventTypeCount,
  incrementToolCount,
  insertHookEvent,
  insertRepoConfigSnapshot,
  upsertSession,
  upsertSessionCwd,
  upsertSessionRepository,
} from "../db/store.js";
import { isEventEnabled } from "../eventConfig.js";
import { log } from "../log.js";
import { getProvider } from "../providers/index.js";
import {
  type RepoInfo,
  resolveGitIdentity,
  resolveRepoFromCwd,
} from "../repo.js";
import { isGitignored, readConfig, resolveGitRoot } from "../scanner.js";
import { allTargets } from "../targets/index.js";
import type { TargetAdapter } from "../targets/types.js";
import { checkBashPermission } from "./permissions.js";

// Last resolved repo per session — used as fallback for events without paths
// (e.g. Stop, UserPromptSubmit). Long-lived in the server process.
const lastSessionRepo = new Map<string, string>();

// Track sessions where we've already captured user config
const userConfigCaptured = new Set<string>();

// Track session:repo pairs where we've already captured repo config
const seenSessionRepos = new Set<string>();

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

export type PathSource =
  | "shell_pwd"
  | "tool_input.file_path"
  | "tool_input.path"
  | "cwd";

export interface EventPath {
  dir: string;
  source: PathSource;
}

/**
 * Extract every directory path we can find from a hook event, in priority
 * order. Consumers can iterate the list to greedily resolve repos, capture
 * config snapshots, etc. without duplicating extraction logic.
 */
export function extractEventPaths(data: HookInput): EventPath[] {
  const paths: EventPath[] = [];
  const seen = new Set<string>();
  const add = (dir: string, source: PathSource) => {
    if (!seen.has(dir)) {
      seen.add(dir);
      paths.push({ dir, source });
    }
  };

  const shellPwd = extractShellPwd(data);
  if (shellPwd) add(shellPwd, "shell_pwd");

  const toolInput = data.tool_input;
  if (toolInput && typeof toolInput === "object") {
    const fp = (toolInput as Record<string, unknown>).file_path;
    if (typeof fp === "string" && path.isAbsolute(fp)) {
      add(path.dirname(fp), "tool_input.file_path");
    }
    const p = (toolInput as Record<string, unknown>).path;
    if (typeof p === "string" && path.isAbsolute(p)) {
      add(path.dirname(p), "tool_input.path");
    }
  }

  if (typeof data.cwd === "string") add(data.cwd, "cwd");

  return paths;
}

export type ResolveFn = (dir: string) => RepoInfo | string | null;

function normalizeResolveFn(
  resolveFn: ResolveFn,
): (dir: string) => RepoInfo | null {
  return (dir: string) => {
    const result = resolveFn(dir);
    if (!result) return null;
    if (typeof result === "string") return { repo: result };
    return result;
  };
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
  resolveFn: ResolveFn = resolveRepoFromCwd,
): string | null {
  const sessionId = data.session_id ?? "unknown";

  let repo = data.repository ?? null;

  if (!repo) {
    const resolve = normalizeResolveFn(resolveFn);
    for (const { dir } of extractEventPaths(data)) {
      const info = resolve(dir);
      if (info) {
        repo = info.repo;
        break;
      }
    }
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

/**
 * Resolve ALL repos touched by this event — the primary repo plus any
 * additional repos referenced via tool_input paths.
 * Returns deduplicated { repo, dir, branch } tuples.
 */
export function resolveAllEventRepos(
  data: HookInput,
  resolveFn: ResolveFn = resolveRepoFromCwd,
): Array<{ repo: string; dir: string; branch?: string | null }> {
  const results: Array<{
    repo: string;
    dir: string;
    branch?: string | null;
  }> = [];
  const seen = new Set<string>();
  const resolve = normalizeResolveFn(resolveFn);

  // Explicit repository field first
  if (data.repository) {
    seen.add(data.repository);
    const shellPwd = extractShellPwd(data);
    results.push({
      repo: data.repository,
      dir: shellPwd ?? (data.cwd as string) ?? ".",
    });
  }

  for (const { dir } of extractEventPaths(data)) {
    const info = resolve(dir);
    if (info && !seen.has(info.repo)) {
      seen.add(info.repo);
      results.push({ repo: info.repo, dir, branch: info.branch });
    }
  }

  return results;
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
          log.hooks.warn(
            `Event "${rawEvent}" claimed by both "${matched.id}" and "${v.id}" — using "${matched.id}"`,
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
      log.hooks.warn(
        `Target resolved via model-name heuristic: model="${model}" → "${matched.id}". ` +
          `Set an explicit source/target field to avoid ambiguous detection.`,
      );
      if (sessionId) sessionTargetCache.set(sessionId, matched.id);
      return matched;
    }
  }

  return undefined;
}

/**
 * Process a hook event: normalize, store, and optionally enforce permissions.
 *
 * Called by the server's POST /hooks handler for every hook event from any
 * target (Claude Code, Gemini, Codex). The flow:
 *   1. Resolve which target adapter sent this event
 *   2. Map the event name to canonical form (e.g. Gemini's "BeforeTool" → "PreToolUse")
 *   3. Resolve the git repository from cwd/file paths
 *   4. Store the event in hook_events table (full payload as gzipped blob)
 *   5. Upsert session metadata (started_at, first_prompt, ended_at, etc.)
 *   6. For PreToolUse: check allowed.json and return permission decision
 *
 * Returns {} for most events. For PreToolUse, may return a permission
 * response that Claude Code uses to auto-approve/deny the tool call.
 */
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

  // Fall back to provider id when we can't resolve a target adapter. Proxy
  // captures on provider-prefixed routes (e.g. /proxy/anthropic/*) set
  // `target: "anthropic"` on events, but "anthropic" isn't a tool in the
  // target registry — it's an upstream API in the provider registry. Without
  // this lookup, every provider-prefixed capture would be tagged "unknown".
  const providerId =
    typeof data.target === "string" && getProvider(data.target)
      ? data.target
      : typeof data.source === "string" && getProvider(data.source)
        ? data.source
        : undefined;
  const targetId = target?.id ?? providerId ?? "unknown";

  // Check if this event type is enabled in the logging config.
  // Permission enforcement still runs even for disabled events so that
  // PreToolUse responses are not silently dropped.
  if (!isEventEnabled(eventType)) {
    // Skip storage but still handle permission enforcement below
    if (eventType === "PreToolUse" && toolName) {
      return buildPermissionResponse(toolName, data, target);
    }
    return {};
  }

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

  // Upsert session — each event type contributes different fields.
  // SessionStart seeds the row; subsequent events enrich it. The session
  // row is the primary join target for queries across hook_events, otel,
  // and scanner tables.
  const sessionFields: Parameters<typeof upsertSession>[0] = {
    session_id: sessionId,
    target: targetId,
    has_hooks: 1,
  };
  if (eventType === "SessionStart") {
    // First event in a session — capture initial state. cwd and
    // permission_mode are snapshot values from launch time.
    sessionFields.started_at_ms = timestampMs;
    sessionFields.created_at = timestampMs;
    sessionFields.permission_mode =
      typeof data.permission_mode === "string"
        ? data.permission_mode
        : undefined;
    sessionFields.agent_version =
      typeof data.agent_version === "string" ? data.agent_version : undefined;
    // Derive project from cwd
    const cwd = data.cwd as string | undefined;
    if (cwd) {
      const repoInfo = resolveRepoFromCwd(cwd);
      sessionFields.project = repoInfo?.repo ?? path.basename(cwd);
    }
  }
  if (eventType === "UserPromptSubmit") {
    // Capture the first user prompt for session search/display. Only the
    // first prompt is stored (upsertSession uses INSERT OR IGNORE semantics
    // for first_prompt).
    const prompt =
      typeof data.prompt === "string"
        ? data.prompt
        : typeof data.user_prompt === "string"
          ? data.user_prompt
          : undefined;
    if (prompt) sessionFields.first_prompt = prompt;
  }
  if (eventType === "Stop" || eventType === "SessionEnd") {
    // Mark session end time. Stop fires on every turn completion, so
    // ended_at_ms gets updated repeatedly — the last Stop or SessionEnd
    // wins, giving us the true end time.
    sessionFields.ended_at_ms = timestampMs;
  }
  upsertSession(sessionFields);

  // Link subagent sessions to their parents in real-time.
  // SubagentStart fires on the PARENT session with agent_id identifying
  // the child. The subagent session ID follows the scanner convention:
  // "agent-{agent_id}" (matches file naming agent-*.jsonl).
  if (eventType === "SubagentStart" || eventType === "SubagentStop") {
    const agentId = data.agent_id as string | undefined;
    if (agentId) {
      const subagentSessionId = `agent-${agentId}`;
      const subagentFields: Parameters<typeof upsertSession>[0] = {
        session_id: subagentSessionId,
        target: targetId,
        parent_session_id: sessionId,
        relationship_type: "subagent",
        is_automated: 1,
      };
      if (eventType === "SubagentStart") {
        subagentFields.started_at_ms = timestampMs;
        subagentFields.created_at = timestampMs;
      } else {
        subagentFields.ended_at_ms = timestampMs;
      }
      upsertSession(subagentFields);
    }
  }

  // Increment event type + tool counts on the session
  incrementEventTypeCount(sessionId, eventType);
  if (eventType === "PreToolUse" && toolName) {
    incrementToolCount(sessionId, toolName);
  }

  // Populate session junction tables — greedily resolve all repos touched
  // by this event (primary cwd + any paths in tool_input).
  const allRepos = resolveAllEventRepos(data);
  for (const { repo: r, dir, branch } of allRepos) {
    const gitId = resolveGitIdentity(dir);
    upsertSessionRepository(sessionId, r, timestampMs, gitId, branch);

    // Capture repo config on first encounter per session
    const repoKey = `${sessionId}:${r}`;
    if (!seenSessionRepos.has(repoKey)) {
      seenSessionRepos.add(repoKey);
      try {
        const cfg = readConfig(dir);
        const gitRoot = resolveGitRoot(dir);
        const localSettingsPath = path.join(
          gitRoot ?? dir,
          ".claude",
          "settings.local.json",
        );
        insertRepoConfigSnapshot({
          repository: r,
          cwd: dir,
          sessionId,
          hooks: cfg.project?.hooks ?? [],
          mcpServers: cfg.project?.mcpServers ?? [],
          commands: cfg.project?.commands ?? [],
          agents: cfg.project?.agents ?? [],
          rules: cfg.project?.rules ?? [],
          localHooks: cfg.projectLocal?.hooks ?? [],
          localMcpServers: cfg.projectLocal?.mcpServers ?? [],
          localPermissions: cfg.projectLocal?.permissions ?? {
            allow: [],
            ask: [],
            deny: [],
          },
          localIsGitignored: isGitignored(localSettingsPath, gitRoot ?? dir),
          instructions: cfg.instructions,
        });
      } catch {
        // Non-fatal — config scan failure shouldn't break hook processing
      }
    }
  }
  if (data.cwd) {
    upsertSessionCwd(sessionId, data.cwd as string, timestampMs);
  }

  // Capture user config on SessionStart (once per session) — baseline
  if (eventType === "SessionStart" && !userConfigCaptured.has(sessionId)) {
    userConfigCaptured.add(sessionId);
    captureUserConfigSnapshot(data.cwd as string | undefined);
  }

  // Capture user config on PostToolUse when a tool wrote to a tracked file
  // (memory/*.md or panopticon permissions). Content-hash dedup inside the
  // insert means no-op when nothing actually changed.
  if (eventType === "PostToolUse") {
    const writtenPath = extractWrittenFilePath(
      data.tool_input as Record<string, unknown> | undefined,
    );
    if (writtenPath && isTrackedUserConfigPath(writtenPath)) {
      captureUserConfigSnapshot(data.cwd as string | undefined);
    }
  }

  // Permission enforcement via allowed.json
  if (eventType === "PreToolUse" && toolName) {
    return buildPermissionResponse(toolName, data, target);
  }

  return {};
}

/**
 * Evaluate PreToolUse permission for a tool call.
 * Returns a formatted permission response if auto-allowed, otherwise {}.
 */
function buildPermissionResponse(
  toolName: string,
  data: HookInput,
  target: TargetAdapter | undefined,
): Record<string, unknown> {
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

  return {};
}
