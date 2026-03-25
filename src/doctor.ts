/**
 * Doctor — diagnostic checks for panopticon health.
 *
 * Exported for use by fml-plugin and other integrators.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { config } from "./config.js";
import { dbStats } from "./db/query.js";
import { closeDb, getDb } from "./db/schema.js";
import {
  closeWatermarkDb,
  readWatermark,
  watermarkKey,
} from "./sync/watermark.js";
import { loadUnifiedConfig } from "./unified-config.js";
import { allVendors } from "./vendors/index.js";

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

function checkHealth(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: host, port, path: "/health", method: "GET", timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
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

  // 2. Server
  const serverUp = await checkHealth(config.port, "127.0.0.1");
  if (serverUp) {
    checks.push({
      label: "Server",
      status: "ok",
      detail: `Listening on 127.0.0.1:${config.port}`,
    });
  } else {
    checks.push({
      label: "Server",
      status: "warn",
      detail: `Not responding on port ${config.port}`,
    });
  }

  // 3. Shell environment
  const shellRc = path.join(
    os.homedir(),
    process.env.SHELL?.includes("zsh") ? ".zshrc" : ".bashrc",
  );
  const rcContent = fs.existsSync(shellRc)
    ? fs.readFileSync(shellRc, "utf-8")
    : "";

  const hasTelemetry = rcContent.includes("CLAUDE_CODE_ENABLE_TELEMETRY");
  const hasEndpoint = rcContent.includes("OTEL_EXPORTER_OTLP_ENDPOINT");

  if (hasTelemetry && hasEndpoint) {
    checks.push({
      label: "Shell Env",
      status: "ok",
      detail: `Telemetry configured in ${path.basename(shellRc)}`,
    });
  } else if (hasTelemetry || hasEndpoint) {
    checks.push({
      label: "Shell Env",
      status: "warn",
      detail: `Partial config in ${path.basename(shellRc)} — re-run install`,
    });
  } else {
    checks.push({
      label: "Shell Env",
      status: "warn",
      detail: `Not configured. Run install to set up telemetry.`,
    });
  }

  // 4. Coding tool integration
  const tools: Array<{ name: string; dir: string; configured: boolean }> = [];

  for (const vendor of allVendors()) {
    if (vendor.detect.isInstalled()) {
      tools.push({
        name: vendor.detect.displayName,
        dir: vendor.config.dir,
        configured: vendor.detect.isConfigured(),
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
    const cfg = loadUnifiedConfig();
    const targets = cfg.sync.targets;
    if (targets.length === 0) {
      checks.push({
        label: "Sync",
        status: "ok",
        detail: "No targets configured",
      });
    } else {
      const tables = ["hook_events", "otel_logs", "otel_metrics"];
      const targetDetails: string[] = [];
      for (const t of targets) {
        const watermarks = tables.map((table) =>
          readWatermark(watermarkKey(table, t.name)),
        );
        const minWm = Math.min(...watermarks);
        const wmLabel = minWm > 0 ? `synced to #${minWm}` : "not synced yet";
        targetDetails.push(`${t.name} → ${t.url} (${wmLabel})`);
      }
      closeWatermarkDb();

      checks.push({
        label: "Sync",
        status: "ok",
        detail: `${targets.length} target${targets.length > 1 ? "s" : ""}: ${targetDetails.join("; ")}`,
      });
    }
  } catch {
    checks.push({
      label: "Sync",
      status: "warn",
      detail: "Could not read sync config",
    });
  }

  // 7. Recent events and errors (informational, not checks)
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

import path from "node:path";
