/**
 * Vendor adapter types — each supported coding tool declares its specifics
 * via this interface so consumers can iterate over the registry instead of
 * hardcoding vendor-specific branches.
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

export interface VendorConfigSpec {
  /** Directory where this vendor stores its config, e.g. ~/.claude */
  dir: string;
  /** Path to the main config file */
  configPath: string;
  /** Format of the config file */
  configFormat: "json" | "toml";
}

// ── Hook Registration ───────────────────────────────────────────────────────

export interface VendorInstallOpts {
  pluginRoot: string;
  port: number;
  proxy?: boolean;
}

export interface VendorHookSpec {
  /** Event names this vendor uses, in the vendor's own convention */
  events: string[];
  /**
   * Apply panopticon hook registration (and related config like MCP servers,
   * telemetry) to this vendor's existing config. Each vendor handles its own
   * deduplication/merge logic. Returns the modified config.
   */
  applyInstallConfig(
    existingConfig: Record<string, unknown>,
    opts: VendorInstallOpts,
  ): Record<string, unknown>;
}

// ── Shell Environment ───────────────────────────────────────────────────────

export interface VendorShellEnvSpec {
  /**
   * Env vars to export as [varName, value] tuples.
   * These are vendor-specific; shared OTEL_* vars are handled separately.
   */
  envVars(port: number, proxy: boolean): Array<[string, string]>;
}

// ── Event Normalization ─────────────────────────────────────────────────────

export interface VendorEventSpec {
  /** Map from vendor's event name to canonical panopticon event name. */
  eventMap: Record<string, CanonicalEvent>;
  /**
   * Transform the raw hook payload before storage.
   * Used e.g. by Gemini to extract user_prompt from llm_request.messages.
   */
  normalizePayload?(data: HookInput): HookInput;
  /**
   * Format a permission response for this vendor's expected shape.
   */
  formatPermissionResponse(decision: {
    allow: boolean;
    reason: string;
  }): Record<string, unknown>;
}

// ── Doctor / Detection ──────────────────────────────────────────────────────

export interface VendorDetectSpec {
  /** Human-readable name for display, e.g. "Claude Code" */
  displayName: string;
  /** Check whether this vendor is installed on the system */
  isInstalled(): boolean;
  /** Check whether panopticon is configured within this vendor */
  isConfigured(): boolean;
}

// ── Proxy (optional — not all vendors use the proxy) ────────────────────────

export interface VendorProxySpec {
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

export interface VendorAdapter {
  /** Machine identifier: "claude", "gemini", "codex", etc. */
  id: string;
  config: VendorConfigSpec;
  hooks: VendorHookSpec;
  shellEnv: VendorShellEnvSpec;
  events: VendorEventSpec;
  detect: VendorDetectSpec;
  /** Proxy spec is optional — not every vendor routes through the proxy */
  proxy?: VendorProxySpec;
}
