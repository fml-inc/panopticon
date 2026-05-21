import type { ClaudeCodeConfig } from "../scanner.js";
import { isClaudeUserConfigPath, readClaudeConfig } from "./claude/config.js";

export type HarnessConfigSnapshot = ClaudeCodeConfig;

/**
 * Read the user-global configuration snapshot for a target harness.
 *
 * Each target owns its config parsing; this module is only the routing layer
 * used by target-agnostic snapshot capture.
 */
export function readTargetConfigSnapshot(
  target?: string,
  cwd?: string,
): HarnessConfigSnapshot {
  if (!target || target === "claude") return readClaudeConfig(cwd);
  return readClaudeConfig(cwd);
}

export function isTargetUserConfigPath(
  filePath: string,
  target?: string,
): boolean {
  if (!target || target === "claude") return isClaudeUserConfigPath(filePath);
  return false;
}
