import fs from "node:fs";
import path from "node:path";
import { createCodeReviewGraphProvider } from "./code_intelligence/index.js";
import type { CodeIntelStatus } from "./code_intelligence/types.js";
import { config } from "./config.js";
import { closeDb, getDb } from "./db/schema.js";
import { resolveGitRoot } from "./paths.js";
import { allTargets } from "./targets/index.js";

export interface ContextFlagStatus {
  label: string;
  env: string;
  enabled: boolean;
  required: boolean;
}

export interface HookTargetStatus {
  id: string;
  name: string;
  installed: boolean;
  configured: boolean;
  source: "explicit" | "native" | "unknown" | "not-configured";
}

export interface ContextActivity {
  sinceMs: number;
  windowHours: number;
  sessionStart: number;
  userPromptSubmit: number;
  preToolUseRead: number;
  preToolUseEdit: number;
}

export function getContextFlagStatuses(): ContextFlagStatus[] {
  return [
    {
      label: "SessionStart",
      env: "PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION",
      enabled: config.enableSessionStartHistoryInjection,
      required: true,
    },
    {
      label: "UserPromptSubmit",
      env: "PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION",
      enabled: config.enableUserPromptSubmitContextInjection,
      required: true,
    },
    {
      label: "PreToolUse edit",
      env: "PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION",
      enabled: config.enablePreToolUseFileContextInjection,
      required: true,
    },
    {
      label: "PreToolUse read",
      env: "PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION",
      enabled: config.enablePreToolUseReadContextInjection,
      required: true,
    },
    {
      label: "CRG file_overview",
      env: "PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW",
      enabled: config.enableCodeIntelFileOverview,
      required: false,
    },
  ];
}

export function formatContextFlags(flags = getContextFlagStatuses()): string {
  return flags
    .map((flag) => `${flag.label}=${flag.enabled ? "on" : "off"}`)
    .join(", ");
}

export function contextFlagsHealth(
  flags = getContextFlagStatuses(),
): "ok" | "warn" {
  return flags.some((flag) => flag.required && !flag.enabled) ? "warn" : "ok";
}

export function getHookTargetStatuses(): HookTargetStatus[] {
  return allTargets()
    .filter((target) => target.hooks.events.length > 0)
    .map((target) => {
      const installed = target.detect.isInstalled();
      const configured = installed && target.detect.isConfigured();
      return {
        id: target.id,
        name: target.detect.displayName,
        installed,
        configured,
        source: configured
          ? detectHookSourceMode(
              target.id,
              target.config.dir,
              target.config.configPath,
            )
          : "not-configured",
      };
    })
    .filter((target) => target.installed || target.configured);
}

export function formatHookTargets(targets = getHookTargetStatuses()): string {
  if (targets.length === 0) return "No supported coding tools found";
  return targets
    .map((target) => {
      if (!target.configured) return `${target.name}=not configured`;
      const source =
        target.source === "explicit"
          ? "source=explicit"
          : target.source === "native"
            ? "source=native"
            : "source=unknown";
      return `${target.name}=${source}`;
    })
    .join(", ");
}

export function hookTargetsHealth(
  targets = getHookTargetStatuses(),
): "ok" | "warn" {
  return targets.length > 0 &&
    targets.every((target) => target.configured && target.source !== "unknown")
    ? "ok"
    : "warn";
}

export function readContextActivity(
  windowHours = 24,
  nowMs = Date.now(),
): ContextActivity | null {
  if (!fs.existsSync(config.dbPath)) return null;
  const sinceMs = nowMs - windowHours * 60 * 60 * 1000;
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN event_type = 'SessionStart' THEN 1 ELSE 0 END) AS sessionStart,
           SUM(CASE WHEN event_type = 'UserPromptSubmit' THEN 1 ELSE 0 END) AS userPromptSubmit,
           SUM(CASE WHEN event_type = 'PreToolUse' AND tool_name = 'Read' THEN 1 ELSE 0 END) AS preToolUseRead,
           SUM(CASE WHEN event_type = 'PreToolUse' AND tool_name IN ('Write', 'Edit', 'MultiEdit', 'NotebookEdit') THEN 1 ELSE 0 END) AS preToolUseEdit
         FROM hook_events
         WHERE timestamp_ms >= ?`,
      )
      .get(sinceMs) as
      | {
          sessionStart: number | null;
          userPromptSubmit: number | null;
          preToolUseRead: number | null;
          preToolUseEdit: number | null;
        }
      | undefined;
    return {
      sinceMs,
      windowHours,
      sessionStart: row?.sessionStart ?? 0,
      userPromptSubmit: row?.userPromptSubmit ?? 0,
      preToolUseRead: row?.preToolUseRead ?? 0,
      preToolUseEdit: row?.preToolUseEdit ?? 0,
    };
  } catch {
    return null;
  } finally {
    closeDb();
  }
}

export function formatContextActivity(
  activity: ContextActivity | null,
): string {
  if (!activity) return "unavailable";
  return (
    `last ${activity.windowHours}h: ` +
    `SessionStart=${activity.sessionStart}, ` +
    `UserPromptSubmit=${activity.userPromptSubmit}, ` +
    `PreToolUse Read=${activity.preToolUseRead}, ` +
    `PreToolUse edit=${activity.preToolUseEdit}`
  );
}

export function contextActivityHealth(
  activity: ContextActivity | null,
): "ok" | "warn" {
  if (!activity) return "warn";
  return activity.sessionStart +
    activity.userPromptSubmit +
    activity.preToolUseRead +
    activity.preToolUseEdit >
    0
    ? "ok"
    : "warn";
}

export function getCodeIntelStatus(cwd = process.cwd()): CodeIntelStatus {
  if (!config.enableCodeIntelFileOverview) {
    return {
      provider: "code-review-graph",
      status: "unavailable",
      repo_root: resolveGitRoot(cwd) ?? cwd,
      graph_db: null,
      message: "CRG file_overview enrichment is disabled.",
    };
  }
  const repoRoot = resolveGitRoot(cwd) ?? cwd;
  return createCodeReviewGraphProvider().status(repoRoot);
}

export function formatCodeIntelStatus(status: CodeIntelStatus): string {
  if (status.status === "ready") {
    const counts =
      status.node_count != null && status.edge_count != null
        ? ` (${status.node_count} nodes, ${status.edge_count} edges)`
        : "";
    return `ready for ${status.repo_root}${counts}`;
  }
  return `${status.status}: ${status.message ?? "not available"}`;
}

export function codeIntelHealth(status: CodeIntelStatus): "ok" | "warn" {
  if (!config.enableCodeIntelFileOverview) return "ok";
  return status.status === "ready" ? "ok" : "warn";
}

function detectHookSourceMode(
  targetId: string,
  configDir: string,
  configPath: string,
): HookTargetStatus["source"] {
  if (["claude", "openclaw", "pi"].includes(targetId)) return "native";
  const escapedTargetId = targetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hookHandlerPattern = new RegExp(
    `hook-handler(?:\\.cmd)?(?:\\\\?")?\\s+${escapedTargetId}\\b`,
  );
  const candidatePaths = [
    configPath,
    path.join(configDir, "hooks.json"),
    path.join(configDir, "settings.json"),
  ];
  try {
    const content = candidatePaths
      .filter((candidate, index) => candidatePaths.indexOf(candidate) === index)
      .map((candidate) => {
        try {
          return fs.readFileSync(candidate, "utf-8");
        } catch {
          return "";
        }
      })
      .join("\n");
    return hookHandlerPattern.test(content) ? "explicit" : "unknown";
  } catch {
    return "unknown";
  }
}
