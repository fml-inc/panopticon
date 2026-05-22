import { isClaudeUserConfigPath, readClaudeConfig } from "./claude/config.js";
import type { HarnessConfigSnapshot } from "./config-types.js";
import { isPiUserConfigPath, readPiConfig } from "./pi/config.js";

export const SUPPORTED_CONFIG_SNAPSHOT_TARGETS = ["claude", "pi"] as const;
export type ConfigSnapshotTarget =
  (typeof SUPPORTED_CONFIG_SNAPSHOT_TARGETS)[number];

export const DEFAULT_CONFIG_SNAPSHOT_TARGET: ConfigSnapshotTarget = "claude";

export function toConfigSnapshotTarget(
  target?: string,
): ConfigSnapshotTarget | null {
  const normalized = target ?? DEFAULT_CONFIG_SNAPSHOT_TARGET;
  return (SUPPORTED_CONFIG_SNAPSHOT_TARGETS as readonly string[]).includes(
    normalized,
  )
    ? (normalized as ConfigSnapshotTarget)
    : null;
}

/**
 * Read the user-global configuration snapshot for a target harness.
 *
 * Each target owns its config parsing; this module is only the routing layer
 * used by target-agnostic snapshot capture.
 */
export function isSupportedConfigSnapshotTarget(
  target?: string,
): target is ConfigSnapshotTarget | undefined {
  return toConfigSnapshotTarget(target) !== null;
}

export function readTargetConfigSnapshot(
  target: ConfigSnapshotTarget,
  cwd?: string,
): HarnessConfigSnapshot {
  switch (target) {
    case "claude":
      return readClaudeConfig(cwd);
    case "pi":
      return readPiConfig();
  }
}

export function isTargetUserConfigPath(
  filePath: string,
  target: ConfigSnapshotTarget,
): boolean {
  switch (target) {
    case "claude":
      return isClaudeUserConfigPath(filePath);
    case "pi":
      return isPiUserConfigPath(filePath);
  }
}
