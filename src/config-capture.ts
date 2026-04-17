import os from "node:os";
import { insertUserConfigSnapshot } from "./db/store.js";
import { readConfig } from "./scanner.js";

/**
 * Capture the current user-global config (settings, permissions allowlist,
 * approvals, memory files, etc.) into `user_config_snapshots`. Deduplicated
 * by content hash — no-op when nothing changed since the last snapshot for
 * this device.
 *
 * Callers:
 *   - hooks/ingest.ts on SessionStart (baseline)
 *   - hooks/ingest.ts on PostToolUse when a tracked path was written
 *   - mcp/permissions.ts after permissions_apply writes allowed/approvals
 *
 * Returns true when a new row was inserted, false when dedup'd or on error.
 */
export function captureUserConfigSnapshot(cwd?: string): boolean {
  try {
    const config = readConfig(cwd);
    return insertUserConfigSnapshot({
      deviceName: os.hostname(),
      permissions: config.user.permissions,
      enabledPlugins: config.enabledPlugins,
      hooks: config.user.hooks,
      commands: config.user.commands,
      rules: config.user.rules,
      skills: config.user.skills,
      pluginHooks: config.pluginHooks,
      panopticonAllowed: config.panopticonPermissions.allowed,
      panopticonApprovals: config.panopticonPermissions.approvals,
      memoryFiles: config.memoryFiles,
    });
  } catch {
    // Non-fatal: capture failures must not break hook processing
    return false;
  }
}

/**
 * True when the given file path corresponds to user-global config that
 * should trigger a re-capture on write. Matches:
 *   - memory files:       `~/.claude/projects/<slug>/memory/**\/*.md`
 *   - panopticon perms:   `<dataDir>/panopticon/permissions/{allowed,approvals}.json`
 *
 * Matching is suffix-based so it works across platforms (macOS `Library/
 * Application Support/panopticon`, Linux `.local/share/panopticon`, Windows
 * `AppData/Roaming/panopticon`).
 */
export function isTrackedUserConfigPath(filePath: string): boolean {
  // Normalize backslashes on Windows paths
  const p = filePath.replace(/\\/g, "/");
  if (/\/\.claude\/projects\/[^/]+\/memory\//.test(p) && p.endsWith(".md")) {
    return true;
  }
  if (
    p.endsWith("/panopticon/permissions/allowed.json") ||
    p.endsWith("/panopticon/permissions/approvals.json")
  ) {
    return true;
  }
  return false;
}

/**
 * Extract the target file path from a tool call's `tool_input`, if any.
 * Returns null for tools that don't write files or have no detectable path.
 *
 * Handles the main write-tool shapes across Claude Code:
 *   - Edit / Write / MultiEdit: `file_path`
 *   - NotebookEdit: `notebook_path`
 */
export function extractWrittenFilePath(
  toolInput: Record<string, unknown> | undefined,
): string | null {
  if (!toolInput) return null;
  const fp = toolInput.file_path;
  if (typeof fp === "string" && fp.length > 0) return fp;
  const np = toolInput.notebook_path;
  if (typeof np === "string" && np.length > 0) return np;
  return null;
}
