/**
 * Setup/install utilities for external consumers.
 *
 * Extracted from cli.ts so fml-plugin (and other integrators) can run
 * panopticon setup steps without shelling out to the panopticon CLI.
 */

import fs from "node:fs";
import os from "node:os";
import { config, ensureDataDir } from "./config.js";
import { refreshPricing } from "./db/pricing.js";
import { closeDb, getDb } from "./db/schema.js";

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
 * Fetch model pricing from OpenRouter and cache locally.
 * Returns the number of models cached, or null if the fetch failed.
 */
export async function fetchPricing(): Promise<number | null> {
  const result = await refreshPricing();
  return result ? Object.keys(result.models).length : null;
}

export interface ShellEnvOptions {
  /** Overwrite user-customized env vars (default false) */
  force?: boolean;
  /** Target CLI: "claude", "gemini", "codex", or "all" (default "claude") */
  target?: string;
  /** Also configure API proxy (default false) */
  proxy?: boolean;
}

/**
 * Configure shell environment variables (.zshrc / .bashrc) so that
 * Claude Code, Gemini CLI, and/or Codex CLI send telemetry to panopticon.
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

  const PANOPTICON_VARS = [
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_METRIC_EXPORT_INTERVAL",
    "ANTHROPIC_BASE_URL",
    "GEMINI_TELEMETRY_ENABLED",
    "GEMINI_TELEMETRY_TARGET",
    "GEMINI_TELEMETRY_USE_COLLECTOR",
    "GEMINI_TELEMETRY_OTLP_ENDPOINT",
    "GEMINI_TELEMETRY_OTLP_PROTOCOL",
    "GEMINI_TELEMETRY_LOG_PROMPTS",
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

  const wantedLines: [string, string][] = [
    ["# >>> panopticon >>>", "# >>> panopticon >>>"],
    ["CLAUDE_CODE_ENABLE_TELEMETRY", "export CLAUDE_CODE_ENABLE_TELEMETRY=1"],
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

  if (proxy && (target === "claude" || target === "all")) {
    wantedLines.push([
      "ANTHROPIC_BASE_URL",
      `export ANTHROPIC_BASE_URL=http://localhost:${config.port}/proxy/anthropic`,
    ]);
  }

  if (target === "gemini" || target === "all") {
    wantedLines.push(
      ["GEMINI_TELEMETRY_ENABLED", "export GEMINI_TELEMETRY_ENABLED=true"],
      ["GEMINI_TELEMETRY_TARGET", "export GEMINI_TELEMETRY_TARGET=local"],
      [
        "GEMINI_TELEMETRY_USE_COLLECTOR",
        "export GEMINI_TELEMETRY_USE_COLLECTOR=true",
      ],
      [
        "GEMINI_TELEMETRY_OTLP_ENDPOINT",
        `export GEMINI_TELEMETRY_OTLP_ENDPOINT=http://localhost:${config.port}`,
      ],
      [
        "GEMINI_TELEMETRY_OTLP_PROTOCOL",
        "export GEMINI_TELEMETRY_OTLP_PROTOCOL=http",
      ],
      [
        "GEMINI_TELEMETRY_LOG_PROMPTS",
        "export GEMINI_TELEMETRY_LOG_PROMPTS=true",
      ],
    );
  }

  wantedLines.push(["# <<< panopticon <<<", "# <<< panopticon <<<"]);

  if (!rcContent.includes(".local/bin")) {
    wantedLines.splice(1, 0, [
      "PATH_LOCAL_BIN",
      'export PATH="$HOME/.local/bin:$PATH"',
    ]);
  }

  const lines = rcContent.split("\n");
  const seen = new Set<string>();
  let lastPanopticonIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (!isPanopticonLine(lines[i])) continue;
    lastPanopticonIdx = i;

    const match = wantedLines.find(([key]) => {
      if (key.startsWith("#")) return lines[i].trim().startsWith(key);
      return (
        lines[i].trim() === `export ${key}` ||
        lines[i].trim().startsWith(`export ${key}=`)
      );
    });
    if (match) {
      if (!force && lines[i].trim() !== match[1] && !match[0].startsWith("#")) {
        // Keep user-customized value
      } else {
        lines[i] = match[1];
      }
      seen.add(match[0]);
    } else {
      lines[i] = "";
    }
  }

  const newLines = wantedLines
    .filter(([key]) => !seen.has(key))
    .map(([, val]) => val);

  if (newLines.length > 0) {
    if (lastPanopticonIdx >= 0) {
      lines.splice(lastPanopticonIdx + 1, 0, ...newLines);
    } else {
      lines.push("", ...newLines, "");
    }
  }

  fs.writeFileSync(shellRc, lines.join("\n"));
  return shellRc;
}

// Re-export config for convenience (port, paths, etc.)
export { config } from "./config.js";

// Need path import for configureShellEnv
import path from "node:path";
