/**
 * Setup/install utilities for external consumers.
 *
 * Extracted from cli.ts so fml-plugin (and other integrators) can run
 * panopticon setup steps without shelling out to the panopticon CLI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ensureDataDir } from "./config.js";
import { refreshPricing } from "./db/pricing.js";
import { closeDb, getDb } from "./db/schema.js";
import { allTargets } from "./targets/index.js";

/**
 * Initialize the panopticon database — creates the data directory,
 * schema, indexes, and runs migrations.
 */
export function initDb(): void {
  ensureDataDir();
  getDb();
  closeDb();
}

/**
 * Fetch model pricing from LiteLLM and cache locally.
 * Returns the number of models cached, or null if the fetch failed.
 */
export async function fetchPricing(): Promise<number | null> {
  const result = await refreshPricing();
  return result ? Object.keys(result.models).length : null;
}

export interface ShellEnvOptions {
  /** Overwrite user-customized env vars (default false) */
  force?: boolean;
  /** Target CLI target id or "all" (default "claude") */
  target?: string;
  /** Also configure API proxy (default false) */
  proxy?: boolean;
}

/**
 * Configure shell environment variables (.zshrc / .bashrc) so that
 * coding tools send telemetry to panopticon.
 *
 * Returns the path to the shell rc file that was updated.
 */
export function configureShellEnv(opts: ShellEnvOptions = {}): string {
  const force = opts.force ?? false;
  const target = opts.target ?? "claude";
  const proxy = opts.proxy ?? false;

  const shellRc = path.join(
    os.homedir(),
    process.env.SHELL?.includes("zsh") ? ".zshrc" : ".bashrc",
  );
  const rcContent = fs.existsSync(shellRc)
    ? fs.readFileSync(shellRc, "utf-8")
    : "";

  // Collect all known target env var names for detection/cleanup
  const allTargetVarNames = new Set<string>();
  for (const v of allTargets()) {
    for (const [varName] of v.shellEnv.envVars(config.port, true)) {
      allTargetVarNames.add(varName);
    }
  }

  const PANOPTICON_VARS = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_METRIC_EXPORT_INTERVAL",
    ...allTargetVarNames,
  ];
  const PANOPTICON_COMMENTS = ["# >>> panopticon", "# <<< panopticon"];

  const isPanopticonLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (PANOPTICON_COMMENTS.some((c) => trimmed.startsWith(c))) return true;
    for (const v of PANOPTICON_VARS) {
      if (trimmed === `export ${v}` || trimmed.startsWith(`export ${v}=`))
        return true;
    }
    return false;
  };

  // Build the wanted env vars: shared OTEL vars + target-specific vars
  const wantedLines: [string, string][] = [
    ["# >>> panopticon >>>", "# >>> panopticon >>>"],
    [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      `export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${config.port}`,
    ],
    [
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
    ],
    ["OTEL_METRICS_EXPORTER", "export OTEL_METRICS_EXPORTER=otlp"],
    ["OTEL_LOGS_EXPORTER", "export OTEL_LOGS_EXPORTER=otlp"],
    ["OTEL_LOG_TOOL_DETAILS", "export OTEL_LOG_TOOL_DETAILS=1"],
    ["OTEL_LOG_USER_PROMPTS", "export OTEL_LOG_USER_PROMPTS=1"],
    ["OTEL_METRIC_EXPORT_INTERVAL", "export OTEL_METRIC_EXPORT_INTERVAL=10000"],
  ];

  // Add target-specific env vars for selected targets
  const selectedTargetList =
    target === "all"
      ? allTargets()
      : allTargets().filter((v) => v.id === target);

  for (const t of selectedTargetList) {
    for (const [varName, value] of t.shellEnv.envVars(config.port, proxy)) {
      wantedLines.push([varName, `export ${varName}=${value}`]);
    }
  }

  wantedLines.push(["# <<< panopticon <<<", "# <<< panopticon <<<"]);

  if (!rcContent.includes(".local/bin")) {
    wantedLines.splice(1, 0, [
      "PATH_LOCAL_BIN",
      'export PATH="$HOME/.local/bin:$PATH"',
    ]);
  }

  const lines = rcContent.split("\n");
  const preservedLines: string[] = [];
  const existingByKey = new Map<string, string>();
  let insertAt = -1;

  for (const line of lines) {
    if (!isPanopticonLine(line)) {
      preservedLines.push(line);
      continue;
    }

    if (insertAt < 0) {
      insertAt = preservedLines.length;
    }

    const match = wantedLines.find(([key]) => {
      if (key.startsWith("#")) return line.trim().startsWith(key);
      return (
        line.trim() === `export ${key}` ||
        line.trim().startsWith(`export ${key}=`)
      );
    });
    if (match) {
      existingByKey.set(match[0], line.trim());
    }
  }

  const resolvedBlock = wantedLines.map(([key, value]) => {
    if (force || key.startsWith("#")) return value;
    return existingByKey.get(key) ?? value;
  });

  const insertionIndex = insertAt >= 0 ? insertAt : preservedLines.length;
  const blockLines = ["", ...resolvedBlock, ""];
  preservedLines.splice(insertionIndex, 0, ...blockLines);

  fs.writeFileSync(shellRc, preservedLines.join("\n"));
  return shellRc;
}

// Re-export config for convenience (port, paths, etc.)
export { config } from "./config.js";
