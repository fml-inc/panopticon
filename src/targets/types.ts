/**
 * Target adapter types — each supported coding tool declares its specifics
 * via this interface so consumers can iterate over the registry instead of
 * hardcoding target-specific branches.
 */

import type { HookInput } from "../hooks/ingest.js";

/** Canonical event names used internally by panopticon. */
export type CanonicalEvent =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

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

export interface ScannerParsedTurn {
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

export interface ScannerParsedSession {
  sessionId: string;
  model?: string;
  cwd?: string;
  cliVersion?: string;
  startedAtMs?: number;
  firstPrompt?: string;
}

export interface ScannerParsedEvent {
  sessionId: string;
  eventType: string; // tool_call, tool_result, error, agent_message, reasoning, file_snapshot, info
  timestampMs: number;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ScannerParseResult {
  meta?: ScannerParsedSession;
  turns: ScannerParsedTurn[];
  events: ScannerParsedEvent[];
  newByteOffset: number;
}

export interface TargetScannerSpec {
  /** Discover session files on disk for this target. */
  discover(): DiscoveredFile[];
  /**
   * Parse a session file. Receives the file path and current byte offset.
   * Returns parsed data and new byte offset, or null if no new data.
   */
  parseFile(
    filePath: string,
    fromByteOffset: number,
  ): ScannerParseResult | null;
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
