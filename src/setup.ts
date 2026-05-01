/**
 * Setup/install utilities for external consumers.
 *
 * Extracted from cli.ts so fml-plugin (and other integrators) can run
 * panopticon setup steps without shelling out to the panopticon CLI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOrCreateAuthToken } from "./auth.js";
import { config, ensureDataDir } from "./config.js";
import { refreshPricing } from "./db/pricing.js";
import { closeDb, getDb } from "./db/schema.js";
import { allTargets } from "./targets/index.js";

const PANOPTICON_BLOCK_START = "# >>> panopticon >>>";
const PANOPTICON_BLOCK_END = "# <<< panopticon <<<";
const LOCAL_BIN_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"';

export interface ShellEnvContext {
  platform?: NodeJS.Platform;
  homeDir?: string;
  shell?: string;
  dataDir?: string;
}

export interface ShellEnvProfileUpdate {
  action: "added" | "updated";
  path: string;
}

export interface ConfigureShellEnvResult {
  envFiles: string[];
  primaryEnvFilePath: string;
  primaryProfilePath: string;
  profileUpdates: ShellEnvProfileUpdate[];
}

export interface RemoveShellEnvResult {
  removedProfilePaths: string[];
}

function runtimePlatform(context: ShellEnvContext = {}): NodeJS.Platform {
  return context.platform ?? process.platform;
}

function runtimeHomeDir(context: ShellEnvContext = {}): string {
  return context.homeDir ?? os.homedir();
}

function runtimeShell(context: ShellEnvContext = {}): string | undefined {
  return context.shell ?? process.env.SHELL;
}

function runtimeDataDir(context: ShellEnvContext = {}): string {
  return context.dataDir ?? process.env.PANOPTICON_DATA_DIR ?? config.dataDir;
}

function selectedTargets(target: string) {
  return target === "all"
    ? allTargets()
    : allTargets().filter((value) => value.id === target);
}

function allManagedEnvVarNames(): string[] {
  const allTargetVarNames = new Set<string>();
  for (const value of allTargets()) {
    for (const [varName] of value.shellEnv.envVars(config.port, true)) {
      allTargetVarNames.add(varName);
    }
  }
  return [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_METRIC_EXPORT_INTERVAL",
    ...allTargetVarNames,
  ];
}

function readTextFileIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function resolveShellRcPath(context: ShellEnvContext = {}): string {
  return path.join(
    runtimeHomeDir(context),
    runtimeShell(context)?.includes("zsh") ? ".zshrc" : ".bashrc",
  );
}

function resolvePowerShellProfiles(context: ShellEnvContext = {}): string[] {
  const homeDir = runtimeHomeDir(context);
  return [
    path.join(homeDir, "Documents", "PowerShell", "Profile.ps1"),
    path.join(homeDir, "Documents", "WindowsPowerShell", "Profile.ps1"),
  ];
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeCmdValue(value: string): string {
  return value.replace(/"/g, '""').replace(/%/g, "%%");
}

function writeManagedFile(
  filePath: string,
  lines: string[],
  options?: { mode?: number; newline?: string },
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join(options?.newline ?? "\n"), {
    mode: options?.mode,
  });
}

function replaceManagedBlock(
  filePath: string,
  blockLines: string[],
): ShellEnvProfileUpdate {
  const content = readTextFileIfExists(filePath);
  const lines = content.split("\n");
  const preservedLines: string[] = [];
  let inBlock = false;
  let insertAt = -1;
  let found = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(PANOPTICON_BLOCK_START)) {
      inBlock = true;
      found = true;
      if (insertAt < 0) insertAt = preservedLines.length;
      continue;
    }
    if (trimmed.startsWith(PANOPTICON_BLOCK_END)) {
      inBlock = false;
      continue;
    }
    if (!inBlock) {
      preservedLines.push(line);
    }
  }

  const insertionIndex = insertAt >= 0 ? insertAt : preservedLines.length;
  preservedLines.splice(insertionIndex, 0, "", ...blockLines, "");
  writeManagedFile(filePath, preservedLines);

  return { path: filePath, action: found ? "updated" : "added" };
}

function removeManagedBlockFromFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  let inBlock = false;
  let changed = false;
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(PANOPTICON_BLOCK_START)) {
      inBlock = true;
      changed = true;
      return false;
    }
    if (trimmed.startsWith(PANOPTICON_BLOCK_END)) {
      inBlock = false;
      return false;
    }
    return !inBlock;
  });

  if (changed) {
    fs.writeFileSync(filePath, filtered.join("\n"));
  }
  return changed;
}

/**
 * Build the canonical list of panopticon env vars (`[name, value]` tuples).
 *
 * Used by both the shell-rc writer and the dedicated env-file writer below.
 * Includes the auth token in OTEL_EXPORTER_OTLP_HEADERS so OTLP-emitting
 * agents can authenticate against the gated /v1/* server.
 *
 * `proxy` controls whether target adapters return their proxy-related vars
 * (e.g. ANTHROPIC_BASE_URL → /proxy/anthropic).
 */
export function buildPanopticonEnvVars(
  proxy: boolean,
): Array<[string, string]> {
  return buildPanopticonEnvVarsForTarget("all", proxy);
}

function buildPanopticonEnvVarsForTarget(
  target: string,
  proxy: boolean,
): Array<[string, string]> {
  const token = getOrCreateAuthToken();
  const vars: Array<[string, string]> = [
    ["OTEL_EXPORTER_OTLP_ENDPOINT", `http://localhost:${config.port}`],
    ["OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"],
    // Per the OTel spec the value is URL-encoded — encode the space
    // between "Bearer" and the token. The hex token needs no encoding.
    ["OTEL_EXPORTER_OTLP_HEADERS", `Authorization=Bearer%20${token}`],
    ["OTEL_METRICS_EXPORTER", "otlp"],
    ["OTEL_LOGS_EXPORTER", "otlp"],
    ["OTEL_LOG_TOOL_DETAILS", "1"],
    ["OTEL_LOG_USER_PROMPTS", "1"],
    ["OTEL_METRIC_EXPORT_INTERVAL", "10000"],
  ];
  for (const t of selectedTargets(target)) {
    for (const [name, value] of t.shellEnv.envVars(config.port, proxy)) {
      vars.push([name, value]);
    }
  }
  return vars;
}

/**
 * Write guaranteed-sourcable env file(s) in the panopticon data dir.
 *
 * Unix gets `env.sh` so non-interactive shells can source panopticon without
 * tripping over `~/.bashrc` early-return guards. Windows gets `env.ps1` and
 * `env.cmd` for PowerShell and manual `cmd.exe` use.
 *
 * The file contains the auth token, so it's written 0600.
 *
 * Returns the primary env file path (`env.sh` on Unix, `env.ps1` on Windows).
 */
export function writePanopticonEnvFiles(
  proxy: boolean,
  context: ShellEnvContext = {},
  target = "all",
): string[] {
  const dataDir = runtimeDataDir(context);
  const vars = buildPanopticonEnvVarsForTarget(target, proxy);
  fs.mkdirSync(dataDir, { recursive: true });
  if (runtimePlatform(context) === "win32") {
    const psPath = path.join(dataDir, "env.ps1");
    const cmdPath = path.join(dataDir, "env.cmd");
    writeManagedFile(
      psPath,
      [
        "# Auto-generated by panopticon — dot-source this for the shell env.",
        "# Equivalent to the panopticon block in your PowerShell profile.",
        ...vars.map(([name, value]) => `$env:${name} = ${psQuote(value)}`),
        "",
      ],
      { mode: 0o600 },
    );
    writeManagedFile(
      cmdPath,
      [
        "@echo off",
        "rem Auto-generated by panopticon — call this for the shell env.",
        ...vars.map(
          ([name, value]) => `set "${name}=${escapeCmdValue(value)}"`,
        ),
        "",
      ],
      { mode: 0o600, newline: "\r\n" },
    );
    return [psPath, cmdPath];
  }

  const shPath = path.join(dataDir, "env.sh");
  writeManagedFile(
    shPath,
    [
      "# Auto-generated by panopticon — source this for the panopticon shell env.",
      "# Equivalent to the `# >>> panopticon` block in your shell rc, but safe",
      "# to source from non-interactive scripts (no early-return guard).",
      ...vars.map(([name, value]) => `export ${name}=${value}`),
      "",
    ],
    { mode: 0o600 },
  );
  return [shPath];
}

export function writePanopticonEnvFile(
  proxy: boolean,
  context: ShellEnvContext = {},
  target = "all",
): string {
  return writePanopticonEnvFiles(proxy, context, target)[0];
}

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
 * Configure shell environment variables so that coding tools send telemetry
 * to panopticon.
 *
 * Unix updates `.zshrc` or `.bashrc`. Windows updates the user's PowerShell
 * profiles under `Documents/PowerShell` and `Documents/WindowsPowerShell`.
 *
 * Returns the primary profile path that was updated.
 */
export function configureShellEnvDetailed(
  opts: ShellEnvOptions = {},
  context: ShellEnvContext = {},
): ConfigureShellEnvResult {
  const force = opts.force ?? false;
  const target = opts.target ?? "claude";
  const proxy = opts.proxy ?? false;
  const authToken = getOrCreateAuthToken();
  const envFiles = writePanopticonEnvFiles(proxy, context, target);

  if (runtimePlatform(context) === "win32") {
    const envFile = envFiles[0];
    const blockLines = [
      PANOPTICON_BLOCK_START,
      `if (Test-Path ${psQuote(envFile)}) {`,
      `  . ${psQuote(envFile)}`,
      "}",
      PANOPTICON_BLOCK_END,
    ];
    const profileUpdates = resolvePowerShellProfiles(context).map((profile) =>
      replaceManagedBlock(profile, blockLines),
    );
    return {
      envFiles,
      primaryEnvFilePath: envFiles[0],
      primaryProfilePath:
        profileUpdates[0]?.path ?? resolvePowerShellProfiles(context)[0],
      profileUpdates,
    };
  }

  const shellRc = resolveShellRcPath(context);
  const rcContent = readTextFileIfExists(shellRc);

  const managedEnvVarNames = allManagedEnvVarNames();
  const panopticonComments = [PANOPTICON_BLOCK_START, PANOPTICON_BLOCK_END];

  const isPanopticonLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (panopticonComments.some((comment) => trimmed.startsWith(comment))) {
      return true;
    }
    if (trimmed === LOCAL_BIN_EXPORT) return true;
    for (const varName of managedEnvVarNames) {
      if (
        trimmed === `export ${varName}` ||
        trimmed.startsWith(`export ${varName}=`)
      ) {
        return true;
      }
    }
    return false;
  };

  // Build the wanted env vars: shared OTEL vars + target-specific vars
  const wantedLines: [string, string][] = [
    [PANOPTICON_BLOCK_START, PANOPTICON_BLOCK_START],
    [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      `export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${config.port}`,
    ],
    [
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
    ],
    [
      "OTEL_EXPORTER_OTLP_HEADERS",
      `export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${authToken}`,
    ],
    ["OTEL_METRICS_EXPORTER", "export OTEL_METRICS_EXPORTER=otlp"],
    ["OTEL_LOGS_EXPORTER", "export OTEL_LOGS_EXPORTER=otlp"],
    ["OTEL_LOG_TOOL_DETAILS", "export OTEL_LOG_TOOL_DETAILS=1"],
    ["OTEL_LOG_USER_PROMPTS", "export OTEL_LOG_USER_PROMPTS=1"],
    ["OTEL_METRIC_EXPORT_INTERVAL", "export OTEL_METRIC_EXPORT_INTERVAL=10000"],
  ];

  // Add target-specific env vars for selected targets
  for (const selectedTarget of selectedTargets(target)) {
    for (const [varName, value] of selectedTarget.shellEnv.envVars(
      config.port,
      proxy,
    )) {
      wantedLines.push([varName, `export ${varName}=${value}`]);
    }
  }

  wantedLines.push([PANOPTICON_BLOCK_END, PANOPTICON_BLOCK_END]);

  if (!rcContent.includes(".local/bin")) {
    wantedLines.splice(1, 0, ["PATH_LOCAL_BIN", LOCAL_BIN_EXPORT]);
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
      if (key === "PATH_LOCAL_BIN") return line.trim() === LOCAL_BIN_EXPORT;
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
  return {
    envFiles,
    primaryEnvFilePath: envFiles[0],
    primaryProfilePath: shellRc,
    profileUpdates: [
      { path: shellRc, action: insertAt >= 0 ? "updated" : "added" },
    ],
  };
}

export function configureShellEnv(
  opts: ShellEnvOptions = {},
  context: ShellEnvContext = {},
): string {
  return configureShellEnvDetailed(opts, context).primaryProfilePath;
}

export function removeShellEnvDetailed(
  context: ShellEnvContext = {},
): RemoveShellEnvResult {
  const profilePaths =
    runtimePlatform(context) === "win32"
      ? resolvePowerShellProfiles(context)
      : [resolveShellRcPath(context)];
  const removedProfilePaths: string[] = [];
  for (const profilePath of profilePaths) {
    if (removeManagedBlockFromFile(profilePath)) {
      removedProfilePaths.push(profilePath);
    }
  }
  return { removedProfilePaths };
}

export function removeShellEnv(context: ShellEnvContext = {}): string[] {
  return removeShellEnvDetailed(context).removedProfilePaths;
}

// Re-export config for convenience (port, paths, etc.)
export { config } from "./config.js";
