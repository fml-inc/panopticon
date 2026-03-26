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
}
