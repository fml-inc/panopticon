#!/usr/bin/env node

declare const __PANOPTICON_VERSION__: string;

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command, type OptionValues } from "commander";

type Opts = OptionValues;

import { getOrCreateAuthToken } from "./auth.js";
import { config, ensureDataDir } from "./config.js";
import {
  formatCodeIntelStatus,
  formatContextActivity,
  formatContextFlags,
  formatHookTargets,
  getCodeIntelStatus,
  getContextFlagStatuses,
  getHookTargetStatuses,
  readContextActivity,
} from "./context-diagnostics.js";
import { refreshPricing as refreshPricingDirect } from "./db/pricing.js";
import { closeDb, getDb } from "./db/schema.js";
import { DAEMON_NAMES, type DaemonName, LOG_DIR, logPaths } from "./log.js";
import {
  permissionsApply,
  permissionsPreview,
  permissionsShow,
} from "./mcp/permissions.js";
import { readScannerStatus } from "./scanner/status.js";
import {
  formatServerStatus,
  isPidRunning,
  readServerStartBackoffStatus,
  readServerStatus,
  type ServerStatus,
  startServerDetached,
  stopServer,
} from "./server-control.js";
import { httpPanopticonService } from "./service/http.js";
import {
  configureShellEnvDetailed,
  removeShellEnvDetailed,
  writePanopticonEnvFile,
} from "./setup.js";
import {
  installWindowsStartupTask,
  readWindowsStartupTaskStatus,
  uninstallWindowsStartupTask,
  uninstallWindowsStartupTaskIfInstalled,
} from "./startup-task.js";
import { setSyncEnabled } from "./sync/config.js";
import { allTargets, getTarget, targetIds } from "./targets/index.js";
import { readTomlFile, writeTomlFile } from "./toml.js";
import { loadUnifiedConfig } from "./unified-config.js";
import { readYamlFile, writeYamlFile } from "./yaml.js";

const service = httpPanopticonService;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function getPluginRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  dir = path.resolve(dir, "..");
  return dir;
}

function getServerScript(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "server.js",
  );
}

function isGitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function configureSyncEnabled(enabled: boolean): void {
  setSyncEnabled(enabled);
}

function requireGitForSync(
  retryCommand = "panopticon install",
  includeDisableSyncHint = true,
): void {
  if (isGitAvailable()) return;

  const lines = [
    "Git is required for Panopticon sync.",
    "",
    "Panopticon uses git during ingest to resolve repository attribution.",
    "Without it, sessions cannot be matched to repos and remote sync will skip them.",
    "",
    "Install Git and make sure `git --version` works in your shell, then rerun:",
    `  ${retryCommand}`,
  ];
  if (includeDisableSyncHint) {
    lines.push(
      "",
      "To install with remote sync disabled, rerun:",
      "  panopticon install --disable-sync",
    );
  }
  console.error(lines.join("\n"));
  process.exit(1);
}

function readJsonFile(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function skillInstallDirs(
  targets: import("./targets/types.js").TargetAdapter[],
): string[] {
  return [...new Set(targets.flatMap((t) => t.skills?.installDirs() ?? []))];
}

function commandInstallDirs(
  targets: import("./targets/types.js").TargetAdapter[],
): string[] {
  return [...new Set(targets.flatMap((t) => t.commands?.installDirs() ?? []))];
}

const LEGACY_SKILL_NAMES = ["panopticon-review", "pr-review"];
const LEGACY_COMMAND_NAMES = ["panopticon-review", "pr-review"];

function writeJsonFile(filePath: string, data: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function readTargetConfig(
  target: import("./targets/types.js").TargetAdapter,
): Record<string, unknown> {
  if (target.config.configFormat === "toml") {
    return readTomlFile(target.config.configPath);
  }
  if (target.config.configFormat === "yaml") {
    return readYamlFile(target.config.configPath);
  }
  return readJsonFile(target.config.configPath) ?? {};
}

function writeTargetConfig(
  target: import("./targets/types.js").TargetAdapter,
  data: Record<string, unknown>,
): void {
  if (target.config.configFormat === "toml") {
    writeTomlFile(target.config.configPath, data);
    return;
  }
  if (target.config.configFormat === "yaml") {
    writeYamlFile(target.config.configPath, data);
    return;
  }
  writeJsonFile(target.config.configPath, data);
}

function readActiveScannerStatus(server: ServerStatus) {
  if (!server.running) return null;
  const status = readScannerStatus();
  if (!status) return null;
  if (server.pidFile.running && server.pidFile.pid != null) {
    return status.pid === server.pidFile.pid ? status : null;
  }
  if (server.health.ok) {
    if (server.health.pid != null) {
      return status.pid === server.health.pid ? status : null;
    }
    if (isPidRunning(status.pid)) return status;
  }
  return null;
}

function parseAge(value: string): number {
  const match = value.match(/^(\d+)\s*(d|h|m)$/);
  if (!match) {
    console.error(
      `Invalid --older-than value: ${value} (use e.g. 30d, 24h, 60m)`,
    );
    process.exit(1);
  }
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    d: 86400000,
    h: 3600000,
    m: 60000,
  };
  return n * multipliers[unit];
}

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function tailLines(filePath: string, n: number): string[] {
  const CHUNK_SIZE = 64 * 1024;
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return [];

    const readStart = Math.max(0, size - CHUNK_SIZE);
    const buf = Buffer.alloc(size - readStart);
    fs.readSync(fd, buf, 0, buf.length, readStart);
    const chunk = buf.toString("utf-8");

    const lines = chunk.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (readStart > 0 && lines.length > 0) lines.shift();
    return lines.slice(-n);
  } finally {
    fs.closeSync(fd);
  }
}

function formatElapsedMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function describeScannerPhase(phase: string): string {
  switch (phase) {
    case "startup_scan":
      return "running startup scan";
    case "startup_process":
      return "processing startup updates";
    case "incremental_scan":
      return "scanning session files";
    case "incremental_process":
      return "processing touched sessions";
    case "reparse_init":
      return "initializing reparse";
    case "reparse_scan":
      return "scanning raw files";
    case "reparse_process":
      return "processing touched sessions";
    case "reparse_copy":
      return "copying preserved data";
    case "reparse_derive":
      return "rebuilding derived state";
    case "reparse_finalize":
      return "finalizing reparse";
    case "reparse_error":
      return "reparse error";
    case "claims_rebuild_init":
      return "initializing claims rebuild";
    case "claims_rebuild_claims":
      return "rebuilding claims";
    case "claims_rebuild_projection":
      return "rebuilding intent projection";
    case "claims_rebuild_finalize":
      return "finalizing claims rebuild";
    case "claims_rebuild_error":
      return "claims rebuild error";
    default:
      return phase;
  }
}

function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf-8")),
    );
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Shell environment configuration
// ---------------------------------------------------------------------------

function configureShellEnv(force: boolean, target = "claude", proxy = false) {
  if (process.platform === "win32") {
    const shellEnv = configureShellEnvDetailed({ force, target, proxy });
    for (const profileUpdate of shellEnv.profileUpdates) {
      console.log(
        `      ${profileUpdate.action === "updated" ? "Updated" : "Added"} env vars in ${profileUpdate.path}`,
      );
    }
    for (const envFile of shellEnv.envFiles) {
      console.log(`      Wrote ${envFile}`);
    }
    console.log();
    return;
  }

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

  // Shared OTEL vars + all target-specific vars
  const PANOPTICON_VARS = [
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

  // Generate the auth token once so the bashrc and the env.sh file both
  // contain the same OTEL_EXPORTER_OTLP_HEADERS value.
  const authToken = getOrCreateAuthToken();

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
    [
      "OTEL_EXPORTER_OTLP_HEADERS",
      // Per the OTel spec, header values are URL-encoded — encode the
      // space between "Bearer" and the token. The token itself is hex.
      `export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${authToken}`,
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

    const existing = existingByKey.get(key);
    if (existing && existing !== value) {
      console.log(`      ⚠ Keeping existing value: ${existing}`);
      console.log(`        (default would be: ${value})`);
      console.log("        (use --force to overwrite)");
    }
    return existing ?? value;
  });

  const insertionIndex = insertAt >= 0 ? insertAt : preservedLines.length;
  const blockLines = ["", ...resolvedBlock, ""];
  preservedLines.splice(insertionIndex, 0, ...blockLines);

  fs.writeFileSync(shellRc, preservedLines.join("\n"));
  console.log(
    `      ${insertAt >= 0 ? "Updated" : "Added"} env vars in ${shellRc}`,
  );

  // Also write the dedicated env file so non-interactive callers (CI,
  // docker entrypoints, e2e scripts) can source the panopticon env without
  // depending on the standard `~/.bashrc` non-interactive guard.
  const envFile = writePanopticonEnvFile(proxy, {}, target);
  console.log(`      Wrote ${envFile}\n`);
}

function removeShellEnv() {
  if (process.platform === "win32") {
    const shellCleanup = removeShellEnvDetailed();
    if (shellCleanup.removedProfilePaths.length === 0) {
      console.log("      No panopticon shell env block found\n");
      return;
    }
    for (const profilePath of shellCleanup.removedProfilePaths) {
      console.log(`      Removed panopticon env vars from ${profilePath}`);
    }
    console.log();
    return;
  }

  const shellRc = path.join(
    os.homedir(),
    process.env.SHELL?.includes("zsh") ? ".zshrc" : ".bashrc",
  );
  if (!fs.existsSync(shellRc)) return;

  const content = fs.readFileSync(shellRc, "utf-8");
  const lines = content.split("\n");
  let inBlock = false;
  const filtered = lines.filter((line) => {
    if (line.trim().startsWith("# >>> panopticon")) {
      inBlock = true;
      return false;
    }
    if (line.trim().startsWith("# <<< panopticon")) {
      inBlock = false;
      return false;
    }
    return !inBlock;
  });

  fs.writeFileSync(shellRc, filtered.join("\n"));
  console.log(`      Removed panopticon env vars from ${shellRc}\n`);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("panopticon")
  .description("Observability for Claude Code")
  .version(
    typeof __PANOPTICON_VERSION__ !== "undefined"
      ? __PANOPTICON_VERSION__
      : "dev",
  );

// ---------------------------------------------------------------------------
// Daemon management commands
// ---------------------------------------------------------------------------

program
  .command("install")
  .alias("setup")
  .description("Build, register plugin, init DB, configure shell")
  .option(
    "--target <target>",
    `Target CLI: ${targetIds().join(", ")}, all`,
    "all",
  )
  .option("--proxy", "Also route API traffic through the panopticon proxy")
  .option("--disable-sync", "Disable remote sync and skip Git detection")
  .option(
    "--startup-task",
    "Install a per-user Windows logon task that runs panopticon start",
  )
  .option("--force", "Overwrite customized env vars with defaults")
  .action(async (opts: Opts) => {
    const validTargets = [...targetIds(), "all"];
    if (!validTargets.includes(opts.target)) {
      console.error(
        `Invalid target: ${opts.target}. Must be ${validTargets.join(", ")}.`,
      );
      process.exit(1);
    }
    const pluginRoot = getPluginRoot();
    await install(pluginRoot, opts);
  });

program
  .command("uninstall")
  .description("Remove panopticon hooks, shell config, and optionally all data")
  .option(
    "--target <target>",
    `Target CLI: ${targetIds().join(", ")}, all`,
    "all",
  )
  .option("--purge", "Also remove database and all data")
  .action(async (opts: Opts) => {
    const validTargets = [...targetIds(), "all"];
    if (!validTargets.includes(opts.target)) {
      console.error(
        `Invalid target: ${opts.target}. Must be ${validTargets.join(", ")}.`,
      );
      process.exit(1);
    }

    const targetId = opts.target ?? "all";
    const purge = !!opts.purge;

    console.log("Uninstalling panopticon...\n");

    console.log("[1/6] Stopping daemons...");
    await stopServer({ includeLegacy: true });
    if (targetId === "all" && process.platform === "win32") {
      try {
        const result = uninstallWindowsStartupTaskIfInstalled();
        console.log(`      Windows startup task: ${result.detail}`);
      } catch (err: unknown) {
        console.log(
          `      warn: Windows startup task could not be removed: ${(err as Error).message}`,
        );
        console.log("      Run 'panopticon startup remove' to retry manually.");
      }
    }
    console.log();

    // Ask Claude Code to uninstall the plugin so the MCP server process is
    // killed and in-memory state (including the cached DB) is evicted.
    console.log("[2/6] Uninstalling MCP plugin...");
    if (targetId === "all" || targetId === "claude") {
      try {
        execFileSync(
          "claude",
          ["plugin", "uninstall", "panopticon@local-plugins"],
          {
            stdio: "ignore",
            timeout: 10_000,
            windowsHide: true,
          },
        );
        console.log("      Uninstalled plugin via Claude Code CLI");
      } catch {
        // Best-effort — claude CLI may not be on PATH or plugin already gone
      }
    } else {
      console.log("      Skipped (target-specific uninstall)");
    }
    console.log();

    // Remove target configs
    const selectedTargets =
      targetId === "all"
        ? allTargets()
        : allTargets().filter((t) => t.id === targetId);

    for (const t of selectedTargets) {
      console.log(`[3/6] Removing panopticon from ${t.detect.displayName}...`);
      const existing = readTargetConfig(t);
      const updated = t.hooks.removeInstallConfig(existing);
      writeTargetConfig(t, updated);
      console.log(`      ${t.config.configPath}\n`);
    }

    // Remove shell env
    console.log("[4/6] Cleaning shell environment...");
    removeShellEnv();

    if (targetId === "all") {
      // Remove marketplace and plugin cache
      console.log("[5/6] Removing marketplace and plugin cache...");
      try {
        fs.rmSync(config.marketplaceDir, { recursive: true, force: true });
        console.log(`      Removed ${config.marketplaceDir}`);
      } catch {}
      try {
        fs.rmSync(config.pluginCacheDir, { recursive: true, force: true });
        console.log(`      Removed ${config.pluginCacheDir}`);
      } catch {}
      console.log();
    } else {
      console.log("[5/6] Skipping marketplace (target-specific uninstall)\n");
    }

    // Remove commands and skills (mirrors install: scope to selected targets)
    console.log("[6/6] Removing commands and skills...");
    const pluginRoot = getPluginRoot();
    const commandsSource = path.join(pluginRoot, "commands");
    const commandTargets = commandInstallDirs(selectedTargets);
    if (commandTargets.length === 0) {
      console.log("      (no command-supporting targets selected)");
    } else if (fs.existsSync(commandsSource)) {
      for (const name of fs.readdirSync(commandsSource)) {
        if (!name.endsWith(".md")) continue;
        for (const commandTarget of commandTargets) {
          const dest = path.join(commandTarget, name);
          try {
            fs.rmSync(dest, { force: true });
            console.log(`      Removed ${dest}`);
          } catch {}
        }
      }
    }
    for (const legacyName of LEGACY_COMMAND_NAMES) {
      for (const commandTarget of commandTargets) {
        const dest = path.join(commandTarget, `${legacyName}.md`);
        try {
          fs.rmSync(dest, { force: true });
          console.log(`      Removed ${dest}`);
        } catch {}
      }
    }

    const skillsSource = path.join(pluginRoot, "skills");
    const skillTargets = skillInstallDirs(selectedTargets);
    if (skillTargets.length === 0) {
      console.log("      (no skill-supporting targets selected)");
    } else if (fs.existsSync(skillsSource)) {
      for (const name of fs.readdirSync(skillsSource)) {
        for (const skillsTarget of skillTargets) {
          const dest = path.join(skillsTarget, name);
          try {
            fs.rmSync(dest, { recursive: true, force: true });
            console.log(`      Removed ${dest}`);
          } catch {}
        }
      }
    }
    for (const legacyName of LEGACY_SKILL_NAMES) {
      for (const skillsTarget of skillTargets) {
        const dest = path.join(skillsTarget, legacyName);
        try {
          fs.rmSync(dest, { recursive: true, force: true });
          console.log(`      Removed ${dest}`);
        } catch {}
      }
    }
    console.log();

    if (purge) {
      console.log("Purging data...");
      closeDb();
      try {
        fs.rmSync(config.dataDir, { recursive: true, force: true });
        console.log(`      Removed ${config.dataDir}`);
      } catch {}
      try {
        fs.rmSync(LOG_DIR, { recursive: true, force: true });
        console.log(`      Removed ${LOG_DIR}`);
      } catch {}
      console.log();
    }

    console.log("Done! Panopticon has been uninstalled.");
    if (!purge) {
      console.log(
        `Database preserved at ${config.dataDir} (use --purge to remove)`,
      );
    }
  });

program
  .command("update")
  .description("Update panopticon to the latest version")
  .action(async () => {
    const currentVersion =
      typeof __PANOPTICON_VERSION__ !== "undefined"
        ? __PANOPTICON_VERSION__
        : "unknown";

    console.log(`Current: ${currentVersion}`);
    console.log(
      "To update, re-run the install command for your package manager:\n",
    );
    console.log("  pnpm install -g @fml-inc/panopticon@latest");
    console.log("  # or: npm install -g @fml-inc/panopticon@latest\n");
    console.log("Then run: panopticon install");
  });

async function install(
  pluginRoot: string,
  opts: {
    force?: boolean;
    target?: string;
    proxy?: boolean;
    disableSync?: boolean;
    startupTask?: boolean;
  },
) {
  const force = opts.force ?? false;
  const target = opts.target ?? "claude";
  const syncEnabled = !opts.disableSync;

  console.log("Installing panopticon...\n");

  const pkgJson = readJsonFile(path.join(pluginRoot, "package.json"));
  const version = pkgJson?.version ?? "0.0.0-dev";

  if (syncEnabled) {
    requireGitForSync("panopticon install");
  }

  console.log("[1/5] Initializing database and log directory...");
  ensureDataDir();
  const logDir = path.dirname(logPaths.server);
  fs.mkdirSync(logDir, { recursive: true });
  getDb();
  closeDb();
  configureSyncEnabled(syncEnabled);
  console.log(`      ${config.dbPath}`);
  console.log(`      ${logDir}`);
  if (!syncEnabled) {
    console.log("      Remote sync disabled (--disable-sync)");
  }

  // Ensure the Claude Code plugin manifest exists and has the current
  // version. Claude Code's local-plugins loader reads `version` from
  // .claude-plugin/plugin.json (not package.json) to pick the cache
  // directory name — without it, every install reuses the same stale
  // `unknown/` directory forever. The prepack hook generates this file
  // for published tarballs; this block handles local dev where the
  // source tree's `.claude-plugin/` is gitignored and may not exist or
  // may be stale from a long-ago build.
  const pluginManifestPath = path.join(
    pluginRoot,
    ".claude-plugin",
    "plugin.json",
  );
  fs.mkdirSync(path.dirname(pluginManifestPath), { recursive: true });
  writeJsonFile(pluginManifestPath, {
    name: "panopticon",
    version,
    description: pkgJson?.description ?? "Observability for Claude Code",
    mcpServers: {
      panopticon: {
        command: "node",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude plugin variable syntax
        args: ["${CLAUDE_PLUGIN_ROOT}/bin/mcp-server"],
      },
    },
  });

  const hooksJsonPath = path.join(pluginRoot, "hooks", "hooks.json");
  const hooksJson = readJsonFile(hooksJsonPath);
  if (hooksJson && typeof hooksJson === "object") {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude plugin variable syntax
    const quotedHook = JSON.stringify("${CLAUDE_PLUGIN_ROOT}/bin/hook-handler");
    const command = `node ${quotedHook} claude`;
    const hooks = (hooksJson as Record<string, unknown>).hooks as
      | Record<string, unknown>
      | undefined;
    if (hooks && typeof hooks === "object") {
      for (const entries of Object.values(hooks)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const hookGroup = entry as { hooks?: Array<Record<string, unknown>> };
          if (!Array.isArray(hookGroup.hooks)) continue;
          for (const hook of hookGroup.hooks) {
            if (hook.type === "command") {
              hook.command = command;
            }
          }
        }
      }
      writeJsonFile(hooksJsonPath, hooksJson);
    }
  }

  // Fetch model pricing from LiteLLM (non-blocking if it fails)
  const pricing = await refreshPricingDirect();
  console.log(
    pricing
      ? `      Cached pricing for ${Object.keys(pricing.models).length} models\n`
      : "      Could not fetch pricing (will use defaults)\n",
  );

  console.log("[2/5] Setting up local marketplace...");
  fs.mkdirSync(path.join(config.marketplaceDir, ".claude-plugin"), {
    recursive: true,
  });
  const manifest = readJsonFile(config.marketplaceManifest) ?? {
    name: "local-plugins",
    owner: { name: os.userInfo().username },
    plugins: [],
  };
  const plugins = (manifest.plugins as Array<Record<string, unknown>>) ?? [];
  const existing = plugins.findIndex((p) => p.name === "panopticon");
  const entry = {
    name: "panopticon",
    source: "./panopticon",
    description: pkgJson?.description ?? "Observability for Claude Code",
  };
  if (existing >= 0) {
    plugins[existing] = entry;
  } else {
    plugins.push(entry);
  }
  manifest.plugins = plugins;
  writeJsonFile(config.marketplaceManifest, manifest);

  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  const marketplaceLink = path.join(config.marketplaceDir, "panopticon");
  try {
    fs.unlinkSync(marketplaceLink);
  } catch {}
  fs.symlinkSync(pluginRoot, marketplaceLink, symlinkType);

  console.log(`      Marketplace: ${config.marketplaceDir}`);

  // Register plugin with Claude Code (install if new, update if existing)
  // Claude Code keys the cache by plugin version, so dev reinstalls with the
  // same version can otherwise keep an old manifest forever.
  try {
    fs.rmSync(path.join(config.pluginCacheDir, version), {
      recursive: true,
      force: true,
    });
  } catch {}
  try {
    try {
      execFileSync(
        "claude",
        ["plugin", "install", "panopticon@local-plugins"],
        { stdio: "pipe", timeout: 15_000, windowsHide: true },
      );
    } catch {
      execFileSync("claude", ["plugin", "update", "panopticon@local-plugins"], {
        stdio: "pipe",
        timeout: 15_000,
        windowsHide: true,
      });
    }
    console.log("      Plugin cache updated via Claude Code CLI\n");
  } catch {
    console.log(
      "      warn: claude CLI not found, run 'claude plugin install panopticon@local-plugins' manually\n",
    );
  }

  // Register hooks/config for each selected target
  const selectedTargets =
    target === "all"
      ? allTargets()
      : ([getTarget(target)].filter(
          Boolean,
        ) as import("./targets/types.js").TargetAdapter[]);

  for (const t of selectedTargets) {
    console.log(`[3/5] Registering panopticon in ${t.detect.displayName}...`);

    // Read existing config
    const existingConfig = readTargetConfig(t);

    // Apply target-specific install config
    const updatedConfig = t.hooks.applyInstallConfig(existingConfig, {
      pluginRoot,
      port: config.port,
      proxy: !!opts.proxy,
    });

    // Write back
    writeTargetConfig(t, updatedConfig);

    if (opts.proxy && t.id === "codex") {
      console.log("      API proxy enabled (--proxy)");
    }
    console.log(`      ${t.config.configPath}\n`);
  }

  // Log skipped targets
  const skippedTargets = allTargets().filter(
    (v) => !selectedTargets.some((st) => st.id === v.id),
  );
  for (const t of skippedTargets) {
    console.log(`[3/5] Skipping ${t.detect.displayName} settings...\n`);
  }

  console.log("[4/5] Installing commands and skills...");
  const commandsSource = path.join(pluginRoot, "commands");
  const commandTargets = commandInstallDirs(selectedTargets);
  if (commandTargets.length === 0) {
    console.log("      (no command-supporting targets selected)");
  } else if (fs.existsSync(commandsSource)) {
    for (const commandFile of fs.readdirSync(commandsSource)) {
      if (!commandFile.endsWith(".md")) continue;
      const src = path.join(commandsSource, commandFile);
      if (!fs.statSync(src).isFile()) continue;
      for (const commandTarget of commandTargets) {
        const dest = path.join(commandTarget, commandFile);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        console.log(`      ${commandFile} -> ${dest}`);
      }
    }
  }
  for (const legacyName of LEGACY_COMMAND_NAMES) {
    for (const commandTarget of commandTargets) {
      fs.rmSync(path.join(commandTarget, `${legacyName}.md`), { force: true });
    }
  }

  const skillsSource = path.join(pluginRoot, "skills");
  const skillTargets = skillInstallDirs(selectedTargets);
  if (skillTargets.length === 0) {
    console.log("      (no skill-supporting targets selected)");
  } else if (fs.existsSync(skillsSource)) {
    for (const skillName of fs.readdirSync(skillsSource)) {
      const src = path.join(skillsSource, skillName);
      if (!fs.statSync(src).isDirectory()) continue;
      for (const skillsTarget of skillTargets) {
        const dest = path.join(skillsTarget, skillName);
        fs.cpSync(src, dest, { recursive: true });
        console.log(`      ${skillName} -> ${dest}`);
      }
    }
  }
  for (const legacyName of LEGACY_SKILL_NAMES) {
    for (const skillsTarget of skillTargets) {
      fs.rmSync(path.join(skillsTarget, legacyName), {
        recursive: true,
        force: true,
      });
    }
  }
  console.log();

  console.log("[5/5] Configuring shell environment...");
  configureShellEnv(force, target, !!opts.proxy);

  const started = await startServerDetached({
    ignoreStartBackoff: true,
    serverScript: getServerScript(),
    stopExisting: true,
  });
  const pidText = started.pid != null ? `PID ${started.pid}, ` : "";
  console.log(
    `\nServer ${started.status === "already_running" ? "running" : "started"} (${pidText}port ${started.port})`,
  );

  if (opts.startupTask) {
    console.log("\nConfiguring Windows startup task...");
    if (process.platform !== "win32") {
      console.log("      Skipped: startup tasks are only supported on Windows");
    } else {
      const result = installWindowsStartupTask();
      console.log(`      ${result.detail}`);
    }
  }

  const assistant =
    target === "all"
      ? allTargets()
          .map((v) => v.detect.displayName)
          .join(", ")
      : (getTarget(target)?.detect.displayName ?? target);
  console.log(`Done! Start a new ${assistant} session to activate.\n`);
  console.log("Verify with: panopticon status");
}

program
  .command("start")
  .description("Start panopticon server (background)")
  .option("--force", "Bypass server start-failure backoff")
  .action(async (opts: Opts) => {
    ensureDataDir();
    const result = await startServerDetached({
      ignoreStartBackoff: !!opts.force,
      serverScript: getServerScript(),
    });
    const pidText = result.pid != null ? `PID ${result.pid}, ` : "";
    if (result.status === "already_running") {
      console.log(`Panopticon already running (${pidText}port ${result.port})`);
    } else {
      console.log(`Panopticon started (${pidText}port ${result.port})`);
    }
    console.log(`Log: ${logPaths.server}`);
  });

program
  .command("stop")
  .description("Stop panopticon server")
  .action(async () => {
    const result = await stopServer({ includeLegacy: true });
    switch (result.status) {
      case "stopped":
        console.log(`Panopticon stopped (PID ${result.pid})`);
        break;
      case "killed":
        console.log(`Panopticon force stopped (PID ${result.pid})`);
        break;
      case "signal_sent":
        console.log(`Panopticon stop signal sent (PID ${result.pid})`);
        break;
      case "permission_denied":
        console.log(
          `Panopticon is running but could not be stopped (permission denied, PID ${result.pid})`,
        );
        break;
      case "stale_pid_removed":
        console.log("Panopticon was not running (stale PID file removed)");
        break;
      case "not_running":
        console.log("Panopticon is not running");
        break;
    }
  });

const startup = program
  .command("startup")
  .description("Manage optional per-user startup integration");

startup
  .command("status", { isDefault: true })
  .description("Show Windows logon startup task status")
  .action(() => {
    const status = readWindowsStartupTaskStatus();
    console.log(
      `${status.taskName}: ${status.installed ? "installed" : "not installed"} (${status.detail})`,
    );
  });

startup
  .command("install")
  .description("Install a hidden per-user Windows logon task")
  .action(() => {
    const result = installWindowsStartupTask();
    console.log(`${result.taskName}: ${result.detail}`);
  });

startup
  .command("remove")
  .alias("uninstall")
  .description("Remove the per-user Windows logon task")
  .action(() => {
    const result = uninstallWindowsStartupTask();
    console.log(`${result.taskName}: ${result.detail}`);
  });

program
  .command("doctor")
  .description("Check system health, server, database, and configuration")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { doctor } = await import("./doctor.js");
    const result = await doctor();

    if (opts.json) {
      output(result);
      return;
    }

    console.log(
      `System: ${result.system.os} · Node ${result.system.node}${result.system.sandbox ? " · Sandbox" : ""}`,
    );
    console.log();

    for (const check of result.checks) {
      const icon =
        check.status === "ok"
          ? "\x1b[32m✓\x1b[0m"
          : check.status === "warn"
            ? "\x1b[33m!\x1b[0m"
            : "\x1b[31m✗\x1b[0m";
      console.log(`  ${icon}  ${check.label.padEnd(12)} ${check.detail}`);
    }

    console.log();
    const passed = result.checks.filter((c) => c.status === "ok").length;
    const warned = result.checks.filter((c) => c.status === "warn").length;
    const failed = result.checks.filter((c) => c.status === "fail").length;
    const parts: string[] = [];
    if (passed > 0) parts.push(`\x1b[32m${passed} passed\x1b[0m`);
    if (warned > 0)
      parts.push(`\x1b[33m${warned} warning${warned > 1 ? "s" : ""}\x1b[0m`);
    if (failed > 0) parts.push(`\x1b[31m${failed} failed\x1b[0m`);
    console.log(`  ${parts.join(", ")}`);

    if (result.recentErrors.length > 0) {
      console.log();
      console.log("  Recent errors:");
      for (const err of result.recentErrors) {
        console.log(`    [${err.id}] ${err.body}`);
      }
    }

    if (result.recentEvents.length > 0) {
      console.log();
      console.log("  Recent events:");
      for (const evt of result.recentEvents) {
        const tool = evt.toolName ? ` (${evt.toolName})` : "";
        console.log(`    ${evt.eventType}${tool} — ${evt.timestamp}`);
      }
    }

    console.log();
  });

program
  .command("status")
  .description("Show server status and database stats")
  .action(async () => {
    const server = await readServerStatus();
    const activeScannerStatus = readActiveScannerStatus(server);

    console.log("Panopticon Status");
    console.log("=================");
    console.log();
    console.log(`Server: ${formatServerStatus(server)}`);
    const startBackoff = readServerStartBackoffStatus();
    if (startBackoff.exists) {
      const retryText = startBackoff.nextAllowedAtMs
        ? new Date(startBackoff.nextAllowedAtMs).toISOString()
        : "unknown";
      console.log(
        `Start backoff: ${startBackoff.active ? "active" : "inactive"} (${startBackoff.attempts} failed start attempt${startBackoff.attempts === 1 ? "" : "s"}, retry ${retryText})`,
      );
    }
    console.log(`Database: ${config.dbPath}`);

    if (activeScannerStatus) {
      console.log();
      console.log("Scanner:");
      console.log(
        `  phase:   ${describeScannerPhase(activeScannerStatus.phase)}`,
      );
      console.log(`  detail:  ${activeScannerStatus.message}`);
      console.log(
        `  elapsed: ${formatElapsedMs(activeScannerStatus.elapsedMs)}`,
      );
      if (
        activeScannerStatus.discoveredFiles != null &&
        activeScannerStatus.processedFiles != null &&
        activeScannerStatus.discoveredFiles > 0
      ) {
        const percent =
          (activeScannerStatus.processedFiles /
            activeScannerStatus.discoveredFiles) *
          100;
        let progressLine =
          `  progress: ${activeScannerStatus.processedFiles}/${activeScannerStatus.discoveredFiles} files (${percent.toFixed(1)}%)` +
          `, scanned=${activeScannerStatus.filesScanned ?? 0}` +
          `, turns=${activeScannerStatus.newTurns ?? 0}` +
          `, touched_sessions=${activeScannerStatus.touchedSessions ?? 0}`;
        if (activeScannerStatus.currentSource) {
          progressLine += `, source=${activeScannerStatus.currentSource}`;
        }
        console.log(progressLine);
      }
      if (
        activeScannerStatus.totalSessions != null &&
        activeScannerStatus.processedSessions != null &&
        activeScannerStatus.totalSessions > 0
      ) {
        const percent =
          (activeScannerStatus.processedSessions /
            activeScannerStatus.totalSessions) *
          100;
        let progressLine =
          `  sessions: ${activeScannerStatus.processedSessions}/${activeScannerStatus.totalSessions} (${percent.toFixed(1)}%)` +
          `, touched_sessions=${activeScannerStatus.touchedSessions ?? 0}`;
        if (activeScannerStatus.currentSessionId) {
          progressLine += `, current_session=${activeScannerStatus.currentSessionId}`;
        }
        console.log(progressLine);
      }
    }

    console.log();
    console.log("Log files:");
    for (const name of DAEMON_NAMES) {
      const logPath = logPaths[name];
      let sizeStr = "not created";
      try {
        const stat = fs.statSync(logPath);
        sizeStr =
          stat.size < 1024
            ? `${stat.size} B`
            : `${(stat.size / 1024).toFixed(1)} KB`;
      } catch {}
      console.log(`  ${name}: ${logPath} (${sizeStr})`);
    }

    if (fs.existsSync(config.dbPath)) {
      const stat = fs.statSync(config.dbPath);
      console.log(`Database size: ${(stat.size / 1024).toFixed(1)} KB`);

      if (server.health.ok && !activeScannerStatus) {
        try {
          const stats = (await service.dbStats()) as Record<string, number>;
          console.log();
          console.log("Row counts:");
          console.log(`  sessions:       ${stats.sessions}`);
          console.log(`  messages:       ${stats.messages}`);
          console.log(`  tool_calls:     ${stats.tool_calls}`);
          console.log(`  scanner_turns:  ${stats.scanner_turns}`);
          console.log(`  scanner_events: ${stats.scanner_events}`);
          console.log(`  hook_events:    ${stats.hook_events}`);
          console.log(`  otel_logs:      ${stats.otel_logs}`);
          console.log(`  otel_metrics:   ${stats.otel_metrics}`);
        } catch {
          console.log("  (could not read database)");
        }
      } else if (activeScannerStatus) {
        console.log("Database stats: unavailable during active scanner work");
      }
    } else {
      console.log("Database: not initialized (run 'panopticon install')");
    }

    // Sync state is always reported so an enabled-but-idle configuration is
    // visible from `panopticon status`.
    try {
      const cfg = loadUnifiedConfig();
      const targets = cfg.sync.targets;
      if (cfg.sync.enabled === false) {
        console.log();
        console.log("Sync: disabled (--disable-sync)");
        if (targets.length > 0) {
          console.log("Configured sync targets (inactive):");
          for (const t of targets) {
            console.log(`  ${t.name} → ${t.url}`);
          }
        }
      } else if (targets.length === 0) {
        console.log();
        console.log(
          "Sync: enabled but no targets configured; nothing is syncing",
        );
        console.log("  Add one with: panopticon sync add <name> <url>");
      } else {
        console.log();
        console.log("Sync targets:");
        for (const t of targets) {
          console.log(`  ${t.name} → ${t.url}`);

          if (server.health.ok && !activeScannerStatus) {
            try {
              const result = await service.syncPending(t.name);
              if (result.totalPending === 0) {
                console.log("    status: up to date");
              } else {
                console.log(`    pending: ${result.totalPending} total`);
                for (const [table, info] of Object.entries(result.tables)) {
                  console.log(
                    `      ${table}: ${info.pending} (${info.synced} / ${info.total})`,
                  );
                }
              }
            } catch {}
          } else if (activeScannerStatus) {
            console.log("    status: unavailable during active scanner work");
          }
        }
      }
    } catch {
      console.log();
      console.log("Sync: (could not read sync config)");
    }

    console.log();
    console.log("Context intelligence:");
    console.log(`  flags: ${formatContextFlags(getContextFlagStatuses())}`);
    console.log(
      `  hook targets: ${formatHookTargets(getHookTargetStatuses())}`,
    );
    console.log(
      `  recent activity: ${formatContextActivity(readContextActivity())}`,
    );
    console.log(`  code intel: ${formatCodeIntelStatus(getCodeIntelStatus())}`);
  });

program
  .command("logs")
  .alias("log")
  .description("View daemon logs (otlp, mcp)")
  .argument("[daemon]", "Daemon name (otlp, mcp)", "otlp")
  .option("-f, --follow", "Follow log output (like tail -f)")
  .option("-n, --lines <count>", "Number of lines to show", "50")
  .action(async (daemon: string, opts: Opts) => {
    if (!DAEMON_NAMES.includes(daemon as DaemonName)) {
      console.error(`Unknown daemon: ${daemon}`);
      console.log(`Available: ${DAEMON_NAMES.join(", ")}`);
      process.exit(1);
    }

    const logPath = logPaths[daemon as DaemonName];
    const numLines = parseInt(opts.lines, 10);

    if (!fs.existsSync(logPath)) {
      console.log(`No logs yet for ${daemon} (${logPath})`);
      return;
    }

    const lines = tailLines(logPath, numLines);
    for (const line of lines) {
      console.log(line);
    }

    if (opts.follow) {
      let pos = fs.statSync(logPath).size;
      fs.watchFile(logPath, { interval: 200 }, () => {
        const stat = fs.statSync(logPath);
        if (stat.size > pos) {
          const fd = fs.openSync(logPath, "r");
          const buf = Buffer.alloc(stat.size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          fs.closeSync(fd);
          process.stdout.write(buf.toString("utf-8"));
          pos = stat.size;
        } else if (stat.size < pos) {
          pos = 0;
        }
      });
      await new Promise(() => {});
    }
  });

program
  .command("prune")
  .description("Delete old data from the database")
  .option("--older-than <age>", "Max age (e.g. 30d, 24h, 60m)", "30d")
  .option("--dry-run", "Show estimate without deleting")
  .option("--vacuum", "Reclaim disk space after pruning")
  .option("--yes", "Skip confirmation prompt")
  .action(async (opts: Opts) => {
    const ageMs = parseAge(opts.olderThan);
    const cutoffMs = Date.now() - ageMs;
    const cutoffDate = new Date(cutoffMs).toISOString();

    console.log(
      `Pruning rows older than ${opts.olderThan} (before ${cutoffDate})`,
    );
    console.log();

    const estimate = (await service.pruneEstimate(cutoffMs)) as Record<
      string,
      number
    >;
    const total = Object.values(estimate).reduce((a, b) => a + b, 0);

    console.log("Rows to delete:");
    for (const [key, count] of Object.entries(estimate)) {
      if (count > 0) console.log(`  ${key}: ${count}`);
    }
    console.log(`  total: ${total}`);
    console.log();

    if (total === 0) {
      console.log("Nothing to prune.");
      return;
    }

    if (opts.dryRun) {
      console.log("Dry run — no rows deleted.");
      return;
    }

    if (!opts.yes) {
      const answer = await promptUser("Proceed with deletion? [y/N] ");
      if (answer.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
    }

    const result = (await service.pruneExecute(cutoffMs, {
      vacuum: opts.vacuum,
    })) as Record<string, number>;
    console.log("Deleted:");
    for (const [key, count] of Object.entries(result)) {
      if (count > 0) console.log(`  ${key}: ${count}`);
    }

    if (opts.vacuum) {
      console.log("\nDisk space reclaimed.");
    }
  });

program
  .command("sync")
  .description("Manage remote sync")
  .addCommand(
    new Command("enable").description("Enable remote sync").action(() => {
      requireGitForSync("panopticon sync enable", false);
      const cfg = setSyncEnabled(true);
      console.log("Remote sync enabled.");
      if (cfg.targets.length === 0) {
        console.log(
          "No sync targets configured. Add one with: panopticon sync add <name> <url>",
        );
      }
      console.log("Restart panopticon to apply.");
    }),
  )
  .addCommand(
    new Command("disable").description("Disable remote sync").action(() => {
      const cfg = setSyncEnabled(false);
      console.log("Remote sync disabled.");
      if (cfg.targets.length > 0) {
        console.log(`Configured sync targets preserved: ${cfg.targets.length}`);
      }
      console.log("Restart panopticon to apply.");
    }),
  )
  .addCommand(
    new Command("add")
      .description("Add or update a sync target")
      .argument("<name>", "Target name")
      .argument("<url>", "OTLP endpoint base URL")
      .option("--token <token>", "Bearer token for auth")
      .option(
        "--token-command <command>",
        "Shell command that returns a token (e.g. 'gh auth token')",
      )
      .action(async (name: string, url: string, opts: Opts) => {
        await service.syncTargetAdd({
          name,
          url,
          token: opts.token ?? undefined,
          tokenCommand: opts.tokenCommand ?? undefined,
        });
        console.log(`Added sync target "${name}" → ${url}`);
        console.log("Restart panopticon to activate.");
      }),
  )
  .addCommand(
    new Command("remove")
      .description("Remove a sync target")
      .argument("<name>", "Target name")
      .action(async (name: string) => {
        const result = (await service.syncTargetRemove(name)) as {
          ok: boolean;
        };
        if (result.ok) {
          console.log(`Removed sync target "${name}"`);
          console.log("Restart panopticon to apply.");
        } else {
          console.log(`No target named "${name}"`);
        }
      }),
  )
  .addCommand(
    new Command("list").description("List sync targets").action(async () => {
      const result = (await service.syncTargetList()) as {
        targets: Array<{
          name: string;
          url: string;
          token?: string;
          tokenCommand?: string;
        }>;
      };
      if (result.targets.length === 0) {
        console.log("No sync targets configured.");
        return;
      }
      for (const t of result.targets) {
        const auth = t.token
          ? " (token)"
          : t.tokenCommand
            ? ` (token-command: ${t.tokenCommand})`
            : "";
        console.log(`  ${t.name} → ${t.url}${auth}`);
      }
    }),
  )
  .addCommand(
    new Command("reset")
      .description("Reset sync watermarks (re-syncs all data)")
      .argument("[target]", "Reset only this sync target (default: all)")
      .action(async (targetName?: string) => {
        await service.syncReset(targetName);
        console.log(
          targetName
            ? `Reset sync watermarks for "${targetName}"`
            : "Reset all sync watermarks",
        );
        console.log("Restart panopticon to re-sync.");
      }),
  )
  .addCommand(
    new Command("watermark")
      .description("Get or set sync watermarks")
      .argument("<target>", "Sync target name")
      .argument("[table]", "Table name (omit to show all)")
      .option("--set <value>", "Set watermark to this value", parseInt)
      .action(async (target: string, table?: string, opts?: Opts) => {
        if (opts?.set !== undefined) {
          if (!table) {
            console.error("Table name is required when setting a watermark");
            process.exit(1);
          }
          const result = (await service.syncWatermarkSet(
            target,
            table,
            opts.set,
          )) as {
            key: string;
            value: number;
          };
          console.log(`${result.key} = ${result.value}`);
        } else {
          const result = await service.syncWatermarkGet(target, table);
          if (table) {
            const r = result as { key: string; value: number };
            console.log(`${r.key} = ${r.value}`);
          } else {
            const r = result as {
              target: string;
              watermarks: Record<string, number>;
            };
            console.log(`Watermarks for "${r.target}":`);
            for (const [tbl, value] of Object.entries(r.watermarks)) {
              console.log(`  ${tbl}: ${value}`);
            }
          }
        }
      }),
  );

// ---------------------------------------------------------------------------
// Query commands
// ---------------------------------------------------------------------------

const file = program
  .command("file")
  .description("Query local provenance for a file");

file
  .command("overview")
  .description("Show aggregate local provenance for a file")
  .argument("<path>", "File path to query")
  .option("--repository <path>", "Optional repository path override")
  .option(
    "--recent-limit <n>",
    "Max recent edits to return (default 5)",
    parseInt,
  )
  .option(
    "--related-limit <n>",
    "Max related files to return (default 10)",
    parseInt,
  )
  .action(async (filePath: string, opts: Opts) => {
    output(
      await service.fileOverview({
        path: filePath,
        repository: opts.repository,
        recent_limit: opts.recentLimit,
        related_limit: opts.relatedLimit,
      }),
    );
  });

file
  .command("why")
  .description("Show the best current explanation for a file or line")
  .argument("<path>", "File path to query")
  .option("--line <n>", "Optional line number", parseInt)
  .option("--repository <path>", "Optional repository path override")
  .action(async (filePath: string, opts: Opts) => {
    output(
      await service.whyCode({
        path: filePath,
        line: opts.line,
        repository: opts.repository,
      }),
    );
  });

file
  .command("recent")
  .description("Show recent local history for a file")
  .argument("<path>", "File path to query")
  .option("--repository <path>", "Optional repository path override")
  .option("--limit <n>", "Max recent rows to return (default 10)", parseInt)
  .action(async (filePath: string, opts: Opts) => {
    output(
      await service.recentWorkOnPath({
        path: filePath,
        repository: opts.repository,
        limit: opts.limit,
      }),
    );
  });

program
  .command("sessions")
  .description("List recent sessions with stats (event count, tools, cost)")
  .option("--limit <n>", "Max sessions to return (default 20)", parseInt)
  .option(
    "--since <duration>",
    'Time filter: ISO date or relative like "24h", "7d", "30m"',
  )
  .action(async (opts: Opts) => {
    output(
      await service.listSessions({ limit: opts.limit, since: opts.since }),
    );
  });

const sessionSummaries = program
  .command("session-summaries")
  .description("Manage session summary enrichments");

sessionSummaries
  .command("regenerate")
  .description(
    "Mark scoped session summaries dirty so the enrichment worker regenerates them",
  )
  .option("--session <id>", "Regenerate one session")
  .option("--cwd <path>", "Regenerate summaries from this cwd")
  .option("--repository <path>", "Regenerate summaries from this repository")
  .option(
    "--since <time>",
    'Lower time bound: ISO date or relative like "24h", "7d", "30m"',
  )
  .option(
    "--before <time>",
    'Upper time bound: ISO date or relative like "2026-05-14T00:00:00Z"',
  )
  .option(
    "--by <field>",
    "Time field: activity, generated-at, or projected-at",
    "activity",
  )
  .option("--reason <reason>", "Structured regeneration reason", "manual")
  .option("--all", "Allow selecting all session summaries")
  .option("--stale-only", "Only select dirty/version/policy-stale summaries")
  .option("--dirty-only", "Only select summaries already marked dirty")
  .option("--clean-only", "Only select summaries not currently dirty")
  .option("--limit <n>", "Maximum summaries to select", parseInt)
  .option("--run", "Apply changes; default is dry-run")
  .action(async (opts: Opts) => {
    output(
      await service.regenerateSessionSummaries({
        sessionId: opts.session,
        cwd: opts.cwd,
        repository: opts.repository,
        since: opts.since,
        before: opts.before,
        by: opts.by,
        reason: opts.reason,
        all: opts.all === true,
        staleOnly: opts.staleOnly === true,
        dirtyOnly: opts.dirtyOnly === true,
        cleanOnly: opts.cleanOnly === true,
        dryRun: opts.run !== true,
        limit: opts.limit,
      }),
    );
  });

program
  .command("timeline")
  .description("Get messages and tool calls for a session")
  .argument("<session-id>", "The session ID to query")
  .option("--limit <n>", "Max messages to return (default 50)", parseInt)
  .option("--offset <n>", "Number of messages to skip", parseInt)
  .option("--full", "Return full content instead of truncated")
  .action(async (sessionId: string, opts: Opts) => {
    const result = await service.sessionTimeline({
      sessionId,
      limit: opts.limit,
      offset: opts.offset,
      fullPayloads: opts.full,
    });
    output(result);
  });

program
  .command("costs")
  .description("Token usage and cost breakdowns")
  .option(
    "--since <duration>",
    'Time filter: ISO date or relative like "24h", "7d"',
  )
  .option("--group-by <key>", "Group by: session, model, or day")
  .action(async (opts: Opts) => {
    output(
      await service.costBreakdown({ since: opts.since, groupBy: opts.groupBy }),
    );
  });

program
  .command("summary")
  .description("Activity summary — sessions, prompts, tools, files, costs")
  .option(
    "--since <duration>",
    'Time window (default "24h"). ISO date or relative like "24h", "7d"',
  )
  .action(async (opts: Opts) => {
    output(await service.activitySummary({ since: opts.since }));
  });

program
  .command("plans")
  .description("List plans created by Claude Code (from ExitPlanMode events)")
  .option("--session <id>", "Filter to a specific session")
  .option(
    "--since <duration>",
    'Time filter: ISO date or relative like "24h", "7d"',
  )
  .option("--limit <n>", "Max plans to return (default 20)", parseInt)
  .action(async (opts: Opts) => {
    output(
      await service.listPlans({
        session_id: opts.session,
        since: opts.since,
        limit: opts.limit,
      }),
    );
  });

program
  .command("search")
  .description("Full-text search across events and messages")
  .argument("<query>", "Text to search for")
  .option("--types <types...>", "Filter to specific event types")
  .option(
    "--since <duration>",
    'Time filter: ISO date or relative like "24h", "7d"',
  )
  .option("--limit <n>", "Max results (default 20)", parseInt)
  .option("--offset <n>", "Number of results to skip", parseInt)
  .option("--full", "Return full payloads instead of truncated")
  .action(async (query: string, opts: Opts) => {
    const result = await service.search({
      query,
      eventTypes: opts.types,
      since: opts.since,
      limit: opts.limit,
      offset: opts.offset,
      fullPayloads: opts.full,
    });
    output(result);
  });

program
  .command("print")
  .alias("event")
  .description("Get full details for a record by source and ID")
  .argument("<source>", "Source: hook, otel, or message")
  .argument("<id>", "Record ID from search/timeline results")
  .action(async (source: string, id: string) => {
    if (source !== "hook" && source !== "otel" && source !== "message") {
      console.error(
        `Invalid source: ${source} (must be "hook", "otel", or "message")`,
      );
      process.exit(1);
    }
    const result = await service.print({ source, id: parseInt(id, 10) });
    if (!result) {
      console.error(`No ${source} record found with id ${id}`);
      process.exit(1);
    }
    output(result);
  });

program
  .command("query")
  .description("Execute a read-only SQL query against the database")
  .argument("<sql>", "SQL query (SELECT/WITH/PRAGMA only)")
  .action(async (sql: string) => {
    try {
      output(await service.rawQuery(sql));
    } catch (err: unknown) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("db-stats")
  .description("Show database row counts for each table")
  .action(async () => {
    output(await service.dbStats());
  });

program
  .command("scan")
  .description(
    "Trigger a synchronous scan pass on the running server (picks up new session JSONL files and regenerates summaries)",
  )
  .option("--no-summaries", "Skip summary generation")
  .action(async (opts: { summaries?: boolean }) => {
    const result = await service.scan({ summaries: opts.summaries });
    console.log(
      `Scanned ${result.filesScanned} files, ${result.newTurns} new turns, ${result.summariesUpdated} summaries updated`,
    );
  });

program
  .command("refresh-pricing")
  .description("Fetch latest model pricing from LiteLLM")
  .action(async () => {
    console.log("Fetching pricing from LiteLLM...");
    const result = await service.refreshPricing();
    if (result && typeof result === "object" && "models" in result) {
      const models = (result as { models: Record<string, unknown> }).models;
      console.log(`Cached pricing for ${Object.keys(models).length} models`);
    } else if (result && typeof result === "object" && "ok" in result) {
      console.log("Pricing refreshed.");
    } else {
      console.error("Failed to fetch pricing");
      process.exit(1);
    }
  });

const permissions = program
  .command("permissions")
  .description("Show or apply permission rules");

permissions
  .command("show", { isDefault: true })
  .description("Show current approvals and allowed tools/commands")
  .action(() => {
    output(permissionsShow());
  });

permissions
  .command("preview")
  .description(
    "Compute the diff against allowed.json without writing. Reads JSON payload from stdin.",
  )
  .action(async () => {
    const input = JSON.parse(await readStdin());
    output(permissionsPreview(input));
  });

permissions
  .command("apply")
  .description("Apply permission rules (reads JSON payload from stdin)")
  .action(async () => {
    const input = JSON.parse(await readStdin());
    output(permissionsApply(input));
  });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

program.parseAsync().catch((err: unknown) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
