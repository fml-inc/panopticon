#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { config, ensureDataDir } from "./config.js";
import { getDb, closeDb } from "./db/schema.js";
import { dbStats } from "./db/query.js";

const command = process.argv[2];

function printUsage() {
  console.log(`
panopticon - Observability for Claude Code

Usage:
  panopticon install   Build, register plugin, init DB, configure shell
  panopticon start     Start the OTLP receiver (background)
  panopticon stop      Stop the OTLP receiver
  panopticon status    Show receiver status and database stats
  panopticon help      Show this help message
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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

async function install() {
  const pluginRoot = getPluginRoot();
  const pluginJson = readJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
  const version = pluginJson?.version ?? "0.1.0";

  console.log("Installing panopticon...\n");

  // 1. Build
  console.log("[1/5] Building...");
  try {
    execSync("npx tsup", { cwd: pluginRoot, stdio: "pipe" });
    console.log("      Built successfully.\n");
  } catch (err: any) {
    console.error("      Build failed:", err.stderr?.toString() ?? err.message);
    process.exit(1);
  }

  // 2. Initialize database
  console.log("[2/5] Initializing database...");
  ensureDataDir();
  getDb();
  closeDb();
  console.log(`      ${config.dbPath}\n`);

  // 3. Set up local marketplace
  console.log("[3/5] Setting up local marketplace...");
  fs.mkdirSync(path.join(config.marketplaceDir, ".claude-plugin"), { recursive: true });
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
  const marketplaceLink = path.join(config.marketplaceDir, "panopticon");
  try { fs.unlinkSync(marketplaceLink); } catch {}
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
  console.log("[4/5] Registering plugin in Claude Code settings...");
  const settings = readJsonFile(config.claudeSettingsPath) ?? {};

  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces ?? {};
  settings.extraKnownMarketplaces["local-plugins"] = {
    source: { source: "directory", path: config.marketplaceDir },
  };

  settings.enabledPlugins = settings.enabledPlugins ?? {};
  settings.enabledPlugins["panopticon@local-plugins"] = true;

  writeJsonFile(config.claudeSettingsPath, settings);
  console.log(`      ${config.claudeSettingsPath}\n`);

  // 5. Configure shell environment
  console.log("[5/5] Configuring shell environment...");
  const shellRc = path.join(os.homedir(), process.env.SHELL?.includes("zsh") ? ".zshrc" : ".bashrc");
  const rcContent = fs.existsSync(shellRc) ? fs.readFileSync(shellRc, "utf-8") : "";

  const envBlock = [
    "",
    "# Panopticon — Claude Code observability",
    "export CLAUDE_CODE_ENABLE_TELEMETRY=1",
    `export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${config.otlpPort}`,
    "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
    "export OTEL_METRICS_EXPORTER=otlp",
    "export OTEL_LOGS_EXPORTER=otlp",
    "export OTEL_LOG_TOOL_DETAILS=1",
    "export OTEL_LOG_USER_PROMPTS=1",
    "export OTEL_METRIC_EXPORT_INTERVAL=10000",
    "",
  ].join("\n");

  if (rcContent.includes("# Panopticon")) {
    console.log(`      Already configured in ${shellRc}\n`);
  } else {
    fs.appendFileSync(shellRc, envBlock);
    console.log(`      Added env vars to ${shellRc}\n`);
  }

  console.log("Done! Start a new Claude Code session to activate.\n");
  console.log("Verify with: panopticon status");
}

async function start() {
  ensureDataDir();

  // Check if already running
  if (fs.existsSync(config.pidFile)) {
    const pid = parseInt(fs.readFileSync(config.pidFile, "utf-8").trim());
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
  const serverScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "otlp",
    "server.js"
  );

  const child = spawn("node", [serverScript], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PANOPTICON_OTLP_PORT: String(config.otlpPort),
    },
  });

  // Wait briefly to check it started
  await new Promise<void>((resolve, reject) => {
    let stderr = "";

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start: ${err.message}`));
    });

    // Give it a moment to start or fail
    setTimeout(() => {
      if (child.pid) {
        fs.writeFileSync(config.pidFile, String(child.pid));
        child.unref();
        console.log(`OTLP receiver started (PID ${child.pid}) on :${config.otlpPort}`);
        resolve();
      } else {
        reject(new Error(`Failed to start: ${stderr}`));
      }
    }, 500);
  });
}

async function stop() {
  if (!fs.existsSync(config.pidFile)) {
    console.log("OTLP receiver is not running (no PID file)");
    return;
  }

  const pid = parseInt(fs.readFileSync(config.pidFile, "utf-8").trim());
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(config.pidFile);
    console.log(`OTLP receiver stopped (PID ${pid})`);
  } catch {
    fs.unlinkSync(config.pidFile);
    console.log("OTLP receiver was not running (stale PID file removed)");
  }
}

async function status() {
  // Check OTLP receiver
  let receiverRunning = false;
  let receiverPid: number | null = null;

  if (fs.existsSync(config.pidFile)) {
    receiverPid = parseInt(fs.readFileSync(config.pidFile, "utf-8").trim());
    try {
      process.kill(receiverPid, 0);
      receiverRunning = true;
    } catch {
      receiverRunning = false;
    }
  }

  console.log("Panopticon Status");
  console.log("=================");
  console.log();
  console.log(
    `OTLP Receiver: ${receiverRunning ? `running (PID ${receiverPid}, port ${config.otlpPort})` : "stopped"}`
  );
  console.log(`Database: ${config.dbPath}`);

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
