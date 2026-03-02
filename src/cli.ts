#!/usr/bin/env node

import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { config, ensureDataDir } from "./config.js";
import { pruneEstimate, pruneExecute } from "./db/prune.js";
import { dbStats } from "./db/query.js";
import { closeDb, getDb } from "./db/schema.js";
import { DAEMON_NAMES, type DaemonName, logPaths, openLogFd } from "./log.js";
import { resolveGitHubToken } from "./sync/client.js";
import type { SyncTarget } from "./sync/daemon.js";
import {
  readWatermark,
  resetWatermarks,
  resetWatermarksForTarget,
  watermarkKey,
} from "./sync/state.js";

const command = process.argv[2];
const subcommand = process.argv[3];
const cliFlags = new Set(process.argv.slice(3));

function printUsage() {
  console.log(`
panopticon - Observability for Claude Code & Gemini CLI

Usage:
  panopticon install         Build, register plugin/hooks, init DB, configure shell
    --target <target>        Target CLI: claude, gemini, all (default: claude)
    --force                  Overwrite customized env vars with defaults
  panopticon start          Start the OTLP receiver (background)
    -f, --force              Kill existing process on port conflict and restart
  panopticon stop           Stop the OTLP receiver
  panopticon status         Show receiver status and database stats
  panopticon logs [daemon]  View daemon logs (otlp, sync, mcp)
    -f, --follow             Follow log output (like tail -f)
    -n <lines>               Number of lines to show (default 50)
  panopticon doctor         Analyze system, daemons, logs, and database health
  panopticon sync setup     Configure sync to FML backend
  panopticon prune          Delete old data from the database
    --older-than 30d         Max age (default: 30d)
    --synced-only            Only delete rows already synced
    --dry-run                Show estimate without deleting
    --vacuum                 Reclaim disk space after pruning
    --yes                    Skip confirmation prompt
  panopticon web [start]    Start the web dashboard (background)
    -f, --force              Kill existing process on port conflict
    -p, --port <port>        Port (default: 3000, or PANOPTICON_WEB_PORT)
    --host <host>            Host (default: 0.0.0.0, or PANOPTICON_WEB_HOST)
  panopticon web stop       Stop the web dashboard
  panopticon web status     Show web dashboard status
  panopticon sync start     Start the sync daemon (background)
  panopticon sync stop      Stop the sync daemon
  panopticon sync status    Show sync daemon state and watermarks
  panopticon sync reset [target]  Reset sync watermarks (all or per-target)
  panopticon help           Show this help message
`);
}

function getPluginRoot(): string {
  // Walk up from the CLI script to find the plugin root (directory containing .claude-plugin/)
  let dir = path.dirname(new URL(import.meta.url).pathname);
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
  const force = hasFlag("--force");
  const target = getFlagValue("--target", "all");
  if (!["claude", "gemini", "all"].includes(target)) {
    console.error(`Invalid target: ${target}. Must be claude, gemini, or all.`);
    process.exit(1);
  }

  const pluginRoot = getPluginRoot();
  const pluginJson = readJsonFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
  );
  if (pluginJson?.name && pluginJson.name !== "panopticon") {
    console.error(
      `ERROR: .claude-plugin/plugin.json has name "${pluginJson.name}" instead of "panopticon".`,
    );
    console.error(
      "Another plugin installer may have overwritten it. Restoring from git...",
    );
    try {
      execSync("git checkout .claude-plugin/plugin.json", {
        cwd: pluginRoot,
        stdio: "pipe",
      });
      Object.assign(
        pluginJson,
        readJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json")),
      );
      console.log("      Restored successfully.\n");
    } catch {
      console.error(
        "      Could not restore. Please run: git checkout .claude-plugin/plugin.json",
      );
      process.exit(1);
    }
  }
  const version = pluginJson?.version ?? "0.1.0";

  console.log(`Installing panopticon (target: ${target})...\n`);

  // 1. Build
  if (!hasFlag("--skip-build")) {
    console.log("[1/6] Building...");
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

    // Re-exec with the freshly built code so steps 2-6 use the new version
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
  console.log("[2/6] Initializing database...");
  ensureDataDir();
  getDb();
  closeDb();
  console.log(`      ${config.dbPath}\n`);

  if (target === "claude" || target === "all") {
    // 3. Set up local marketplace
    console.log("[3/6] Setting up local marketplace (Claude)...");
    fs.mkdirSync(path.join(config.marketplaceDir, ".claude-plugin"), {
      recursive: true,
    });

    let existingManifest: any = {
      name: "local-plugins",
      owner: { name: os.userInfo().username },
      plugins: [],
    };
    if (fs.existsSync(config.marketplaceManifest)) {
      try {
        existingManifest = JSON.parse(
          fs.readFileSync(config.marketplaceManifest, "utf-8"),
        );
      } catch {}
    }

    if (!existingManifest.plugins.some((p: any) => p.name === "panopticon")) {
      existingManifest.plugins.push({
        name: "panopticon",
        source: "./panopticon",
        description: pluginJson?.description ?? "Observability for Claude Code",
      });
    }

    writeJsonFile(config.marketplaceManifest, existingManifest);

    // Symlink plugin into marketplace
    const marketplaceLink = path.join(config.marketplaceDir, "panopticon");
    try {
      fs.unlinkSync(marketplaceLink);
    } catch {}
    fs.symlinkSync(pluginRoot, marketplaceLink);

    // Copy to plugin cache (Claude Code reads from cache, not marketplace directly)
    const cacheDir = path.join(config.pluginCacheDir, version);
    fs.mkdirSync(cacheDir, { recursive: true });
    // Sync all necessary files to cache
    const filesToSync = [
      ".claude-plugin",
      "hooks",
      "bin",
      "dist",
      "node_modules",
      "package.json",
      "package-lock.json",
    ];
    for (const name of filesToSync) {
      const src = path.join(pluginRoot, name);
      const dest = path.join(cacheDir, name);
      if (fs.existsSync(src)) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
      }
    }
    console.log(`      Marketplace: ${config.marketplaceDir}`);
    console.log(`      Cache: ${cacheDir}\n`);

    // 4. Register in Claude Code settings
    console.log("[4/6] Registering plugin in Claude Code settings...");
    const settings = readJsonFile(config.claudeSettingsPath) ?? {};

    settings.extraKnownMarketplaces = settings.extraKnownMarketplaces ?? {};
    settings.extraKnownMarketplaces["local-plugins"] = {
      source: { source: "directory", path: config.marketplaceDir },
    };

    settings.enabledPlugins = settings.enabledPlugins ?? {};
    settings.enabledPlugins["panopticon@local-plugins"] = true;

    writeJsonFile(config.claudeSettingsPath, settings);
    console.log(`      ${config.claudeSettingsPath}\n`);
  } else {
    console.log("[3/6] Skipping Claude Code marketplace setup...");
    console.log("[4/6] Skipping Claude Code settings registration...\n");
  }

  if (target === "gemini" || target === "all") {
    console.log("[4a/6] Registering hooks in Gemini CLI settings...");
    const geminiSettings = readJsonFile(config.geminiSettingsPath) ?? {};
    geminiSettings.hooks = geminiSettings.hooks || {};

    const events = [
      "SessionStart",
      "SessionEnd",
      "BeforeTool",
      "AfterTool",
      "BeforeToolSelection",
      "BeforeAgent",
      "AfterAgent",
      "BeforeModel",
      "AfterModel",
    ];

    for (const event of events) {
      geminiSettings.hooks[event] = geminiSettings.hooks[event] || [];
      // Remove any existing panopticon hooks
      geminiSettings.hooks[event] = geminiSettings.hooks[event]
        .map((group: any) => ({
          ...group,
          hooks: group.hooks.filter((h: any) => h.name !== "panopticon-hook"),
        }))
        .filter((group: any) => group.hooks.length > 0);

      // Add panopticon hook group
      geminiSettings.hooks[event].push({
        hooks: [
          {
            name: "panopticon-hook",
            type: "command",
            command: path.join(pluginRoot, "bin", "hook-handler"),
            timeout: 5000,
          },
        ],
      });
    }

    geminiSettings.hooksConfig = geminiSettings.hooksConfig || {};
    geminiSettings.hooksConfig.enabled = true;

    geminiSettings.mcpServers = geminiSettings.mcpServers || {};
    geminiSettings.mcpServers.panopticon = {
      command: "node",
      args: [path.join(pluginRoot, "bin", "mcp-server")],
    };

    geminiSettings.telemetry = geminiSettings.telemetry || {};
    Object.assign(geminiSettings.telemetry, {
      enabled: true,
      target: "local",
      useCollector: true,
      otlpEndpoint: `http://localhost:${config.otlpPort}`,
      otlpProtocol: "http",
      logPrompts: true,
    });

    writeJsonFile(config.geminiSettingsPath, geminiSettings);
    console.log(`      ${config.geminiSettingsPath}\n`);
  } else {
    console.log("[4a/6] Skipping Gemini CLI settings registration...\n");
  }

  // 5. Symlink CLI into PATH
  console.log("[5/6] Adding CLI to PATH...");
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
    fs.symlinkSync(target, link);
  }
  console.log(`      Linked panopticon -> ${localBin}/panopticon\n`);

  // 6. Configure shell environment
  console.log("[6/6] Configuring shell environment...");
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
  ];

  if (target === "claude" || target === "all") {
    wantedLines.push(
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
      [
        "OTEL_METRIC_EXPORT_INTERVAL",
        "export OTEL_METRIC_EXPORT_INTERVAL=10000",
      ],
    );
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
        `export GEMINI_TELEMETRY_OTLP_ENDPOINT=http://localhost:${config.otlpPort}`,
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

  const assistant =
    target === "all"
      ? "Claude Code and Gemini CLI"
      : target === "claude"
        ? "Claude Code"
        : "Gemini CLI";
  console.log(`Done! Start a new ${assistant} session to activate.\n`);
  console.log("Verify with: panopticon status");
}

/** Check if a port is in use. Returns the PID holding it (via lsof/ss) or true/null. */
function findPortHolder(port: number): number | null {
  try {
    // Try ss first (Linux)
    const out = execSync(
      `ss -tlnp 'sport = :${port}' 2>/dev/null || lsof -ti :${port} 2>/dev/null`,
      { encoding: "utf-8" },
    );
    // ss output contains pid=NNNN; lsof outputs bare PIDs
    const pidMatch = out.match(/pid=(\d+)/);
    if (pidMatch) return parseInt(pidMatch[1], 10);
    // lsof fallback: first line is a PID
    const firstLine = out.trim().split("\n")[0];
    const parsed = parseInt(firstLine, 10);
    if (!Number.isNaN(parsed)) return parsed;
    // Port is in use but couldn't extract PID
    return null;
  } catch {
    return null;
  }
}

function isPortInUse(port: number): boolean {
  try {
    execSync(`ss -tlnp 'sport = :${port}' 2>/dev/null | grep -q LISTEN`, {
      encoding: "utf-8",
    });
    return true;
  } catch {
    // ss failed or no match — try net.connect as fallback
    return false;
  }
}

async function start() {
  const force = cliFlags.has("-f") || cliFlags.has("--force");
  ensureDataDir();

  // Check if already running via PID file
  if (fs.existsSync(config.pidFile)) {
    const pid = parseInt(fs.readFileSync(config.pidFile, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      if (force) {
        process.kill(pid, "SIGTERM");
        console.log(`Killed existing OTLP receiver (PID ${pid})`);
        fs.unlinkSync(config.pidFile);
        // Brief wait for port release
        await new Promise((r) => setTimeout(r, 300));
      } else {
        console.log(`OTLP receiver already running (PID ${pid})`);
        return;
      }
    } catch {
      // PID file stale, remove it
      fs.unlinkSync(config.pidFile);
    }
  }

  // Check if port is held by an orphan process (no PID file match)
  if (isPortInUse(config.otlpPort)) {
    const holder = findPortHolder(config.otlpPort);
    if (force && holder) {
      try {
        process.kill(holder, "SIGTERM");
        console.log(
          `Killed orphan process (PID ${holder}) holding port ${config.otlpPort}`,
        );
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        console.error(
          `Failed to kill process ${holder} on port ${config.otlpPort}`,
        );
        process.exit(1);
      }
    } else {
      console.error(
        `Port ${config.otlpPort} is already in use${holder ? ` (PID ${holder})` : ""}.`,
      );
      console.error("Use `panopticon start -f` to force-kill and restart.");
      process.exit(1);
    }
  }

  // Find the OTLP server script
  const serverScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
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
  const syncDaemon = isProcessRunning(config.syncPidFile);
  const webInfo = readWebInfo();

  console.log("Panopticon Status");
  console.log("=================");
  console.log();
  console.log(
    `OTLP Receiver:  ${receiver.running ? `running (PID ${receiver.pid}, port ${config.otlpPort})` : "stopped"}`,
  );
  console.log(
    `Sync Daemon:    ${syncDaemon.running ? `running (PID ${syncDaemon.pid})` : "stopped"}`,
  );
  console.log(
    `Web Dashboard:  ${webInfo.running ? `running (PID ${webInfo.pid}, port ${webInfo.port})` : "stopped"}`,
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

      // Sync watermarks (per-target)
      const db = getDb();
      const maxHook =
        (
          db.prepare("SELECT MAX(id) as m FROM hook_events").get() as {
            m: number | null;
          }
        )?.m ?? 0;
      const maxLog =
        (
          db.prepare("SELECT MAX(id) as m FROM otel_logs").get() as {
            m: number | null;
          }
        )?.m ?? 0;
      const maxMetric =
        (
          db.prepare("SELECT MAX(id) as m FROM otel_metrics").get() as {
            m: number | null;
          }
        )?.m ?? 0;

      // Load targets from sync config
      let statusTargets: SyncTarget[] = [];
      if (fs.existsSync(config.syncConfigFile)) {
        try {
          const cfg = JSON.parse(
            fs.readFileSync(config.syncConfigFile, "utf-8"),
          );
          statusTargets =
            cfg.targets ??
            (cfg.urls
              ? cfg.urls.map((url: string, i: number) => ({
                  name: i === 0 ? "default" : `target-${i}`,
                  url,
                }))
              : []);
        } catch {}
      }

      console.log();
      if (statusTargets.length > 0) {
        console.log("Sync watermarks (synced / total):");
        for (const t of statusTargets) {
          const hookWm =
            readWatermark(watermarkKey("hook_events_last_id", t.name)) ?? 0;
          const logWm =
            readWatermark(watermarkKey("otel_logs_last_id", t.name)) ?? 0;
          const metricWm =
            readWatermark(watermarkKey("otel_metrics_last_id", t.name)) ?? 0;
          console.log(`  ${t.name}:`);
          console.log(`    hook_events:  ${hookWm} / ${maxHook}`);
          console.log(`    otel_logs:    ${logWm} / ${maxLog}`);
          console.log(`    otel_metrics: ${metricWm} / ${maxMetric}`);
        }
      }
    } catch {
      console.log("  (could not read database)");
    } finally {
      closeDb();
    }
  } else {
    console.log("Database: not initialized (run 'panopticon setup')");
  }

  if (fs.existsSync(config.syncConfigFile)) {
    try {
      const syncCfg = JSON.parse(
        fs.readFileSync(config.syncConfigFile, "utf-8"),
      );
      const cfgTargets: SyncTarget[] =
        syncCfg.targets ??
        (syncCfg.urls
          ? syncCfg.urls.map((url: string, i: number) => ({
              name: i === 0 ? "default" : `target-${i}`,
              url,
            }))
          : []);
      console.log();
      console.log("Sync config:");
      console.log(
        `  Targets: ${cfgTargets.map((t: SyncTarget) => `${t.name}(${t.url})`).join(", ") || "none"}`,
      );
      console.log(
        `  Allowed orgs: ${syncCfg.allowedOrgs?.join(", ") ?? "all"}`,
      );
      if (syncCfg.orgDirs && Object.keys(syncCfg.orgDirs).length > 0) {
        console.log(`  Org directories:`);
        for (const [dir, org] of Object.entries(syncCfg.orgDirs)) {
          console.log(`    ${dir} → ${org}`);
        }
      }
    } catch {}
  }
}

// ============================================================================
// DOCTOR COMMAND
// ============================================================================

async function checkPortOpen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, host);
  });
}

async function doctor() {
  console.log("Panopticon Doctor");
  console.log("=================\n");

  console.log("System Info");
  console.log("-----------");
  const isSandbox =
    process.env.SANDBOX !== undefined ||
    fs.existsSync(path.join(os.homedir(), ".sandbox-home"));
  console.log(`OS:       ${os.platform()} (${os.release()} ${os.arch()})`);
  console.log(`Node:     ${process.version}`);
  console.log(`Sandbox:  ${isSandbox ? "Yes" : "No"}`);
  console.log();

  console.log("Configuration");
  console.log("-------------");
  console.log(`Data Dir: ${config.dataDir}`);
  console.log(`DB Path:  ${config.dbPath}`);
  console.log(`OTLP Port: ${config.otlpPort} (Host: ${config.otlpHost})`);
  console.log(`Env PORT: ${process.env.PANOPTICON_OTLP_PORT || "not set"}`);
  console.log();

  console.log("Network & Daemons");
  console.log("-----------------");
  const receiver = isProcessRunning(config.pidFile);
  const syncDaemon = isProcessRunning(config.syncPidFile);
  const webDocInfo = readWebInfo();
  const isPortFree = await checkPortOpen(config.otlpPort, config.otlpHost);

  console.log(
    `OTLP Receiver:  ${receiver.running ? `Running (PID ${receiver.pid})` : "Stopped"}`,
  );
  console.log(
    `Sync Daemon:    ${syncDaemon.running ? `Running (PID ${syncDaemon.pid})` : "Stopped"}`,
  );
  console.log(
    `Web Dashboard:  ${webDocInfo.running ? `Running (PID ${webDocInfo.pid}, port ${webDocInfo.port})` : "Stopped"}`,
  );
  console.log(
    `Port ${config.otlpPort}:    ${isPortFree ? "Free (Available)" : "IN USE (Occupied)"}`,
  );
  if (!isPortFree && !receiver.running) {
    console.log(
      "  ⚠️  WARNING: Port is in use, but Panopticon PID file indicates it is stopped.",
    );
    console.log(
      "      This usually means another sandbox or host process is holding the port.",
    );
  }
  console.log();

  console.log("Database & Logs");
  console.log("---------------");
  if (!fs.existsSync(config.dbPath)) {
    console.log("Database: Not initialized");
  } else {
    try {
      const stats = dbStats();
      console.log(
        `Tables: hook_events (${stats.hook_events}), otel_logs (${stats.otel_logs}), otel_metrics (${stats.otel_metrics})`,
      );

      const db = getDb();
      // Fetch recent errors
      const errors = db
        .prepare(
          "SELECT * FROM otel_logs WHERE severity_text = 'ERROR' ORDER BY id DESC LIMIT 3",
        )
        .all() as any[];
      if (errors.length > 0) {
        console.log("\nRecent OTel Errors:");
        errors.forEach((err) => {
          console.log(`  [${err.id}] ${err.body?.slice(0, 100)}...`);
        });
      } else {
        console.log("Recent OTel Errors: None found");
      }

      // Fetch recent hooks
      const hooks = db
        .prepare(
          "SELECT event_type, tool_name, timestamp_ms FROM hook_events ORDER BY id DESC LIMIT 3",
        )
        .all() as any[];
      if (hooks.length > 0) {
        console.log("\nRecent Hook Events:");
        hooks.forEach((hook) => {
          console.log(
            `  - ${hook.event_type} ${hook.tool_name ? `(${hook.tool_name})` : ""} at ${new Date(hook.timestamp_ms).toISOString()}`,
          );
        });
      }
      closeDb();
    } catch (e: any) {
      console.log(`  ❌ Failed to query database: ${e.message}`);
    }
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
  const syncedOnly = hasFlag("--synced-only");
  const dryRun = hasFlag("--dry-run");
  const vacuum = hasFlag("--vacuum");
  const yes = hasFlag("--yes");

  const ageMs = parseAge(olderThan);
  const cutoffMs = Date.now() - ageMs;
  const cutoffDate = new Date(cutoffMs).toISOString();

  console.log(`Pruning rows older than ${olderThan} (before ${cutoffDate})`);
  if (syncedOnly) console.log("Mode: synced-only (respecting sync watermarks)");
  console.log();

  try {
    const estimate = pruneEstimate(cutoffMs, syncedOnly);
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

    const result = pruneExecute(cutoffMs, syncedOnly);
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

// ============================================================================
// SYNC SUBCOMMANDS
// ============================================================================

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

async function syncSetup() {
  console.log("Panopticon Sync Setup\n");

  const existingConfig = fs.existsSync(config.syncConfigFile)
    ? JSON.parse(fs.readFileSync(config.syncConfigFile, "utf-8"))
    : {};

  const defaultBackend = existingConfig.backendType || "fml";
  const backendInput = await prompt(
    `Backend type (fml, otlp) [${defaultBackend}]: `,
  );
  const backendType = backendInput || defaultBackend;
  if (backendType !== "fml" && backendType !== "otlp") {
    console.error("Backend type must be 'fml' or 'otlp'.");
    process.exit(1);
  }

  // Auto-migrate old urls[] to targets[] for display
  const existingTargets: SyncTarget[] =
    existingConfig.targets ??
    (existingConfig.urls
      ? existingConfig.urls.map((url: string, i: number) => ({
          name: i === 0 ? "default" : `target-${i}`,
          url,
        }))
      : []);

  // Multi-target prompts
  const targets: SyncTarget[] = [];
  let idx = 0;
  console.log(
    "Configure sync targets (press Enter with empty name to finish):",
  );
  while (true) {
    const existingTarget = existingTargets[idx];
    const defaultName = existingTarget?.name ?? (idx === 0 ? "default" : "");
    const nameInput = await prompt(
      `\nTarget name${defaultName ? ` [${defaultName}]` : ""}: `,
    );
    const name = nameInput || defaultName;
    if (!name) break;

    const defaultUrl = existingTarget?.url ?? "";
    const urlInput = await prompt(
      `  URL${defaultUrl ? ` [${defaultUrl}]` : ""}: `,
    );
    const url = urlInput || defaultUrl;
    if (!url) {
      console.error("  URL is required, skipping this target.");
      continue;
    }

    targets.push({ name, url });
    idx++;
  }

  if (targets.length === 0) {
    console.error("At least one target is required.");
    process.exit(1);
  }

  const defaultOrgs = existingConfig.allowedOrgs?.join(",") ?? "";
  const orgsInput = await prompt(
    `\nAllowed GitHub orgs (comma-separated, or * for all)${defaultOrgs ? ` [${defaultOrgs}]` : ""}: `,
  );
  const orgs = (orgsInput || defaultOrgs)
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  if (orgs.length === 0) {
    console.error("\nAt least one allowed org (or *) is required for syncing.");
    process.exit(1);
  }

  // Org directories (for attributing non-repo directories to an org)
  const existingOrgDirs = existingConfig.orgDirs ?? {};
  const existingOrgDirsStr = Object.entries(existingOrgDirs)
    .map(([dir, org]) => `${dir}=${org}`)
    .join(",");
  const orgDirsInput = await prompt(
    `Org directories (dir=org, comma-separated)${existingOrgDirsStr ? ` [${existingOrgDirsStr}]` : ""}: `,
  );
  const orgDirsRaw = orgDirsInput || existingOrgDirsStr;
  const orgDirs: Record<string, string> = {};
  if (orgDirsRaw) {
    for (const entry of orgDirsRaw
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)) {
      const eqIdx = entry.indexOf("=");
      if (eqIdx > 0) {
        orgDirs[entry.slice(0, eqIdx).trim()] = entry.slice(eqIdx + 1).trim();
      }
    }
  }

  // Verify GitHub token
  const token = resolveGitHubToken();
  if (!token) {
    console.error(
      "\nNo GitHub token found. Set PANOPTICON_GITHUB_TOKEN or install gh CLI.",
    );
    process.exit(1);
  }
  console.log("\nGitHub token: found");

  const syncConfig = {
    backendType,
    targets,
    allowedOrgs: orgs,
    orgDirs: Object.keys(orgDirs).length > 0 ? orgDirs : undefined,
    batchSize: existingConfig.batchSize ?? 20,
    intervalMs: existingConfig.intervalMs ?? 30000,
  };

  ensureDataDir();
  fs.writeFileSync(
    config.syncConfigFile,
    `${JSON.stringify(syncConfig, null, 2)}\n`,
  );
  console.log(`\nSync config written to ${config.syncConfigFile}`);
}

async function syncStart() {
  ensureDataDir();

  if (!fs.existsSync(config.syncConfigFile)) {
    console.error("No sync config found. Run 'panopticon sync setup' first.");
    process.exit(1);
  }

  // Check if already running
  const { running, pid } = isProcessRunning(config.syncPidFile);
  if (running) {
    console.log(`Sync daemon already running (PID ${pid})`);
    return;
  }
  // Clean up stale PID file
  if (pid !== null) {
    try {
      fs.unlinkSync(config.syncPidFile);
    } catch {}
  }

  const daemonScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "sync",
    "daemon.js",
  );

  const logFd = openLogFd("sync");

  const child = spawn("node", [daemonScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  await new Promise<void>((resolve, reject) => {
    child.on("error", (err) => {
      reject(new Error(`Failed to start sync daemon: ${err.message}`));
    });

    setTimeout(() => {
      if (child.pid) {
        child.unref();
        fs.closeSync(logFd);
        console.log(`Sync daemon started (PID ${child.pid})`);
        console.log(`Log: ${logPaths.sync}`);
        resolve();
      } else {
        fs.closeSync(logFd);
        reject(new Error("Failed to start sync daemon"));
      }
    }, 500);
  });
}

async function syncStop() {
  if (!fs.existsSync(config.syncPidFile)) {
    console.log("Sync daemon is not running (no PID file)");
    return;
  }

  const pid = parseInt(fs.readFileSync(config.syncPidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(config.syncPidFile);
    console.log(`Sync daemon stopped (PID ${pid})`);
  } catch {
    fs.unlinkSync(config.syncPidFile);
    console.log("Sync daemon was not running (stale PID file removed)");
  }
}

async function syncStatus() {
  const { running, pid } = isProcessRunning(config.syncPidFile);
  console.log(`Sync daemon: ${running ? `running (PID ${pid})` : "stopped"}`);

  let targets: SyncTarget[] = [];

  if (fs.existsSync(config.syncConfigFile)) {
    try {
      const syncCfg = JSON.parse(
        fs.readFileSync(config.syncConfigFile, "utf-8"),
      );
      // Support both old and new format for display
      targets =
        syncCfg.targets ??
        (syncCfg.urls
          ? syncCfg.urls.map((url: string, i: number) => ({
              name: i === 0 ? "default" : `target-${i}`,
              url,
            }))
          : []);
      console.log(
        `Targets: ${targets.map((t: SyncTarget) => `${t.name}(${t.url})`).join(", ") || "none"}`,
      );
      console.log(`Allowed orgs: ${syncCfg.allowedOrgs?.join(", ") ?? "all"}`);
      if (syncCfg.orgDirs && Object.keys(syncCfg.orgDirs).length > 0) {
        console.log(`Org directories:`);
        for (const [dir, org] of Object.entries(syncCfg.orgDirs)) {
          console.log(`  ${dir} → ${org}`);
        }
      }
      console.log(`Interval: ${syncCfg.intervalMs ?? 30000}ms`);
    } catch {}
  } else {
    console.log("No sync config found. Run 'panopticon sync setup'.");
    return;
  }

  if (fs.existsSync(config.dbPath)) {
    try {
      const db = getDb();

      const maxHook =
        (
          db.prepare("SELECT MAX(id) as m FROM hook_events").get() as {
            m: number | null;
          }
        )?.m ?? 0;
      const maxLog =
        (
          db.prepare("SELECT MAX(id) as m FROM otel_logs").get() as {
            m: number | null;
          }
        )?.m ?? 0;
      const maxMetric =
        (
          db.prepare("SELECT MAX(id) as m FROM otel_metrics").get() as {
            m: number | null;
          }
        )?.m ?? 0;

      console.log();
      for (const target of targets) {
        const hookWm =
          readWatermark(watermarkKey("hook_events_last_id", target.name)) ?? 0;
        const logWm =
          readWatermark(watermarkKey("otel_logs_last_id", target.name)) ?? 0;
        const metricWm =
          readWatermark(watermarkKey("otel_metrics_last_id", target.name)) ?? 0;

        console.log(`${target.name} → ${target.url}`);
        console.log(
          `  hook_events:  ${hookWm} / ${maxHook} (${maxHook - hookWm} pending)`,
        );
        console.log(
          `  otel_logs:    ${logWm} / ${maxLog} (${maxLog - logWm} pending)`,
        );
        console.log(
          `  otel_metrics: ${metricWm} / ${maxMetric} (${maxMetric - metricWm} pending)`,
        );
      }
    } catch {
      console.log("  (could not read database)");
    } finally {
      closeDb();
    }
  }
}

async function syncReset() {
  const targetName = process.argv[4]; // e.g. "panopticon sync reset dev"
  try {
    if (targetName) {
      resetWatermarksForTarget(targetName);
      console.log(`Sync watermarks for target "${targetName}" reset to 0.`);
    } else {
      resetWatermarks();
      console.log("All sync watermarks reset to 0.");
    }
  } finally {
    closeDb();
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

  const args = follow
    ? ["-f", `-n${numLines}`, logPath]
    : [`-n${numLines}`, logPath];
  const tail = spawn("tail", args, { stdio: "inherit" });
  tail.on("exit", (code) => process.exit(code ?? 0));
}

async function webStart() {
  const force = hasFlag("-f") || hasFlag("--force");
  const portOverride = getFlagValue("-p", "") || getFlagValue("--port", "");
  const hostOverride = getFlagValue("--host", "");
  const port = portOverride ? parseInt(portOverride, 10) : config.webPort;
  const host = hostOverride || config.webHost;

  ensureDataDir();

  // Check if already running via PID file
  if (fs.existsSync(config.webPidFile)) {
    const pid = parseInt(
      fs.readFileSync(config.webPidFile, "utf-8").trim(),
      10,
    );
    try {
      process.kill(pid, 0);
      if (force) {
        process.kill(pid, "SIGTERM");
        console.log(`Killed existing web dashboard (PID ${pid})`);
        fs.unlinkSync(config.webPidFile);
        await new Promise((r) => setTimeout(r, 300));
      } else {
        console.log(`Web dashboard already running (PID ${pid})`);
        return;
      }
    } catch {
      // PID file stale, remove it
      fs.unlinkSync(config.webPidFile);
    }
  }

  // Check if port is held by an orphan process
  if (isPortInUse(port)) {
    const holder = findPortHolder(port);
    if (force && holder) {
      try {
        process.kill(holder, "SIGTERM");
        console.log(
          `Killed orphan process (PID ${holder}) holding port ${port}`,
        );
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        console.error(`Failed to kill process ${holder} on port ${port}`);
        process.exit(1);
      }
    } else {
      console.error(
        `Port ${port} is already in use${holder ? ` (PID ${holder})` : ""}.`,
      );
      console.error("Use `panopticon web start -f` to force-kill and restart.");
      process.exit(1);
    }
  }

  const serverScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "web2",
    "server.js",
  );

  const logFd = openLogFd("web");

  const child = spawn("node", [serverScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.on("error", (err) => {
      reject(new Error(`Failed to start: ${err.message}`));
    });

    setTimeout(() => {
      if (child.pid) {
        fs.writeFileSync(config.webPidFile, `${child.pid}\n${port}\n${host}`);
        child.unref();
        fs.closeSync(logFd);
        const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
        console.log(`Web dashboard started (PID ${child.pid}) on ${url}`);
        console.log(`Log: ${logPaths.web}`);
        resolve();
      } else {
        fs.closeSync(logFd);
        reject(new Error("Failed to start web dashboard"));
      }
    }, 500);
  });
}

async function webStop() {
  if (!fs.existsSync(config.webPidFile)) {
    console.log("Web dashboard is not running (no PID file)");
    return;
  }

  const pid = parseInt(fs.readFileSync(config.webPidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(config.webPidFile);
    console.log(`Web dashboard stopped (PID ${pid})`);
  } catch {
    fs.unlinkSync(config.webPidFile);
    console.log("Web dashboard was not running (stale PID file removed)");
  }
}

function readWebInfo(): {
  pid: number | null;
  port: number;
  host: string;
  running: boolean;
} {
  if (!fs.existsSync(config.webPidFile)) {
    return {
      pid: null,
      port: config.webPort,
      host: config.webHost,
      running: false,
    };
  }
  const lines = fs.readFileSync(config.webPidFile, "utf-8").trim().split("\n");
  const pid = parseInt(lines[0], 10);
  const port = lines[1] ? parseInt(lines[1], 10) : config.webPort;
  const host = lines[2] || config.webHost;
  let running = false;
  try {
    process.kill(pid, 0);
    running = true;
  } catch {}
  return { pid, port, host, running };
}

async function webStatus() {
  const { running, pid, port, host } = readWebInfo();
  if (running) {
    const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
    console.log(`Web dashboard: running (PID ${pid}) on ${url}`);
  } else {
    console.log("Web dashboard: stopped");
  }
}

async function handleWeb() {
  switch (subcommand) {
    case "start":
    case undefined:
      await webStart();
      break;
    case "stop":
      await webStop();
      break;
    case "status":
      await webStatus();
      break;
    default:
      console.error(`Unknown web subcommand: ${subcommand}`);
      console.log("Available: start, stop, status");
      process.exit(1);
  }
}

async function handleSync() {
  switch (subcommand) {
    case "setup":
      await syncSetup();
      break;
    case "start":
      await syncStart();
      break;
    case "stop":
      await syncStop();
      break;
    case "status":
      await syncStatus();
      break;
    case "reset":
      await syncReset();
      break;
    default:
      console.error(`Unknown sync subcommand: ${subcommand ?? "(none)"}`);
      console.log("Available: setup, start, stop, status, reset");
      process.exit(1);
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
    case "doctor":
      await doctor();
      break;
    case "prune":
      await prune();
      break;
    case "web":
      await handleWeb();
      break;
    case "sync":
      await handleSync();
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
