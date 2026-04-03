/**
 * Target adapter types — each supported coding tool declares its specifics
 * via this interface so consumers can iterate over the registry instead of
 * hardcoding target-specific branches.
 */

import type { HookInput } from "../hooks/ingest.js";

/**
 * All hook event names panopticon registers for.
 *
 * Claude Code fires these as shell commands via hooks.json — each invocation
 * pipes a JSON payload to stdin with session_id, hook_event_name, and
 * event-specific fields. Panopticon's hook-handler POSTs the payload to
 * the local server, which calls processHookEvent() in ingest.ts.
 *
 * Non-Claude targets (Gemini, Codex) map their native event names to these
 * canonical names via their adapter's eventMap.
 */
export const ALL_EVENTS = [
  // ── Session lifecycle ────────────────────────────────────────────────────
  // SessionStart: Fired once when `claude` launches or a new conversation begins.
  //   Payload: cwd, permission_mode, model, agent_version.
  //   Panopticon uses this to auto-start the server process (see handler.ts).
  "SessionStart",
  // SessionEnd: Fired when the session process exits (user quits, ctrl+C, or
  //   process terminates). May not fire on SIGKILL. Carries final session state.
  "SessionEnd",
  // Setup: Fired early in startup, after setCwd() but before the REPL renders.
  //   Runs before trust dialogs, so git commands may not have executed yet.
  "Setup",

  // ── User interaction ─────────────────────────────────────────────────────
  // UserPromptSubmit: Fired when the user submits a prompt (presses Enter in
  //   REPL or sends via SDK). Payload: prompt text. Fires before model inference.
  "UserPromptSubmit",

  // ── Tool lifecycle (highest volume events) ───────────────────────────────
  // PreToolUse: Fired BEFORE each tool execution. Payload: tool_name, tool_input.
  //   This is the permission enforcement point — hooks can return a
  //   permissionDecision ("allow"/"deny") to approve/reject without user prompt.
  //   Panopticon checks allowed.json here for auto-approval rules.
  "PreToolUse",
  // PostToolUse: Fired AFTER a tool executes successfully. Payload: tool_name,
  //   tool_input, tool_result. Good for auditing what tools actually did.
  "PostToolUse",
  // PostToolUseFailure: Fired AFTER a tool execution fails (error, file not found,
  //   permission denied, etc). Same shape as PostToolUse but indicates failure.
  "PostToolUseFailure",

  // ── Permission prompts ───────────────────────────────────────────────────
  // PermissionRequest: Fired when Claude Code is about to show the user a
  //   permission prompt (tool needs approval). Payload: tool_name, tool_input.
  "PermissionRequest",
  // PermissionDenied: Fired when the user denies a permission prompt.
  "PermissionDenied",

  // ── Model turn lifecycle ─────────────────────────────────────────────────
  // Stop: Fired when the model finishes a turn and stops generating (no more
  //   tool calls to make). Natural end of each assistant response cycle.
  //   A session has many Stop events but only one SessionEnd.
  "Stop",
  // StopFailure: Fired when the model stops due to an error — rate limit,
  //   prompt too long, auth failure, etc. The model never produced a valid
  //   response for this turn.
  "StopFailure",

  // ── Subagents ────────────────────────────────────────────────────────────
  // SubagentStart: Fired when a subagent is spawned via the Agent tool.
  //   Payload includes the agent type and description.
  "SubagentStart",
  // SubagentStop: Fired when a subagent completes (success or failure).
  "SubagentStop",

  // ── Context compaction ───────────────────────────────────────────────────
  // PreCompact: Fired before conversation context is compacted (summarized to
  //   reduce token count). Useful for capturing pre-compaction state.
  "PreCompact",
  // PostCompact: Fired after compaction completes. Payload includes token
  //   counts before/after compaction.
  "PostCompact",

  // ── Notifications ────────────────────────────────────────────────────────
  // Notification: System notifications — rate limit warnings, usage alerts, etc.
  "Notification",

  // ── Team / background tasks ──────────────────────────────────────────────
  // TeammateIdle: Fired when a teammate agent (swarm mode) has no work to do.
  "TeammateIdle",
  // TaskCreated: Fired when a background task is created (via TaskCreate tool).
  "TaskCreated",
  // TaskCompleted: Fired when a background task finishes.
  "TaskCompleted",

  // ── MCP auth / elicitation ───────────────────────────────────────────────
  // Elicitation: Fired when an MCP server triggers an OAuth/auth flow prompt.
  "Elicitation",
  // ElicitationResult: Fired when the user completes or cancels the auth flow.
  "ElicitationResult",

  // ── Configuration & file system ──────────────────────────────────────────
  // ConfigChange: Fired when settings.json, CLAUDE.md, or similar config changes.
  "ConfigChange",
  // InstructionsLoaded: Fired when CLAUDE.md files are loaded into context.
  "InstructionsLoaded",
  // CwdChanged: Fired when Claude Code's working directory changes (via /add-dir
  //   or similar). NOTE: `cd` in Bash does NOT trigger this — that only affects
  //   the subprocess shell, not the harness's cwd.
  "CwdChanged",
  // FileChanged: Fired when a watched file is modified on disk (external edit).
  "FileChanged",

  // ── Worktree management ──────────────────────────────────────────────────
  // WorktreeCreate: Fired when a git worktree is created (--worktree flag or
  //   EnterWorktree tool).
  "WorktreeCreate",
  // WorktreeRemove: Fired when a git worktree is removed (ExitWorktree tool
  //   or session cleanup).
  "WorktreeRemove",
] as const;

/** Union type of all supported event names. */
export type CanonicalEvent = (typeof ALL_EVENTS)[number];

// ── Config & Paths ──────────────────────────────────────────────────────────

export interface TargetConfigSpec {
  /** Directory where this target stores its config, e.g. ~/.claude */
  dir: string;
  /** Path to the main config file */
  configPath: string;
  /** Format of the config file */
  configFormat: "json" | "toml";
}

// ── Hook Registration ───────────────────────────────────────────────────────

export interface TargetInstallOpts {
  pluginRoot: string;
  port: number;
  proxy?: boolean;
}

export interface TargetHookSpec {
  /** Event names this target uses, in the target's own convention */
  events: string[];
  /**
   * Apply panopticon hook registration (and related config like MCP servers,
   * telemetry) to this target's existing config. Each target handles its own
   * deduplication/merge logic. Returns the modified config.
   */
  applyInstallConfig(
    existingConfig: Record<string, unknown>,
    opts: TargetInstallOpts,
  ): Record<string, unknown>;
  /**
   * Remove panopticon hook registration (and related config like MCP servers,
   * telemetry) from this target's existing config. Returns the modified config.
   */
  removeInstallConfig(
    existingConfig: Record<string, unknown>,
  ): Record<string, unknown>;
}

// ── Shell Environment ───────────────────────────────────────────────────────

export interface TargetShellEnvSpec {
  /**
   * Env vars to export as [varName, value] tuples.
   * These are target-specific; shared OTEL_* vars are handled separately.
   */
  envVars(port: number, proxy: boolean): Array<[string, string]>;
}

// ── Event Normalization ─────────────────────────────────────────────────────

export interface TargetEventSpec {
  /** Map from target's event name to canonical panopticon event name. */
  eventMap: Record<string, CanonicalEvent>;
  /**
   * Transform the raw hook payload before storage.
   * Used e.g. by Gemini to extract user_prompt from llm_request.messages.
   */
  normalizePayload?(data: HookInput): HookInput;
  /**
   * Format a permission response for this target's expected shape.
   */
  formatPermissionResponse(decision: {
    allow: boolean;
    reason: string;
  }): Record<string, unknown>;
}

// ── Doctor / Detection ──────────────────────────────────────────────────────

export interface TargetDetectSpec {
  /** Human-readable name for display, e.g. "Claude Code" */
  displayName: string;
  /** Check whether this target is installed on the system */
  isInstalled(): boolean;
  /** Check whether panopticon is configured within this target */
  isConfigured(): boolean;
}

// ── OTel Telemetry Schema ────────────────────────────────────────────────────

export interface MetricSpec {
  /** OTel metric name(s) this target emits for token usage */
  metricNames: string[];
  /** Aggregation function: 'SUM' for per-request deltas, 'MAX' for cumulative counters */
  aggregation: "SUM" | "MAX";
  /** JSON paths to extract token type from metric attributes (first non-null wins) */
  tokenTypeAttrs: string[];
  /** JSON paths to extract model name from metric attributes (first non-null wins) */
  modelAttrs: string[];
  /** Remap token_type values before aggregation, e.g. { cached_input: 'cacheRead' } */
  tokenTypeMap?: Record<string, string>;
  /** Token type values to exclude (e.g. 'total' to avoid double-counting) */
  excludeTokenTypes?: string[];
}

export interface OtelLogFieldSpec {
  /** SQL expressions to extract event type from otel_logs (COALESCEd). Default: ['body'] */
  eventTypeExprs?: string[];
  /** SQL expressions to extract timestamp in ms from otel_logs. Default: ['CAST(timestamp_ns / 1000000 AS INTEGER)'] */
  timestampMsExprs?: string[];
}

export interface TargetOtelSpec {
  /** OTel service.name this target emits. Used for session inference when metrics lack session_id. */
  serviceName?: string;
  /** Token usage metric declaration. Undefined means no token metrics. */
  metrics?: MetricSpec;
  /** How to extract event type and timestamp from otel_logs rows. */
  logFields?: OtelLogFieldSpec;
}

// ── Target Identification ────────────────────────────────────────────────────

export interface TargetIdentSpec {
  /** Model-name regex patterns for last-resort target identification from hook payloads */
  modelPatterns?: RegExp[];
}

// ── Proxy (optional — not all targets use the proxy) ────────────────────────

export interface TargetProxySpec {
  /**
   * Upstream host for API proxying.
   * String for simple mapping; function for dynamic routing (e.g. Codex JWT).
   */
  upstreamHost: string | ((headers: Record<string, string>) => string);
  /** Path rewrite rule, if needed. Default: pass through. */
  rewritePath?(path: string, headers: Record<string, string>): string;
  /** Which stream accumulator to use */
  accumulatorType: "anthropic" | "openai";
}

// ── Session File Scanner ─────────────────────────────────────────────────────

export interface DiscoveredFile {
  filePath: string;
}

export interface ParsedTurn {
  sessionId: string;
  turnIndex: number;
  timestampMs: number;
  model?: string;
  role: "user" | "assistant";
  contentPreview?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

export type RelationshipType = "subagent" | "continuation" | "fork";

export interface ParsedSession {
  sessionId: string;
  parentSessionId?: string;
  relationshipType?: RelationshipType;
  model?: string;
  cwd?: string;
  cliVersion?: string;
  startedAtMs?: number;
  firstPrompt?: string;
}

export interface ParsedEvent {
  sessionId: string;
  eventType: string; // tool_call, tool_result, error, agent_message, reasoning, file_snapshot, info
  timestampMs: number;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

// ── Parsed messages & tool calls (for messages/tool_calls tables) ───────────

export interface ParsedToolCall {
  toolUseId: string;
  toolName: string;
  category: string;
  inputJson?: string;
  skillName?: string;
  resultContentLength?: number;
  resultContent?: string;
  subagentSessionId?: string;
}

export interface ParsedMessage {
  sessionId: string;
  ordinal: number;
  role: "user" | "assistant";
  content: string;
  timestampMs?: number;
  hasThinking: boolean;
  hasToolUse: boolean;
  isSystem: boolean;
  contentLength: number;
  model?: string;
  tokenUsage?: string;
  contextTokens?: number;
  outputTokens?: number;
  hasContextTokens: boolean;
  hasOutputTokens: boolean;
  toolCalls: ParsedToolCall[];
  /** tool_use_id → raw result content (from tool_result blocks in user messages) */
  toolResults: Map<string, { contentLength: number; contentRaw: string }>;
}

export interface ParseResult {
  meta?: ParsedSession;
  turns: ParsedTurn[];
  events: ParsedEvent[];
  messages: ParsedMessage[];
  newByteOffset: number;
  /**
   * When true, turn indices are absolute (0-based from start of session)
   * and the caller should NOT re-index them. Used by parsers that re-read
   * the full file (e.g. Gemini JSON) rather than reading incrementally.
   * INSERT OR IGNORE handles dedup via the UNIQUE constraint.
   */
  absoluteIndices?: boolean;
  /** Additional sessions from DAG fork detection (branched conversations). */
  forks?: ParseResult[];
  /**
   * When true, the parser detected a DAG fork during incremental reading.
   * The caller should reset the file watermark and reparse from byte 0
   * so fork detection can run on the full file.
   */
  needsFullReparse?: boolean;
  /**
   * Tool results from filtered-out messages (e.g. tool-result-only user
   * messages) that still need to be backfilled into tool_calls.
   */
  orphanedToolResults?: Map<
    string,
    { contentLength: number; contentRaw: string }
  >;
}

export interface TargetScannerSpec {
  /** Discover session files on disk for this target. */
  discover(): DiscoveredFile[];
  /**
   * Parse a session file. Receives the file path and current byte offset.
   * Returns parsed data and new byte offset, or null if no new data.
   */
  parseFile(filePath: string, fromByteOffset: number): ParseResult | null;
  /** Normalize a tool name to a standard category for analytics grouping. */
  normalizeToolCategory(toolName: string): string;
}

// ── The Adapter ─────────────────────────────────────────────────────────────

export interface TargetAdapter {
  /** Machine identifier: "claude", "gemini", "codex", etc. */
  id: string;
  config: TargetConfigSpec;
  hooks: TargetHookSpec;
  shellEnv: TargetShellEnvSpec;
  events: TargetEventSpec;
  detect: TargetDetectSpec;
  /** Proxy spec is optional — not every target routes through the proxy */
  proxy?: TargetProxySpec;
  /** OTel telemetry schema — how this target emits metrics and logs */
  otel?: TargetOtelSpec;
  /** How to identify this target from hook payloads when no explicit source field is present */
  ident?: TargetIdentSpec;
  /** Session file scanner — reads local transcript files for token usage */
  scanner?: TargetScannerSpec;
}
