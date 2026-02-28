#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { config, ensureDataDir } from "./config.js";
import { pruneEstimate, pruneExecute } from "./db/prune.js";
import { dbStats } from "./db/query.js";
import { closeDb, getDb } from "./db/schema.js";
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

function printUsage() {
  console.log(`
panopticon - Observability for Claude Code

Usage:
  panopticon install         Build, register plugin, init DB, configure shell
    --force                  Overwrite customized env vars with defaults
  panopticon start          Start the OTLP receiver (background)
  panopticon stop           Stop the OTLP receiver
  panopticon status         Show receiver status and database stats
  panopticon sync setup     Configure sync to FML backend
  panopticon prune          Delete old data from the database
    --older-than 30d         Max age (default: 30d)
    --synced-only            Only delete rows already synced
    --dry-run                Show estimate without deleting
    --vacuum                 Reclaim disk space after pruning
    --yes                    Skip confirmation prompt
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
  const pluginRoot = getPluginRoot();
  const pluginJson = readJsonFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
  );
  const version = pluginJson?.version ?? "0.1.0";

  console.log("Installing panopticon...\n");

  // 1. Build
  console.log("[1/6] Building...");
  try {
    execSync("npx tsup", { cwd: pluginRoot, stdio: "pipe" });
    console.log("      Built successfully.\n");
  } catch (err: any) {
    console.error("      Build failed:", err.stderr?.toString() ?? err.message);
    process.exit(1);
  }

  // 2. Initialize database
  console.log("[2/6] Initializing database...");
  ensureDataDir();
  getDb();
  closeDb();
  console.log(`      ${config.dbPath}\n`);

  // 3. Set up local marketplace
  console.log("[3/6] Setting up local marketplace...");
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

  console.log("Done! Start a new Claude Code session to activate.\n");
  console.log("Verify with: panopticon status");
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
  const serverScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "otlp",
    "server.js",
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
        console.log(
          `OTLP receiver started (PID ${child.pid}) on :${config.otlpPort}`,
        );
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

  console.log("Panopticon Status");
  console.log("=================");
  console.log();
  console.log(
    `OTLP Receiver: ${receiver.running ? `running (PID ${receiver.pid}, port ${config.otlpPort})` : "stopped"}`,
  );
  console.log(
    `Sync Daemon:   ${syncDaemon.running ? `running (PID ${syncDaemon.pid})` : "stopped"}`,
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

  const child = spawn("node", [daemonScript], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  await new Promise<void>((resolve, reject) => {
    let stderr = "";

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start sync daemon: ${err.message}`));
    });

    setTimeout(() => {
      if (child.pid) {
        child.unref();
        console.log(`Sync daemon started (PID ${child.pid})`);
        resolve();
      } else {
        reject(new Error(`Failed to start sync daemon: ${stderr}`));
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
    case "prune":
      await prune();
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
