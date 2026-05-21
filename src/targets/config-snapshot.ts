import type { ClaudeCodeConfig } from "../scanner.js";
import { readClaudeConfig } from "./claude/config.js";
import { isPiUserConfigPath, readPiConfig } from "./pi/config.js";

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
  if (target === "pi") return readPiConfig();
  return readClaudeConfig(cwd);
}

export function isTargetUserConfigPath(
  filePath: string,
  target?: string,
): boolean {
  if (target === "pi") return isPiUserConfigPath(filePath);
  return false;
}
