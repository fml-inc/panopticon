#!/usr/bin/env node

import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { config, ensureDataDir } from "./config.js";
import { pruneEstimate, pruneExecute } from "./db/prune.js";
import { dbStats } from "./db/query.js";
import { closeDb, getDb } from "./db/schema.js";
import { DAEMON_NAMES, type DaemonName, logPaths, openLogFd } from "./log.js";

const command = process.argv[2];

const CLAUDE_DESKTOP_CONFIG = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude_desktop_config.json",
);

function printUsage() {
  console.log(`
panopticon - Observability for Claude Code

Usage:
  panopticon install         Build, register plugin, init DB, configure shell
    --desktop                Install as MCP server for Claude Desktop instead
    --force                  Overwrite customized env vars with defaults
  panopticon start          Start OTLP receiver (background)
  panopticon stop           Stop OTLP receiver
  panopticon status         Show receiver status and database stats
  panopticon logs [daemon]  View daemon logs (otlp, mcp)
    -f, --follow             Follow log output (like tail -f)
    -n <lines>               Number of lines to show (default 50)
  panopticon prune          Delete old data from the database
    --older-than 30d         Max age (default: 30d)
    --dry-run                Show estimate without deleting
    --vacuum                 Reclaim disk space after pruning
    --yes                    Skip confirmation prompt
  panopticon help           Show this help message

Note: Sync to FML backend is now handled by the fml-plugin.
      Run \`fml-plugin sync setup\` to configure.
`);
}

function getPluginRoot(): string {
  // Walk up from the CLI script to find the plugin root (directory containing .claude-plugin/)
  // fileURLToPath handles Windows drive-letter paths correctly (unlike URL.pathname)
  let dir = path.dirname(fileURLToPath(import.meta.url));
  // We're in dist/, go up one level
  dir = path.resolve(dir, "..");
  return dir;
}

function readJsonFile(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function install() {
  const desktop = hasFlag("--desktop");
  const pluginRoot = getPluginRoot();

  if (desktop) {
    await installDesktop(pluginRoot);
  } else {
    await installClaudeCode(pluginRoot);
  }
}

async function installDesktop(pluginRoot: string) {
  const skipBuild = hasFlag("--skip-build");
  const totalSteps = skipBuild ? 3 : 4;
  let step = 0;

  console.log("Installing panopticon for Claude Desktop...\n");

  // 1. Build
  if (!skipBuild) {
    step++;
    console.log(`[${step}/${totalSteps}] Building...`);
    try {
      execSync("npx tsup", { cwd: pluginRoot, stdio: "pipe" });
      console.log("      Built successfully.\n");
    } catch (err: any) {
      console.error(
        "      Build failed:",
        err.stderr?.toString() ?? err.message,
      );
      process.exit(1);
    }
  }

  // 2. Initialize database
  step++;
  console.log(`[${step}/${totalSteps}] Initializing database...`);
  ensureDataDir();
  getDb();
  closeDb();
  console.log(`      ${config.dbPath}\n`);

  // 3. Register MCP server in Claude Desktop config
  step++;
  console.log(
    `[${step}/${totalSteps}] Registering MCP server in Claude Desktop...`,
  );

  const serverBin = path.join(pluginRoot, "bin", "mcp-server");
  const desktopConfig = readJsonFile(CLAUDE_DESKTOP_CONFIG) ?? {};
  desktopConfig.mcpServers = desktopConfig.mcpServers ?? {};

  desktopConfig.mcpServers.panopticon = {
    command: "node",
    args: [serverBin],
  };

  writeJsonFile(CLAUDE_DESKTOP_CONFIG, desktopConfig);
  console.log(`      ${CLAUDE_DESKTOP_CONFIG}\n`);

  // 4. Configure shell environment (OTLP vars needed for telemetry)
  step++;
  console.log(`[${step}/${totalSteps}] Configuring shell environment...`);
  configureShellEnv(false);

  console.log("Done! Restart Claude Desktop to activate.\n");
}

async function installClaudeCode(pluginRoot: string) {
  const force = hasFlag("--force");
  const pluginJson = readJsonFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
  );
  const version = pluginJson?.version ?? "0.1.0";

  console.log("Installing panopticon...\n");

  // 1. Build
  if (!hasFlag("--skip-build")) {
    console.log("[1/7] Building...");
    try {
      execSync("npx tsup", { cwd: pluginRoot, stdio: "pipe" });
      console.log("      Built successfully.\n");
    } catch (err: any) {
      console.error(
        "      Build failed:",
        err.stderr?.toString() ?? err.message,
      );
      process.exit(1);
    }

    // Re-exec with the freshly built code so steps 2-7 use the new version
    const args = process.argv.slice(1).concat("--skip-build");
    if (force) args.push("--force");
    const result = spawnSync(process.argv[0], args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
    process.exit(result.status ?? 1);
  }

  // 2. Initialize database
  console.log("[2/7] Initializing database...");
  ensureDataDir();
  getDb();
  closeDb();
  console.log(`      ${config.dbPath}\n`);

  // 3. Set up local marketplace
  console.log("[3/7] Setting up local marketplace...");
  fs.mkdirSync(path.join(config.marketplaceDir, ".claude-plugin"), {
    recursive: true,
  });
  writeJsonFile(config.marketplaceManifest, {
    name: "local-plugins",
    owner: { name: os.userInfo().username },
    plugins: [
      {
        name: "panopticon",
        source: "./panopticon",
        description: pluginJson?.description ?? "Observability for Claude Code",
      },
    ],
  });

  // Symlink plugin into marketplace
  // Use 'junction' on Windows — works without admin privileges for directories
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  const marketplaceLink = path.join(config.marketplaceDir, "panopticon");
  try {
    fs.unlinkSync(marketplaceLink);
  } catch {}
  fs.symlinkSync(pluginRoot, marketplaceLink, symlinkType);

  // Copy to plugin cache (Claude Code reads from cache, not marketplace directly)
  const cacheDir = path.join(config.pluginCacheDir, version);
  fs.mkdirSync(cacheDir, { recursive: true });
  // Sync all necessary files to cache
  const filesToSync = [
    ".claude-plugin",
    "hooks",
    "bin",
    "dist",
    "skills",
    "node_modules",
    "package.json",
    "package-lock.json",
  ];
  for (const name of filesToSync) {
    const src = path.join(pluginRoot, name);
    const dest = path.join(cacheDir, name);
    if (fs.existsSync(src)) {
      fs.rmSync(dest, { recursive: true, force: true });
      // dereference: follow symlinks and copy actual files (pnpm uses symlinks
      // inside node_modules which require admin privileges to recreate on Windows)
      fs.cpSync(src, dest, { recursive: true, dereference: true });
    }
  }
  console.log(`      Marketplace: ${config.marketplaceDir}`);
  console.log(`      Cache: ${cacheDir}\n`);

  // 4. Register in Claude Code settings
  console.log("[4/7] Registering plugin in Claude Code settings...");
  const settings = readJsonFile(config.claudeSettingsPath) ?? {};

  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces ?? {};
  settings.extraKnownMarketplaces["local-plugins"] = {
    source: { source: "directory", path: config.marketplaceDir },
  };

  settings.enabledPlugins = settings.enabledPlugins ?? {};
  settings.enabledPlugins["panopticon@local-plugins"] = true;

  writeJsonFile(config.claudeSettingsPath, settings);
  console.log(`      ${config.claudeSettingsPath}\n`);

  // 5. Symlink CLI into PATH
  console.log("[5/7] Adding CLI to PATH...");
  const localBin = path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });
  const symlinks: Record<string, string> = {
    panopticon: path.join(pluginRoot, "bin", "panopticon"),
  };
  for (const [name, target] of Object.entries(symlinks)) {
    const link = path.join(localBin, name);
    try {
      fs.unlinkSync(link);
    } catch {}
    // 'file' symlinks on Windows require admin; use 'junction' for dirs or copy for files
    if (process.platform === "win32") {
      fs.copyFileSync(target, link);
    } else {
      fs.symlinkSync(target, link);
    }
  }
  console.log(`      Linked panopticon -> ${localBin}/panopticon\n`);

  // 6. Install skills
  console.log("[6/7] Installing skills...");
  const skillsSource = path.join(pluginRoot, "skills");
  const skillsTarget = path.join(os.homedir(), ".claude", "skills");
  if (fs.existsSync(skillsSource)) {
    for (const skillName of fs.readdirSync(skillsSource)) {
      const src = path.join(skillsSource, skillName);
      if (!fs.statSync(src).isDirectory()) continue;
      const dest = path.join(skillsTarget, skillName);
      fs.mkdirSync(dest, { recursive: true });
      for (const file of fs.readdirSync(src)) {
        fs.cpSync(path.join(src, file), path.join(dest, file), {
          recursive: true,
        });
      }
      console.log(`      ${skillName} -> ${dest}`);
    }
  }
  console.log();

  // 7. Configure shell environment
  console.log("[7/7] Configuring shell environment...");
  configureShellEnv(force);

  console.log("Done! Start a new Claude Code session to activate.\n");
  console.log("Verify with: panopticon status");
}

function configureShellEnv(force: boolean) {
  const shellRc = path.join(
    os.homedir(),
    process.env.SHELL?.includes("zsh") ? ".zshrc" : ".bashrc",
  );
  const rcContent = fs.existsSync(shellRc)
    ? fs.readFileSync(shellRc, "utf-8")
    : "";

  // Lines we own — identified by exact variable name or comment marker
  const PANOPTICON_VARS = [
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_METRIC_EXPORT_INTERVAL",
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

  // Desired lines keyed by variable name (order preserved)
  const wantedLines: [string, string][] = [
    ["# >>> panopticon >>>", "# >>> panopticon >>>"],
    ["CLAUDE_CODE_ENABLE_TELEMETRY", "export CLAUDE_CODE_ENABLE_TELEMETRY=1"],
    [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      `export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${config.otlpPort}`,
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
    ["# <<< panopticon <<<", "# <<< panopticon <<<"],
  ];

  // Only add PATH entry if ~/.local/bin isn't already on PATH in the file
  if (!rcContent.includes(".local/bin")) {
    wantedLines.splice(1, 0, [
      "PATH_LOCAL_BIN",
      'export PATH="$HOME/.local/bin:$PATH"',
    ]);
  }

  const lines = rcContent.split("\n");
  const seen = new Set<string>(); // keys we already replaced in-place
  let lastPanopticonIdx = -1;

  // Pass 1: replace existing panopticon lines in-place with their updated values
  for (let i = 0; i < lines.length; i++) {
    if (!isPanopticonLine(lines[i])) continue;
    lastPanopticonIdx = i;

    // Match this line to a wanted key
    const match = wantedLines.find(([key]) => {
      if (key.startsWith("#")) return lines[i].trim().startsWith(key);
      return (
        lines[i].trim() === `export ${key}` ||
        lines[i].trim().startsWith(`export ${key}=`)
      );
    });
    if (match) {
      if (!force && lines[i].trim() !== match[1] && !match[0].startsWith("#")) {
        console.log(`      ⚠ Keeping existing value: ${lines[i].trim()}`);
        console.log(`        (default would be: ${match[1]})`);
        console.log("        (use --force to overwrite)");
      } else {
        lines[i] = match[1];
      }
      seen.add(match[0]);
    } else {
      // Legacy line we no longer need (e.g. old comment) — blank it out
      lines[i] = "";
    }
  }

  // Pass 2: collect any new lines not already present
  const newLines = wantedLines
    .filter(([key]) => !seen.has(key))
    .map(([, val]) => val);

  if (newLines.length > 0) {
    if (lastPanopticonIdx >= 0) {
      // Insert after last existing panopticon line
      lines.splice(lastPanopticonIdx + 1, 0, ...newLines);
    } else {
      // No existing lines — append at end
      lines.push("", ...newLines, "");
    }
  }

  fs.writeFileSync(shellRc, lines.join("\n"));
  console.log(
    `      ${lastPanopticonIdx >= 0 ? "Updated" : "Added"} env vars in ${shellRc}\n`,
  );
}

async function start() {
  ensureDataDir();

  // Check if already running
  if (fs.existsSync(config.pidFile)) {
    const pid = parseInt(fs.readFileSync(config.pidFile, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0); // Check if process exists
      console.log(`OTLP receiver already running (PID ${pid})`);
      return;
    } catch {
      // PID file stale, remove it
      fs.unlinkSync(config.pidFile);
    }
  }

  // Find the OTLP server script
  // Use fileURLToPath to handle Windows drive-letter paths correctly
  const serverScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "otlp",
    "server.js",
  );

  const logFd = openLogFd("otlp");

  const child = spawn("node", [serverScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PANOPTICON_OTLP_PORT: String(config.otlpPort),
    },
  });

  // Wait briefly to check it started
  await new Promise<void>((resolve, reject) => {
    child.on("error", (err) => {
      reject(new Error(`Failed to start: ${err.message}`));
    });

    // Give it a moment to start or fail
    setTimeout(() => {
      if (child.pid) {
        fs.writeFileSync(config.pidFile, String(child.pid));
        child.unref();
        fs.closeSync(logFd);
        console.log(
          `OTLP receiver started (PID ${child.pid}) on :${config.otlpPort}`,
        );
        console.log(`Log: ${logPaths.otlp}`);
        resolve();
      } else {
        fs.closeSync(logFd);
        reject(new Error("Failed to start OTLP receiver"));
      }
    }, 500);
  });
}

async function stop() {
  // Stop the OTLP receiver
  if (!fs.existsSync(config.pidFile)) {
    console.log("OTLP receiver is not running (no PID file)");
    return;
  }

  const pid = parseInt(fs.readFileSync(config.pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(config.pidFile);
    console.log(`OTLP receiver stopped (PID ${pid})`);
  } catch {
    fs.unlinkSync(config.pidFile);
    console.log("OTLP receiver was not running (stale PID file removed)");
  }
}

function isProcessRunning(pidFile: string): {
  running: boolean;
  pid: number | null;
} {
  if (!fs.existsSync(pidFile)) return { running: false, pid: null };
  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid };
  }
}

async function status() {
  const receiver = isProcessRunning(config.pidFile);

  console.log("Panopticon Status");
  console.log("=================");
  console.log();
  console.log(
    `OTLP Receiver: ${receiver.running ? `running (PID ${receiver.pid}, port ${config.otlpPort})` : "stopped"}`,
  );
  console.log(`Database: ${config.dbPath}`);

  // Log files
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

    try {
      const stats = dbStats();
      console.log();
      console.log("Row counts:");
      console.log(`  otel_logs:    ${stats.otel_logs}`);
      console.log(`  otel_metrics: ${stats.otel_metrics}`);
      console.log(`  hook_events:  ${stats.hook_events}`);
    } catch {
      console.log("  (could not read database)");
    } finally {
      closeDb();
    }
  } else {
    console.log("Database: not initialized (run 'panopticon setup')");
  }
}

// ============================================================================
// PRUNE COMMAND
// ============================================================================

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

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getFlagValue(flag: string, defaultValue: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultValue;
  return process.argv[idx + 1];
}

async function prune() {
  const olderThan = getFlagValue("--older-than", "30d");
  const dryRun = hasFlag("--dry-run");
  const vacuum = hasFlag("--vacuum");
  const yes = hasFlag("--yes");

  const ageMs = parseAge(olderThan);
  const cutoffMs = Date.now() - ageMs;
  const cutoffDate = new Date(cutoffMs).toISOString();

  console.log(`Pruning rows older than ${olderThan} (before ${cutoffDate})`);
  console.log();

  try {
    const estimate = pruneEstimate(cutoffMs);
    const total =
      estimate.otel_logs + estimate.otel_metrics + estimate.hook_events;

    console.log("Rows to delete:");
    console.log(`  otel_logs:    ${estimate.otel_logs}`);
    console.log(`  otel_metrics: ${estimate.otel_metrics}`);
    console.log(`  hook_events:  ${estimate.hook_events}`);
    console.log(`  total:        ${total}`);
    console.log();

    if (total === 0) {
      console.log("Nothing to prune.");
      return;
    }

    if (dryRun) {
      console.log("Dry run — no rows deleted.");
      return;
    }

    if (!yes) {
      const answer = await prompt("Proceed with deletion? [y/N] ");
      if (answer.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
    }

    const result = pruneExecute(cutoffMs);
    console.log("Deleted:");
    console.log(`  otel_logs:    ${result.otel_logs}`);
    console.log(`  otel_metrics: ${result.otel_metrics}`);
    console.log(`  hook_events:  ${result.hook_events}`);

    if (vacuum) {
      console.log("\nReclaiming disk space...");
      const db = getDb();
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      console.log("Done.");
    }
  } finally {
    closeDb();
  }
}

function prompt(question: string): Promise<string> {
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
  const CHUNK_SIZE = 64 * 1024; // 64 KB — read from end to avoid loading entire file
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return [];

    const readStart = Math.max(0, size - CHUNK_SIZE);
    const buf = Buffer.alloc(size - readStart);
    fs.readSync(fd, buf, 0, buf.length, readStart);
    const chunk = buf.toString("utf-8");

    const lines = chunk.split("\n");
    // Remove trailing empty line from final newline
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    // If we didn't read from the start, the first line is likely partial — drop it
    if (readStart > 0 && lines.length > 0) lines.shift();
    return lines.slice(-n);
  } finally {
    fs.closeSync(fd);
  }
}

async function logs() {
  const daemonArg = process.argv[3] as DaemonName | undefined;
  const follow = hasFlag("-f") || hasFlag("--follow");
  const numLines = parseInt(getFlagValue("-n", "50"), 10);

  // Validate daemon name
  if (daemonArg && !DAEMON_NAMES.includes(daemonArg)) {
    console.error(`Unknown daemon: ${daemonArg}`);
    console.log(`Available: ${DAEMON_NAMES.join(", ")}`);
    process.exit(1);
  }

  const daemon = daemonArg ?? "otlp";
  const logPath = logPaths[daemon];

  if (!fs.existsSync(logPath)) {
    console.log(`No logs yet for ${daemon} (${logPath})`);
    return;
  }

  // Print last N lines
  const lines = tailLines(logPath, numLines);
  for (const line of lines) {
    console.log(line);
  }

  // Follow mode: watch for new content
  if (follow) {
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
        // File was truncated/rotated, reset
        pos = 0;
      }
    });
    // Keep process alive
    await new Promise(() => {});
  }
}

async function main() {
  switch (command) {
    case "install":
    case "setup":
      await install();
      break;
    case "start":
      await start();
      break;
    case "stop":
      await stop();
      break;
    case "status":
      await status();
      break;
    case "logs":
    case "log":
      await logs();
      break;
    case "prune":
      await prune();
      break;
    case "sync":
      console.log(
        "Sync has been migrated to the fml-plugin. Run `fml-plugin sync setup` to configure.",
      );
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
