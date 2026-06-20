import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  captureUserConfigSnapshot,
  extractWrittenFilePath,
  isTrackedUserConfigPath,
} from "../config-capture.js";
import { getDb } from "../db/schema.js";
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
import { recordIntentClaimsFromHookEvent } from "../intent/asserters/from_hooks.js";
import { reconcileLandedClaimsFromDisk } from "../intent/asserters/landed_from_disk.js";
import { isEditToolName } from "../intent/editParsing.js";
import { rebuildIntentProjection } from "../intent/project.js";
import { log } from "../log.js";
import {
  dirnameOfObservedPath,
  isObservedAbsolutePath,
  resolveFilePathFromCwd,
} from "../paths.js";
import { getProvider } from "../providers/index.js";
import {
  type RepoInfo,
  resolveGitHeadSha,
  resolveGitIdentity,
  resolveRepoFromCwd,
} from "../repo.js";
import { isGitignored, readConfig, resolveGitRoot } from "../scanner.js";
import { allTargets } from "../targets/index.js";
import type { TargetAdapter } from "../targets/types.js";
import { checkBashPermission } from "./permissions.js";
import {
  buildPreToolUseFileContext,
  buildPreToolUseReadFileContext,
  buildSessionStartRecentHistoryContext,
  buildUserPromptSubmitLocalContext,
} from "./session-context.js";

// Last resolved repo per session — used as fallback for events without paths
// (e.g. Stop, UserPromptSubmit). Long-lived in the server process.
const lastSessionRepo = new Map<string, string>();

// Track sessions where we've already captured user config
const userConfigCaptured = new Set<string>();

// Anti-nag: PreToolUse path context fires at most once per session+path across
// read and edit surfaces, so inspecting a file and then editing it does not
// re-inject the same local history. Long-lived in the server process (mirrors
// userConfigCaptured); resets on restart, which is fine.
const preToolUseFileContextSeen = new Set<string>();

// Test seam: clear the once-per-session+path dedupe set.
export function _resetPreToolUseFileContextSeen(): void {
  preToolUseFileContextSeen.clear();
}

/**
 * Dedupe a once-per-session+path emission. `build` is invoked only when the
 * key has not been seen; the key is marked seen only when `build` yields
 * content, so a file that gains history mid-session still gets its one shot.
 */
export function emitOncePerSessionPath<T>(
  sessionId: string,
  filePath: string,
  build: () => T | null,
): T | null {
  const key = `${sessionId}:${filePath}`;
  if (preToolUseFileContextSeen.has(key)) return null;
  const result = build();
  if (!result) return null;
  preToolUseFileContextSeen.add(key);
  return result;
}

const FILE_CONTEXT_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);
const READ_CONTEXT_TOOLS = new Set(["Read", "Bash"]);

// Track session:repo pairs where we've already captured repo config
const seenSessionRepos = new Set<string>();

export interface HookInput {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  repository?: string;
  transcript_path?: string;
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
    toolName.startsWith("mcp__panopticon__") ||
    toolName.startsWith("panopticon/")
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
  | "tool_input.workdir"
  | "tool_input.cwd"
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
    const workdir = (toolInput as Record<string, unknown>).workdir;
    if (typeof workdir === "string" && isObservedAbsolutePath(workdir)) {
      add(workdir, "tool_input.workdir");
    }
    const cwd = (toolInput as Record<string, unknown>).cwd;
    if (typeof cwd === "string" && isObservedAbsolutePath(cwd)) {
      add(cwd, "tool_input.cwd");
    }
    const fp = (toolInput as Record<string, unknown>).file_path;
    if (typeof fp === "string" && isObservedAbsolutePath(fp)) {
      add(dirnameOfObservedPath(fp), "tool_input.file_path");
    }
    const p = (toolInput as Record<string, unknown>).path;
    if (typeof p === "string" && isObservedAbsolutePath(p)) {
      add(dirnameOfObservedPath(p), "tool_input.path");
    }
  }

  if (typeof data.cwd === "string") add(data.cwd, "cwd");

  return paths;
}

function isCwdPathSource(source: PathSource): boolean {
  return (
    source === "shell_pwd" ||
    source === "tool_input.workdir" ||
    source === "tool_input.cwd" ||
    source === "cwd"
  );
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
 *   6. For SessionStart/UserPromptSubmit: optionally return bounded local
 *      history as additional context
 *   7. For PreToolUse / PermissionRequest: check allowed.json and return a
 *      target-specific permission decision
 *
 * Returns {} for most events. For SessionStart/UserPromptSubmit, may return
 * additional context. For PreToolUse / PermissionRequest, may return a
 * permission response that the target uses to auto-approve/deny the tool call
 * or approval prompt.
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
  // Permission enforcement still runs even for disabled events so that hook
  // responses are not silently dropped.
  if (!isEventEnabled(eventType)) {
    // Skip storage but still handle permission enforcement below
    if (
      (eventType === "PreToolUse" || eventType === "PermissionRequest") &&
      toolName
    ) {
      return buildPermissionResponse(eventType, toolName, data, target);
    }
    return {};
  }

  const hookEventId = insertHookEvent({
    session_id: sessionId,
    event_type: eventType,
    timestamp_ms: timestampMs,
    cwd: data.cwd,
    repository: repo ?? undefined,
    tool_name: toolName ?? undefined,
    target: targetId,
    payload: data,
  });

  try {
    recordIntentClaimsFromHookEvent({
      sessionId,
      eventType,
      hookEventId,
      timestampMs,
      cwd: typeof data.cwd === "string" ? data.cwd : null,
      repository: repo ?? null,
      payload: data as Record<string, unknown>,
    });
  } catch (err) {
    log.hooks.error("intent claim ingest failed:", err);
  }

  // Mirror the gate in recordIntentClaimsFromHookEvent — that function uses
  // EDIT_TOOL_NAMES which includes Codex's edit_file/write_file/create_file/
  // apply_patch. If we hardcode Claude-only tool names here, Codex
  // PostToolUse events write claims but never trigger a projection refresh,
  // so intent-backed MCP tools serve stale data mid-turn until the next
  // UserPromptSubmit/Stop/SessionEnd event happens to land.
  const shouldRefreshIntentProjection =
    eventType === "UserPromptSubmit" ||
    (eventType === "PostToolUse" &&
      typeof toolName === "string" &&
      isEditToolName(toolName));

  if (shouldRefreshIntentProjection) {
    try {
      rebuildIntentProjection({ sessionId });
    } catch (err) {
      log.hooks.error("intent projection refresh failed:", err);
    }
  }

  if (eventType === "Stop" || eventType === "SessionEnd") {
    try {
      reconcileLandedClaimsFromDisk({ sessionId });
      rebuildIntentProjection({ sessionId });
    } catch (err) {
      log.hooks.error("intent reconciliation failed:", err);
    }
  }

  // Upsert session — each event type contributes different fields.
  // SessionStart seeds the row; subsequent events enrich it. The session
  // row is the primary join target for queries across hook_events, otel,
  // and scanner tables.
  const sessionFields: Parameters<typeof upsertSession>[0] = {
    session_id: sessionId,
    target: targetId,
    has_hooks: 1,
  };
  if (
    targetId === "gemini" &&
    typeof data.transcript_path === "string" &&
    isObservedAbsolutePath(data.transcript_path)
  ) {
    sessionFields.scanner_file_path = data.transcript_path;
  }
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

  // Link subagent sessions to their parents in real-time. The child session
  // identifier is target-specific: Claude uses agent-* JSONL files, while
  // other targets may expose real child session IDs in the hook payload.
  if (eventType === "SubagentStart" || eventType === "SubagentStop") {
    const resolvedSubagent = target?.events.resolveSubagentSessionFromHook?.({
      eventType,
      sessionId,
      data,
    });
    if (resolvedSubagent) {
      // Stop hooks can arrive before the scanner has created the child row.
      // Do not create a marker-only session for those stop-only races; the
      // scanner will later reconcile Hermes child sessions from parent_session_id.
      const childExists =
        eventType === "SubagentStart" ||
        Boolean(
          getDb()
            .prepare("SELECT 1 FROM sessions WHERE session_id = ?")
            .get(resolvedSubagent.sessionId),
        );
      if (childExists) {
        const subagentFields: Parameters<typeof upsertSession>[0] = {
          session_id: resolvedSubagent.sessionId,
          target: targetId,
          parent_session_id: resolvedSubagent.parentSessionId,
          relationship_type: resolvedSubagent.relationshipType,
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
  }

  // Increment event type + tool counts on the session
  incrementEventTypeCount(sessionId, eventType);
  if (
    (eventType === "PreToolUse" || eventType === "PermissionRequest") &&
    toolName
  ) {
    incrementToolCount(sessionId, toolName);
  }

  // Populate session junction tables — greedily resolve all repos touched
  // by this event (primary cwd + any paths in tool_input).
  const allRepos = resolveAllEventRepos(data);
  for (const { repo: r, dir, branch } of allRepos) {
    const gitId = resolveGitIdentity(dir);
    // Capture HEAD only at SessionStart: it is the replay anchor (the code
    // state the session began from). Resolving it per-event would add a
    // git call to the hot path; first-write-wins in the upsert preserves
    // the start value as the working tree moves during the session.
    const headSha =
      eventType === "SessionStart" ? resolveGitHeadSha(dir) : null;
    upsertSessionRepository(sessionId, r, timestampMs, gitId, branch, headSha);

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
  const seenCwds = new Set<string>();
  for (const { dir, source } of extractEventPaths(data)) {
    if (!isCwdPathSource(source) || seenCwds.has(dir)) continue;
    seenCwds.add(dir);
    upsertSessionCwd(sessionId, dir, timestampMs);
  }

  // Capture user config on SessionStart (once per session) — baseline
  if (eventType === "SessionStart" && !userConfigCaptured.has(sessionId)) {
    userConfigCaptured.add(sessionId);
    captureUserConfigSnapshot(data.cwd as string | undefined, targetId);
  }

  // Capture user config on PostToolUse when a tool wrote to a tracked file
  // (memory/*.md or panopticon permissions). Content-hash dedup inside the
  // insert means no-op when nothing actually changed.
  if (eventType === "PostToolUse") {
    const writtenPath = extractWrittenFilePath(
      data.tool_input as Record<string, unknown> | undefined,
    );
    if (writtenPath && isTrackedUserConfigPath(writtenPath, targetId)) {
      captureUserConfigSnapshot(data.cwd as string | undefined, targetId);
    }
  }

  // Permission enforcement via allowed.json
  if (
    (eventType === "PreToolUse" || eventType === "PermissionRequest") &&
    toolName
  ) {
    const permission = buildPermissionResponse(
      eventType,
      toolName,
      data,
      target,
    );
    // Point-of-use provenanced file context: when an additionalContext-capable
    // target is about to edit a file with prior history, surface it alongside
    // the permission decision. Codex PreToolUse allow responses stay a no-op;
    // this only adds context and does not approve the tool.
    if (
      eventType === "PreToolUse" &&
      canInjectPreToolUseAdditionalContext(target) &&
      config.enablePreToolUseFileContextInjection &&
      FILE_CONTEXT_TOOLS.has(toolName)
    ) {
      const additionalContext = buildPreToolUseFileContextOnce(sessionId, {
        ...data,
        repository: repo ?? data.repository,
        // Preserve replay-injected now_ms (handler.ts) when set;
        // otherwise use the server's receive timestamp.
        now_ms:
          typeof data.now_ms === "number" && Number.isFinite(data.now_ms)
            ? data.now_ms
            : timestampMs,
      });
      if (additionalContext) {
        return mergePreToolUseContext(permission, additionalContext);
      }
    }
    // Read-time provenance context stays behind its own flag, but shares the
    // same per-session path dedupe as edit-time context to avoid repeat
    // injections when a file is inspected and then edited.
    if (
      eventType === "PreToolUse" &&
      canInjectPreToolUseAdditionalContext(target) &&
      config.enablePreToolUseReadContextInjection &&
      READ_CONTEXT_TOOLS.has(toolName)
    ) {
      const additionalContext = buildPreToolUseReadFileContextOnce(sessionId, {
        ...data,
        repository: repo ?? data.repository,
        now_ms:
          typeof data.now_ms === "number" && Number.isFinite(data.now_ms)
            ? data.now_ms
            : timestampMs,
      });
      if (additionalContext) {
        return mergePreToolUseContext(permission, additionalContext);
      }
    }
    return permission;
  }

  if (
    eventType === "UserPromptSubmit" &&
    config.enableUserPromptSubmitContextInjection &&
    // Injection is disabled on the session's first prompt by design: a vague
    // opener only matches ambient repo vocabulary, and SessionStart history
    // injection already covers session entry. Only mid-session prompts inject.
    !isFirstUserPromptSubmit(sessionId)
  ) {
    const response = buildUserPromptSubmitContextResponse({
      ...data,
      repository: repo ?? data.repository,
      is_first_user_prompt_submit: false,
      now_ms:
        typeof data.now_ms === "number" && Number.isFinite(data.now_ms)
          ? data.now_ms
          : timestampMs,
    });
    if (response) return response;
  }

  if (
    eventType === "SessionStart" &&
    config.enableSessionStartHistoryInjection
  ) {
    const response = buildSessionStartContextResponse({
      ...data,
      now_ms:
        typeof data.now_ms === "number" && Number.isFinite(data.now_ms)
          ? data.now_ms
          : timestampMs,
    });
    if (response) return response;
  }

  return {};
}

function buildSessionStartContextResponse(
  data: HookInput,
): Record<string, unknown> | null {
  try {
    const additionalContext = buildSessionStartRecentHistoryContext(data);
    if (!additionalContext) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    };
  } catch (err) {
    log.hooks.error("session start context build failed:", err);
    return null;
  }
}

function buildUserPromptSubmitContextResponse(
  data: HookInput,
): Record<string, unknown> | null {
  try {
    const additionalContext = buildUserPromptSubmitLocalContext(data);
    if (!additionalContext) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    };
  } catch (err) {
    log.hooks.error("user prompt submit context build failed:", err);
    return null;
  }
}

function canInjectPreToolUseAdditionalContext(
  target: TargetAdapter | undefined,
): boolean {
  return (
    !target ||
    target.id === "claude" ||
    target.id === "claude-desktop" ||
    target.id === "codex"
  );
}

function buildPreToolUseFileContextOnce(
  sessionId: string,
  data: HookInput,
): string | null {
  try {
    const filePath = extractWrittenFilePath(
      data.tool_input as Record<string, unknown> | undefined,
    );
    if (!filePath) return null;
    return emitOncePerSessionPath(
      sessionId,
      contextDedupePath(filePath, data),
      () => buildPreToolUseFileContext(data),
    );
  } catch (err) {
    log.hooks.error("pre tool use file context build failed:", err);
    return null;
  }
}

function buildPreToolUseReadFileContextOnce(
  sessionId: string,
  data: HookInput,
): string | null {
  try {
    const filePath = extractReadFilePath(data);
    if (!filePath) return null;
    const contextInput = {
      ...data,
      tool_input: {
        ...(data.tool_input as Record<string, unknown> | undefined),
        file_path: filePath,
      },
    };
    return emitOncePerSessionPath(
      sessionId,
      contextDedupePath(filePath, data),
      () => buildPreToolUseReadFileContext(contextInput),
    );
  } catch (err) {
    log.hooks.error("pre tool use read context build failed:", err);
    return null;
  }
}

function extractReadFilePath(data: HookInput): string | null {
  const toolInput = data.tool_input as Record<string, unknown> | undefined;
  if (!toolInput) return null;
  for (const key of ["file_path", "path"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return resolveReadFilePath(value.trim(), data);
    }
  }
  const command = toolInput.command;
  if (typeof command !== "string") return null;
  const filePath = extractReadFilePathFromBashCommand(command);
  return filePath ? resolveReadFilePath(filePath, data) : null;
}

function resolveReadFilePath(filePath: string, data: HookInput): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  const cwd = extractShellPwd(data) ?? data.cwd ?? null;
  return resolveFilePathFromCwd(filePath, cwd);
}

// Dedupe on the cwd-resolved path so relative and absolute references to the
// same file share one read/edit context injection.
function contextDedupePath(filePath: string, data: HookInput): string {
  return resolveReadFilePath(filePath, data);
}

const BASH_COMMAND_SEPARATORS = new Set([
  ";",
  "&",
  "&&",
  "|",
  "||",
  "<",
  "<<",
  ">",
  ">>",
  ">&1",
  ">&2",
  "1>",
  "1>>",
  "1>&1",
  "1>&2",
  "2>",
  "2>>",
  "2>&1",
  "2>&2",
]);

function extractReadFilePathFromBashCommand(command: string): string | null {
  const tokens = tokenizeShellLikeCommand(command);
  if (tokens.length === 0) return null;

  const redirected = extractInputRedirectPath(tokens);
  if (redirected) return redirected;

  for (const segment of splitCommandSegments(tokens)) {
    const filePath = extractReadFilePathFromCommandSegment(segment);
    if (filePath) return filePath;
  }
  return null;
}

function tokenizeShellLikeCommand(command: string): string[] {
  if (command.length === 0) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (
      current === "" &&
      (ch === "1" || ch === "2") &&
      command[i + 1] === ">"
    ) {
      if (command[i + 2] === ">") {
        tokens.push(`${ch}>>`);
        i += 2;
      } else if (
        command[i + 2] === "&" &&
        (command[i + 3] === "1" || command[i + 3] === "2")
      ) {
        tokens.push(`${ch}>&${command[i + 3]}`);
        i += 3;
      } else {
        tokens.push(`${ch}>`);
        i++;
      }
      continue;
    }
    if (/[;&|<>]/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      const next = command[i + 1];
      if (
        ch === ">" &&
        next === "&" &&
        (command[i + 2] === "1" || command[i + 2] === "2")
      ) {
        tokens.push(`>&${command[i + 2]}`);
        i += 2;
        continue;
      }
      if (
        (ch === "&" && next === "&") ||
        (ch === "|" && next === "|") ||
        (ch === "<" && next === "<") ||
        (ch === ">" && next === ">")
      ) {
        tokens.push(`${ch}${next}`);
        i++;
        continue;
      }
      tokens.push(ch);
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote || escaping) return [];
  if (current) tokens.push(current);
  return tokens;
}

function splitCommandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (BASH_COMMAND_SEPARATORS.has(token)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      if (token === "<" || token === "<<") i++;
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function extractInputRedirectPath(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (token !== "<") continue;
    const candidate = tokens[i + 1];
    if (candidate && isPlausibleReadPathArg(candidate)) return candidate;
  }
  return null;
}

function extractReadFilePathFromCommandSegment(
  tokens: string[],
): string | null {
  const commandTokens = [...tokens];
  while (
    commandTokens[0]?.includes("=") &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(commandTokens[0])
  ) {
    commandTokens.shift();
  }
  const commandName = commandTokens.shift()?.split("/").pop();
  if (!commandName) return null;

  let args: string[];
  switch (commandName) {
    case "bat":
    case "batcat":
    case "cat":
    case "file":
    case "less":
    case "more":
    case "nl":
    case "stat":
    case "wc":
      args = stripSimpleOptions(commandTokens).args;
      break;
    case "head":
    case "tail":
      args = stripSimpleOptions(commandTokens, new Set(["-n", "-c"])).args;
      break;
    case "sed":
      if (hasSedInPlaceFlag(commandTokens)) return null;
      args = readCommandFileArgs(commandTokens, new Set(["-e", "-f"]));
      break;
    case "awk":
      args = readCommandFileArgs(
        commandTokens,
        new Set(["-f", "-v"]),
        new Set(["-f"]),
      );
      break;
    case "grep":
    case "rg":
      args = readCommandFileArgs(
        commandTokens,
        new Set(["-A", "-B", "-C", "-e", "-f", "-g", "-m", "-t"]),
        new Set(["-e", "-f"]),
      );
      break;
    default:
      return null;
  }
  return firstPlausibleReadPathArg(args);
}

function readCommandFileArgs(
  args: string[],
  flagsWithValues: Set<string>,
  patternFlags = flagsWithValues,
): string[] {
  const stripped = stripSimpleOptions(args, flagsWithValues, patternFlags);
  return stripped.consumedPatternFlag ? stripped.args : stripped.args.slice(1);
}

function hasSedInPlaceFlag(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg.startsWith("-i") ||
      arg === "--in-place" ||
      arg.startsWith("--in-place="),
  );
}

function stripSimpleOptions(
  args: string[],
  flagsWithValues = new Set<string>(),
  patternFlags = new Set<string>(),
): { args: string[]; consumedPatternFlag: boolean } {
  const out: string[] = [];
  let consumedPatternFlag = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (flagsWithValues.has(arg)) {
        if (patternFlags.has(arg)) consumedPatternFlag = true;
        if (!arg.includes("=")) i++;
      }
      continue;
    }
    out.push(arg);
  }
  return { args: out, consumedPatternFlag };
}

function firstPlausibleReadPathArg(args: string[]): string | null {
  return args.find(isPlausibleReadPathArg) ?? null;
}

function isPlausibleReadPathArg(arg: string): boolean {
  if (!arg || arg === "-" || arg.startsWith("-")) return false;
  if (BASH_COMMAND_SEPARATORS.has(arg)) return false;
  if (/[\0*?[{}`$]/.test(arg)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) return false;
  return (
    isObservedAbsolutePath(arg) ||
    arg.startsWith("~/") ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.includes("/") ||
    /\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(arg) ||
    /^[A-Z][A-Za-z0-9_.-]*$/.test(arg)
  );
}

function mergePreToolUseContext(
  permission: Record<string, unknown>,
  additionalContext: string,
): Record<string, unknown> {
  const existing = permission.hookSpecificOutput;
  if (existing && typeof existing === "object") {
    return {
      ...permission,
      hookSpecificOutput: {
        ...(existing as Record<string, unknown>),
        additionalContext,
      },
    };
  }
  return {
    ...permission,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext,
    },
  };
}

// Counts the current UserPromptSubmit event, which step 4 of
// processHookEvent has already persisted to hook_events by the time this
// runs — so a count of 1 means this is the session's first prompt.
export function isFirstUserPromptSubmit(sessionId: string): boolean {
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM hook_events
         WHERE session_id = ?
           AND event_type = 'UserPromptSubmit'`,
      )
      .get(sessionId) as { count: number } | undefined;
    return (row?.count ?? 0) <= 1;
  } catch (err) {
    log.hooks.error("user prompt submit count lookup failed:", err);
    // Fail strict: treat as first prompt so the conservative gate applies.
    return true;
  }
}

/**
 * Evaluate hook-time permission handling for a tool call / approval prompt.
 * Returns a formatted permission response if auto-allowed, otherwise {}.
 */
function buildPermissionResponse(
  eventType: "PreToolUse" | "PermissionRequest",
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
      return target.events.formatPermissionResponse(eventType, decision);
    }
    if (eventType === "PermissionRequest") {
      return {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: decision.allow ? "allow" : "deny",
            ...(decision.allow ? {} : { message: decision.reason }),
          },
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.allow ? "allow" : "deny",
        permissionDecisionReason: decision.reason,
      },
    };
  }

  return {};
}
