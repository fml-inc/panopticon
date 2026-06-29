/**
 * Doctor — diagnostic checks for panopticon health.
 *
 * Exported for use by fml-plugin and other integrators.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import {
  codeIntelHealth,
  contextActivityHealth,
  contextFlagsHealth,
  formatCodeIntelStatus,
  formatContextActivity,
  formatContextFlags,
  formatHookTargets,
  getCodeIntelStatus,
  getContextFlagStatuses,
  getHookTargetStatuses,
  hookTargetsHealth,
  readContextActivity,
} from "./context-diagnostics.js";
import { dbStats } from "./db/query.js";
import { closeDb, getDb } from "./db/schema.js";
import { logPaths } from "./log.js";
import {
  formatServerStatus,
  healthCheckHost,
  readPidFileStatus,
  readServerStartBackoffStatus,
  readServerStatus,
} from "./server-control.js";
import { readWindowsStartupTaskStatus } from "./startup-task.js";
import { readSyncPending } from "./sync/pending.js";
import { allTargets } from "./targets/index.js";
import { loadUnifiedConfig, type UnifiedConfig } from "./unified-config.js";

export interface CheckResult {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface RecentEvent {
  eventType: string;
  toolName: string | null;
  timestamp: string;
}

export interface RecentError {
  id: number;
  body: string;
}

export interface DoctorResult {
  checks: CheckResult[];
  system: {
    os: string;
    node: string;
    sandbox: boolean;
  };
  recentEvents: RecentEvent[];
  recentErrors: RecentError[];
}

const REQUIRED_SHARED_SHELL_ENV_VARS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "PANOPTICON_HOST",
  "PANOPTICON_PORT",
];

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function readTextIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function hasAllSharedShellEnv(content: string): boolean {
  return REQUIRED_SHARED_SHELL_ENV_VARS.every((name) => content.includes(name));
}

function hasAnySharedShellEnv(content: string): boolean {
  return REQUIRED_SHARED_SHELL_ENV_VARS.some((name) => content.includes(name));
}

export function shellEnvCheck(
  shellRc = path.join(
    os.homedir(),
    process.env.SHELL?.includes("zsh") ? ".zshrc" : ".bashrc",
  ),
  envFile = path.join(config.dataDir, "env.sh"),
): CheckResult {
  const rcContent = readTextIfExists(shellRc);
  const envContent = readTextIfExists(envFile);
  if (hasAllSharedShellEnv(rcContent)) {
    return {
      label: "Shell Env",
      status: "ok",
      detail: `Panopticon env configured in ${path.basename(shellRc)}`,
    };
  }
  if (hasAllSharedShellEnv(envContent)) {
    return {
      label: "Shell Env",
      status: "ok",
      detail: `Panopticon env available in ${path.basename(envFile)}`,
    };
  }
  if (hasAnySharedShellEnv(rcContent) || hasAnySharedShellEnv(envContent)) {
    return {
      label: "Shell Env",
      status: "warn",
      detail: `Partial config in ${path.basename(shellRc)} — re-run install`,
    };
  }
  return {
    label: "Shell Env",
    status: "warn",
    detail: "Not configured. Run install to set up telemetry.",
  };
}

export function readSyncTargetLabel(targetName: string): string {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS confirmed,
              SUM(CASE
                    WHEN COALESCE(s.sync_seq, 0) > COALESCE(target_session_sync.synced_seq, 0)
                      OR COALESCE(s.derived_sync_seq, 0) > COALESCE(target_session_sync.derived_synced_seq, 0)
                    THEN 1 ELSE 0
                  END) AS pending,
              MAX(COALESCE(target_session_sync.synced_seq, 0)) AS max_synced_seq
       FROM target_session_sync
       LEFT JOIN sessions s ON s.session_id = target_session_sync.session_id
       WHERE target_session_sync.target = ? AND target_session_sync.confirmed = 1`,
    )
    .get(targetName) as
    | {
        confirmed: number;
        pending: number | null;
        max_synced_seq: number | null;
      }
    | undefined;

  const confirmed = row?.confirmed ?? 0;
  const pendingSessions = row?.pending ?? 0;
  const pendingState = readSyncPending(targetName);
  const rejectedSessions = pendingState.rejectedSessions;
  const pendingRows = Object.entries(pendingState.tables).reduce(
    (sum, [table, value]) =>
      table === "sessions" || table === "session_derived_state"
        ? sum
        : sum + value.pending,
    0,
  );
  if (confirmed === 0) {
    const parts: string[] = [];
    if (pendingRows > 0)
      parts.push(`${formatCount(pendingRows, "row")} pending`);
    if (rejectedSessions > 0) {
      parts.push(`${formatCount(rejectedSessions, "session")} rejected`);
    }
    return parts.length > 0
      ? `not synced yet, ${parts.join(", ")}`
      : "not synced yet";
  }

  const pendingParts: string[] = [];
  if (pendingSessions > 0) {
    pendingParts.push(formatCount(pendingSessions, "session"));
  }
  if (pendingRows > 0) {
    pendingParts.push(formatCount(pendingRows, "row"));
  }
  if (pendingParts.length > 0) {
    return [
      `${formatCount(confirmed, "session")} confirmed`,
      `${pendingParts.join(" and ")} pending`,
      rejectedSessions > 0
        ? `${formatCount(rejectedSessions, "session")} rejected`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");
  }

  const maxSyncedSeq = row?.max_synced_seq ?? 0;
  const syncedLabel =
    maxSyncedSeq > 0
      ? `${formatCount(confirmed, "session")} synced to #${maxSyncedSeq}`
      : `${formatCount(confirmed, "session")} synced`;
  return rejectedSessions > 0
    ? `${syncedLabel}, ${formatCount(rejectedSessions, "session")} rejected`
    : syncedLabel;
}

/**
 * Build the "Sync" health check from config.
 *
 * Disabled sync is explicit, configured targets report their sync labels, and
 * the enabled/default state with no targets warns because no data can sync.
 */
export function syncStatusCheck(
  cfg: UnifiedConfig,
  readTargetLabel: (targetName: string) => string = readSyncTargetLabel,
): CheckResult {
  const targets = cfg.sync.targets;
  if (cfg.sync.enabled === false) {
    return {
      label: "Sync",
      status: "ok",
      detail:
        targets.length === 0
          ? "Disabled"
          : `Disabled (${formatCount(targets.length, "target")} configured)`,
    };
  }

  if (targets.length === 0) {
    return {
      label: "Sync",
      status: "warn",
      detail:
        "Enabled but no targets configured; nothing will sync. Add one with `panopticon sync add <name> <url>`.",
    };
  }

  const targetDetails = targets.map(
    (target) =>
      `${target.name} → ${target.url} (${readTargetLabel(target.name)})`,
  );
  return {
    label: "Sync",
    status: "ok",
    detail: `${targets.length} target${targets.length > 1 ? "s" : ""}: ${targetDetails.join("; ")}`,
  };
}

/**
 * Run panopticon diagnostic checks.
 *
 * Returns structured results — callers handle display.
 */
export async function doctor(): Promise<DoctorResult> {
  const checks: CheckResult[] = [];

  const isSandbox =
    process.env.SANDBOX !== undefined ||
    fs.existsSync(path.join(os.homedir(), ".sandbox-home"));

  // 1. Database
  if (!fs.existsSync(config.dbPath)) {
    checks.push({
      label: "Database",
      status: "fail",
      detail: `Not found at ${config.dbPath}. Run install to initialize.`,
    });
  } else {
    try {
      const stats = dbStats();
      const total = stats.hook_events + stats.otel_logs + stats.otel_metrics;
      checks.push({
        label: "Database",
        status: "ok",
        detail: `${total} rows (${stats.hook_events} hooks, ${stats.otel_logs} logs, ${stats.otel_metrics} metrics)`,
      });
      closeDb();
    } catch (err) {
      checks.push({
        label: "Database",
        status: "fail",
        detail: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 2. Server lifecycle
  const serverHost = healthCheckHost();
  const serverStatus = await readServerStatus({
    host: serverHost,
    port: config.port,
  });
  if (serverStatus.health.ok) {
    checks.push({
      label: "Server",
      status: "ok",
      detail: `${formatServerStatus(serverStatus)} on ${serverHost}:${config.port}`,
    });
  } else {
    checks.push({
      label: "Server",
      status: "warn",
      detail: `${formatServerStatus(serverStatus)} on ${serverHost}:${config.port}`,
    });
  }

  const startBackoff = readServerStartBackoffStatus();
  if (startBackoff.exists) {
    const retry =
      startBackoff.nextAllowedAtMs != null
        ? new Date(startBackoff.nextAllowedAtMs).toISOString()
        : "unknown";
    checks.push({
      label: "Start Backoff",
      status: startBackoff.active ? "warn" : "ok",
      detail: `${startBackoff.active ? "active" : "inactive"}; ${formatCount(startBackoff.attempts, "failed attempt")}; retry ${retry}${startBackoff.lastError ? `; last error: ${startBackoff.lastError}` : ""}`,
    });
  } else {
    checks.push({
      label: "Start Backoff",
      status: "ok",
      detail: "inactive",
    });
  }

  const pidFile = readPidFileStatus();
  checks.push({
    label: "PID File",
    status:
      !pidFile.exists ||
      (pidFile.valid && (pidFile.running || serverStatus.health.ok))
        ? "ok"
        : "warn",
    detail: pidFile.exists
      ? pidFile.valid
        ? `${pidFile.pid}${pidFile.running ? " running" : " stale"} at ${config.serverPidFile}`
        : `invalid at ${config.serverPidFile}`
      : `not present at ${config.serverPidFile}`,
  });

  try {
    const stat = fs.statSync(logPaths.server);
    checks.push({
      label: "Server Log",
      status: "ok",
      detail: `${logPaths.server} (${stat.size} bytes)`,
    });
  } catch {
    checks.push({
      label: "Server Log",
      status: "warn",
      detail: `Not created yet at ${logPaths.server}`,
    });
  }

  if (process.platform === "win32") {
    const startupTask = readWindowsStartupTaskStatus();
    checks.push({
      label: "Startup Task",
      status: startupTask.installed ? "ok" : "ok",
      detail: startupTask.installed
        ? `${startupTask.taskName}: ${startupTask.detail}`
        : "not installed (optional)",
    });
  }

  // 3. Shell environment
  const shellRc = path.join(
    os.homedir(),
    process.env.SHELL?.includes("zsh") ? ".zshrc" : ".bashrc",
  );
  checks.push(shellEnvCheck(shellRc));

  // 4. Coding tool integration
  const tools: Array<{ name: string; dir: string; configured: boolean }> = [];

  for (const t of allTargets()) {
    if (t.detect.isInstalled()) {
      tools.push({
        name: t.detect.displayName,
        dir: t.config.dir,
        configured: t.detect.isConfigured(),
      });
    }
  }

  if (tools.length === 0) {
    checks.push({
      label: "Tools",
      status: "warn",
      detail: "No supported coding tools found",
    });
  } else {
    const configured = tools.filter((t) => t.configured);
    const unconfigured = tools.filter((t) => !t.configured);
    if (unconfigured.length === 0) {
      checks.push({
        label: "Tools",
        status: "ok",
        detail: configured.map((t) => t.name).join(", "),
      });
    } else {
      const detail = tools
        .map((t) => `${t.name} ${t.configured ? "✓" : "(not configured)"}`)
        .join(", ");
      checks.push({
        label: "Tools",
        status: "warn",
        detail: `${detail} — re-run install`,
      });
    }
  }

  // 5. Recent data
  if (fs.existsSync(config.dbPath)) {
    try {
      const db = getDb();
      const latest = db
        .prepare("SELECT MAX(timestamp_ms) as ts FROM hook_events")
        .get() as { ts: number | null } | undefined;
      closeDb();

      if (latest?.ts) {
        const ago = Date.now() - latest.ts;
        const minutes = Math.floor(ago / 60000);
        if (minutes < 60) {
          checks.push({
            label: "Data Flow",
            status: "ok",
            detail: `Last event ${minutes}m ago`,
          });
        } else if (minutes < 1440) {
          checks.push({
            label: "Data Flow",
            status: "ok",
            detail: `Last event ${Math.floor(minutes / 60)}h ago`,
          });
        } else {
          checks.push({
            label: "Data Flow",
            status: "warn",
            detail: `Last event ${Math.floor(minutes / 1440)}d ago`,
          });
        }
      } else {
        checks.push({
          label: "Data Flow",
          status: "warn",
          detail: "No events recorded yet",
        });
      }
    } catch {
      // Already reported DB error above
    }
  }

  // 6. Sync targets
  try {
    checks.push(syncStatusCheck(loadUnifiedConfig()));
  } catch {
    checks.push({
      label: "Sync",
      status: "warn",
      detail: "Could not read sync config",
    });
  }

  // 7. Context intelligence
  const contextFlags = getContextFlagStatuses();
  checks.push({
    label: "Context Flags",
    status: contextFlagsHealth(contextFlags),
    detail: formatContextFlags(contextFlags),
  });

  const hookTargets = getHookTargetStatuses();
  checks.push({
    label: "Hook Targets",
    status: hookTargetsHealth(hookTargets),
    detail: formatHookTargets(hookTargets),
  });

  const contextActivity = readContextActivity();
  checks.push({
    label: "Context Activity",
    status: contextActivityHealth(contextActivity),
    detail: formatContextActivity(contextActivity),
  });

  const codeIntelStatus = getCodeIntelStatus();
  checks.push({
    label: "Code Intel",
    status: codeIntelHealth(codeIntelStatus),
    detail: formatCodeIntelStatus(codeIntelStatus),
  });

  // 8. Sentry
  try {
    const cfg = loadUnifiedConfig();
    const dsn = process.env.PANOPTICON_SENTRY_DSN ?? cfg.sentryDsn;
    checks.push({
      label: "Sentry",
      status: dsn ? "ok" : "ok",
      detail: dsn ? "Configured" : "Not configured (optional)",
    });
  } catch {
    // Non-critical
  }

  // 9. Recent events and errors (informational, not checks)
  let recentEvents: RecentEvent[] = [];
  let recentErrors: RecentError[] = [];

  if (fs.existsSync(config.dbPath)) {
    try {
      const db = getDb();

      const events = db
        .prepare(
          "SELECT event_type, tool_name, timestamp_ms FROM hook_events ORDER BY id DESC LIMIT 3",
        )
        .all() as {
        event_type: string;
        tool_name: string | null;
        timestamp_ms: number;
      }[];

      recentEvents = events.map((e) => ({
        eventType: e.event_type,
        toolName: e.tool_name,
        timestamp: new Date(e.timestamp_ms).toISOString(),
      }));

      const errors = db
        .prepare(
          "SELECT id, body FROM otel_logs WHERE severity_text = 'ERROR' ORDER BY id DESC LIMIT 3",
        )
        .all() as { id: number; body: string | null }[];

      recentErrors = errors.map((e) => ({
        id: e.id,
        body: (e.body ?? "").slice(0, 200),
      }));

      closeDb();
    } catch {
      // DB errors already reported above
    }
  }

  return {
    checks,
    system: {
      os: `${os.platform()} (${os.release()} ${os.arch()})`,
      node: process.version,
      sandbox: isSandbox,
    },
    recentEvents,
    recentErrors,
  };
}
