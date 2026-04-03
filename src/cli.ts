#!/usr/bin/env node

declare const __PANOPTICON_VERSION__: string;

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command, type OptionValues } from "commander";

type Opts = OptionValues;

import { config, ensureDataDir } from "./config.js";
import { refreshPricing } from "./db/pricing.js";
import { pruneEstimate, pruneExecute } from "./db/prune.js";
import {
  activitySummary,
  costBreakdown,
  dbStats,
  listPlans,
  listSessions,
  print,
  rawQuery,
  search,
  sessionTimeline,
} from "./db/query.js";
import { closeDb, getDb } from "./db/schema.js";
import { DAEMON_NAMES, type DaemonName, logPaths, openLogFd } from "./log.js";
import { permissionsApply, permissionsShow } from "./mcp/permissions.js";
import { addTarget, listTargets, removeTarget } from "./sync/config.js";
import { readWatermark, watermarkKey } from "./sync/watermark.js";
import { allTargets, getTarget, targetIds } from "./targets/index.js";
import { readTomlFile, writeTomlFile } from "./toml.js";
import { loadUnifiedConfig } from "./unified-config.js";

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

function stopExistingDaemons(): void {
  const pidFiles = [config.serverPidFile, config.pidFile];
  for (const pidFile of pidFiles) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      process.kill(pid, "SIGTERM");
      fs.unlinkSync(pidFile);
    } catch {}
  }
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
        console.log(`      ⚠ Keeping existing value: ${lines[i].trim()}`);
        console.log(`        (default would be: ${match[1]})`);
        console.log("        (use --force to overwrite)");
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
  console.log(
    `      ${lastPanopticonIdx >= 0 ? "Updated" : "Added"} env vars in ${shellRc}\n`,
  );
}

function removeShellEnv() {
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

program.hook("postAction", () => {
  closeDb();
});

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

    // Stop running daemons
    console.log("[1/6] Stopping daemons...");
    stopExistingDaemons();
    console.log();

    // Remove target configs
    const selectedTargets =
      targetId === "all"
        ? allTargets()
        : allTargets().filter((t) => t.id === targetId);

    for (const t of selectedTargets) {
      console.log(`[2/6] Removing panopticon from ${t.detect.displayName}...`);
      let existing: Record<string, unknown>;
      if (t.config.configFormat === "toml") {
        existing = readTomlFile(t.config.configPath);
      } else {
        existing = readJsonFile(t.config.configPath) ?? {};
      }
      const updated = t.hooks.removeInstallConfig(existing);
      if (t.config.configFormat === "toml") {
        writeTomlFile(t.config.configPath, updated);
      } else {
        writeJsonFile(t.config.configPath, updated);
      }
      console.log(`      ${t.config.configPath}\n`);
    }

    // Remove shell env
    console.log("[3/6] Cleaning shell environment...");
    removeShellEnv();

    if (targetId === "all") {
      // Remove marketplace and plugin cache
      console.log("[4/5] Removing marketplace and plugin cache...");
      try {
        fs.rmSync(config.marketplaceDir, { recursive: true, force: true });
        console.log(`      Removed ${config.marketplaceDir}`);
      } catch {}
      try {
        fs.rmSync(config.pluginCacheDir, { recursive: true, force: true });
        console.log(`      Removed ${config.pluginCacheDir}`);
      } catch {}
      console.log();

      // Remove skills
      console.log("[5/5] Removing skills...");
      const pluginRoot = getPluginRoot();
      const skillsSource = path.join(pluginRoot, "skills");
      const skillsTarget = path.join(os.homedir(), ".claude", "skills");
      if (fs.existsSync(skillsSource)) {
        for (const name of fs.readdirSync(skillsSource)) {
          const dest = path.join(skillsTarget, name);
          try {
            fs.rmSync(dest, { recursive: true, force: true });
            console.log(`      Removed ${dest}`);
          } catch {}
        }
      }
      console.log();
    } else {
      console.log("[4/5] Skipping marketplace (target-specific uninstall)");
      console.log("[5/5] Skipping skills (target-specific uninstall)\n");
    }

    if (purge) {
      console.log("Purging data...");
      closeDb();
      try {
        fs.rmSync(config.dataDir, { recursive: true, force: true });
        console.log(`      Removed ${config.dataDir}`);
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
  },
) {
  const force = opts.force ?? false;
  const target = opts.target ?? "claude";

  console.log("Installing panopticon...\n");

  const pkgJson = readJsonFile(path.join(pluginRoot, "package.json"));
  const version = pkgJson?.version ?? "0.0.0-dev";

  console.log("[1/5] Initializing database and log directory...");
  ensureDataDir();
  const logDir = path.dirname(logPaths.server);
  fs.mkdirSync(logDir, { recursive: true });
  getDb();
  closeDb();
  console.log(`      ${config.dbPath}`);
  console.log(`      ${logDir}`);

  // Fetch model pricing from LiteLLM (non-blocking if it fails)
  const pricing = await refreshPricing();
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

  const cacheDir = path.join(config.pluginCacheDir, version);
  fs.mkdirSync(cacheDir, { recursive: true });
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
      fs.cpSync(src, dest, { recursive: true, dereference: true });
    }
  }

  // Ensure bin scripts are executable (cpSync doesn't always preserve mode)
  const binDir = path.join(pluginRoot, "bin");
  if (fs.existsSync(binDir)) {
    for (const file of fs.readdirSync(binDir)) {
      const binPath = path.join(binDir, file);
      if (fs.statSync(binPath).isFile()) {
        fs.chmodSync(binPath, 0o755);
      }
    }
    const cachedBinDir = path.join(cacheDir, "bin");
    if (fs.existsSync(cachedBinDir)) {
      for (const file of fs.readdirSync(cachedBinDir)) {
        const binPath = path.join(cachedBinDir, file);
        if (fs.statSync(binPath).isFile()) {
          fs.chmodSync(binPath, 0o755);
        }
      }
    }
  }

  console.log(`      Marketplace: ${config.marketplaceDir}`);
  console.log(`      Cache: ${cacheDir}\n`);

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
    let existingConfig: Record<string, unknown>;
    if (t.config.configFormat === "toml") {
      existingConfig = readTomlFile(t.config.configPath);
    } else {
      existingConfig = readJsonFile(t.config.configPath) ?? {};
    }

    // Apply target-specific install config
    const updatedConfig = t.hooks.applyInstallConfig(existingConfig, {
      pluginRoot,
      port: config.port,
      proxy: !!opts.proxy,
    });

    // Write back
    if (t.config.configFormat === "toml") {
      writeTomlFile(t.config.configPath, updatedConfig);
    } else {
      writeJsonFile(t.config.configPath, updatedConfig);
    }

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

  console.log("[4/5] Installing skills...");
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

  console.log("[5/5] Configuring shell environment...");
  configureShellEnv(force, target, !!opts.proxy);

  // Start the server so it's ready for the first hook event
  stopExistingDaemons();
  const serverScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "server.js",
  );
  const logFd = openLogFd("server");
  const child = spawn("node", [serverScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PANOPTICON_PORT: String(config.port) },
  });
  if (child.pid) {
    fs.writeFileSync(config.serverPidFile, String(child.pid));
    console.log(`\nServer started (PID ${child.pid}) on :${config.port}`);
  }
  child.unref();
  fs.closeSync(logFd);

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
  .action(async () => {
    ensureDataDir();

    // Check for already-running unified server
    if (fs.existsSync(config.serverPidFile)) {
      const pid = parseInt(
        fs.readFileSync(config.serverPidFile, "utf-8").trim(),
        10,
      );
      try {
        process.kill(pid, 0);
        console.log(`Panopticon already running (PID ${pid})`);
        return;
      } catch {
        fs.unlinkSync(config.serverPidFile);
      }
    }

    // Clean up legacy PID files from old separate daemons
    for (const legacyPid of [config.pidFile, config.proxyPidFile]) {
      if (fs.existsSync(legacyPid)) {
        try {
          const pid = parseInt(fs.readFileSync(legacyPid, "utf-8").trim(), 10);
          process.kill(pid, "SIGTERM");
        } catch {}
        try {
          fs.unlinkSync(legacyPid);
        } catch {}
      }
    }

    const serverScript = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "server.js",
    );
    const logFd = openLogFd("server");

    const child = spawn("node", [serverScript], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        PANOPTICON_PORT: String(config.port),
      },
    });

    await new Promise<void>((resolve, reject) => {
      child.on("error", (err) => {
        reject(new Error(`Failed to start: ${err.message}`));
      });
      setTimeout(() => {
        if (child.pid) {
          fs.writeFileSync(config.serverPidFile, String(child.pid));
          child.unref();
          fs.closeSync(logFd);
          console.log(
            `Panopticon started (PID ${child.pid}) on :${config.port}`,
          );
          console.log(`Log: ${logPaths.server}`);
          resolve();
        } else {
          fs.closeSync(logFd);
          reject(new Error("Failed to start panopticon server"));
        }
      }, 500);
    });
  });

program
  .command("stop")
  .description("Stop panopticon server")
  .action(() => {
    if (!fs.existsSync(config.serverPidFile)) {
      console.log("Panopticon is not running (no PID file)");
      return;
    }
    const pid = parseInt(
      fs.readFileSync(config.serverPidFile, "utf-8").trim(),
      10,
    );
    try {
      process.kill(pid, "SIGTERM");
      fs.unlinkSync(config.serverPidFile);
      console.log(`Panopticon stopped (PID ${pid})`);
    } catch {
      fs.unlinkSync(config.serverPidFile);
      console.log("Panopticon was not running (stale PID file removed)");
    }
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
  .action(() => {
    const server = isProcessRunning(config.serverPidFile);

    console.log("Panopticon Status");
    console.log("=================");
    console.log();
    console.log(
      `Server: ${server.running ? `running (PID ${server.pid}, port ${config.port})` : "stopped"}`,
    );
    console.log(`Database: ${config.dbPath}`);

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
    } else {
      console.log("Database: not initialized (run 'panopticon install')");
    }

    // Sync targets
    try {
      const cfg = loadUnifiedConfig();
      const targets = cfg.sync.targets;
      if (targets.length > 0) {
        console.log();
        console.log("Sync targets:");
        const tables = ["hook_events", "otel_logs", "otel_metrics"];
        for (const t of targets) {
          const watermarks = tables.map((table) =>
            readWatermark(watermarkKey(table, t.name)),
          );
          const minWm = Math.min(...watermarks);
          const wmLabel = minWm > 0 ? `synced to #${minWm}` : "not synced yet";
          console.log(`  ${t.name} → ${t.url} (${wmLabel})`);
        }
      }
    } catch {
      // Sync not configured
    }
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

    const estimate = pruneEstimate(cutoffMs);
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

    const result = pruneExecute(cutoffMs);
    console.log("Deleted:");
    for (const [key, count] of Object.entries(result)) {
      if (count > 0) console.log(`  ${key}: ${count}`);
    }

    if (opts.vacuum) {
      console.log("\nReclaiming disk space...");
      const db = getDb();
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      console.log("Done.");
    }
  });

program
  .command("sync")
  .description("Manage sync targets (OTLP export)")
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
      .action((name: string, url: string, opts: Opts) => {
        addTarget({
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
      .action((name: string) => {
        if (removeTarget(name)) {
          console.log(`Removed sync target "${name}"`);
          console.log("Restart panopticon to apply.");
        } else {
          console.log(`No target named "${name}"`);
        }
      }),
  )
  .addCommand(
    new Command("list").description("List sync targets").action(() => {
      const targets = listTargets();
      if (targets.length === 0) {
        console.log("No sync targets configured.");
        return;
      }
      for (const t of targets) {
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
        const { resetWatermarks } = await import("./sync/watermark.js");
        resetWatermarks(targetName);
        console.log(
          targetName
            ? `Reset sync watermarks for "${targetName}"`
            : "Reset all sync watermarks",
        );
        console.log("Restart panopticon to re-sync.");
      }),
  );

// ---------------------------------------------------------------------------
// Query commands
// ---------------------------------------------------------------------------

program
  .command("sessions")
  .description("List recent sessions with stats (event count, tools, cost)")
  .option("--limit <n>", "Max sessions to return (default 20)", parseInt)
  .option(
    "--since <duration>",
    'Time filter: ISO date or relative like "24h", "7d", "30m"',
  )
  .action((opts: Opts) => {
    output(listSessions({ limit: opts.limit, since: opts.since }));
  });

program
  .command("timeline")
  .description("Get messages and tool calls for a session")
  .argument("<session-id>", "The session ID to query")
  .option("--limit <n>", "Max messages to return (default 50)", parseInt)
  .option("--offset <n>", "Number of messages to skip", parseInt)
  .option("--full", "Return full content instead of truncated")
  .action((sessionId: string, opts: Opts) => {
    const result = sessionTimeline({
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
  .action((opts: Opts) => {
    output(costBreakdown({ since: opts.since, groupBy: opts.groupBy }));
  });

program
  .command("summary")
  .description("Activity summary — sessions, prompts, tools, files, costs")
  .option(
    "--since <duration>",
    'Time window (default "24h"). ISO date or relative like "24h", "7d"',
  )
  .action((opts: Opts) => {
    output(activitySummary({ since: opts.since }));
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
  .action((opts: Opts) => {
    output(
      listPlans({
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
  .action((query: string, opts: Opts) => {
    const result = search({
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
  .action((source: string, id: string) => {
    if (source !== "hook" && source !== "otel" && source !== "message") {
      console.error(
        `Invalid source: ${source} (must be "hook", "otel", or "message")`,
      );
      process.exit(1);
    }
    const result = print({ source, id: parseInt(id, 10) });
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
  .action((sql: string) => {
    try {
      output(rawQuery(sql));
    } catch (err: unknown) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("db-stats")
  .description("Show database row counts for each table")
  .action(() => {
    output(dbStats());
  });

program
  .command("refresh-pricing")
  .description("Fetch latest model pricing from LiteLLM")
  .action(async () => {
    console.log("Fetching pricing from LiteLLM...");
    const result = await refreshPricing();
    if (result) {
      console.log(
        `Cached pricing for ${Object.keys(result.models).length} models`,
      );
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
  .command("apply")
  .description("Apply permission rules (reads JSON payload from stdin)")
  .action(async () => {
    const input = JSON.parse(await readStdin());
    output(permissionsApply(input));
  });

const scanCmd = program
  .command("scan")
  .description("Scan local session files (Claude Code, Codex, Gemini)");

async function printScanSummary(): Promise<void> {
  const { getDb } = await import("./db/schema.js");
  const db = getDb();
  const bySource = db
    .prepare(
      "SELECT target as source, COUNT(*) as sessions, SUM(turn_count) as turns, SUM(total_input_tokens + total_output_tokens) as tokens FROM sessions WHERE scanner_file_path IS NOT NULL GROUP BY target",
    )
    .all() as {
    source: string;
    sessions: number;
    turns: number;
    tokens: number;
  }[];
  const total = db
    .prepare(
      "SELECT COUNT(*) as c FROM sessions WHERE scanner_file_path IS NOT NULL",
    )
    .get() as { c: number };
  const totalTurns = db
    .prepare("SELECT COUNT(*) as c FROM scanner_turns")
    .get() as { c: number };

  console.log(`\nTotal: ${total.c} sessions, ${totalTurns.c} turns`);
  for (const row of bySource) {
    console.log(
      `  ${row.source}: ${row.sessions} sessions, ${row.turns ?? 0} turns, ${row.tokens ?? 0} tokens`,
    );
  }
}

scanCmd
  .command("run", { isDefault: true })
  .description("Scan for new session data (incremental)")
  .action(async () => {
    const { scanOnce } = await import("./scanner/index.js");
    const { getDb } = await import("./db/schema.js");
    getDb();

    const { filesScanned, newTurns } = scanOnce((msg) =>
      console.log(`[scan] ${msg}`),
    );
    console.log(`Done: ${filesScanned} files scanned, ${newTurns} new turns`);
    await printScanSummary();
  });

scanCmd
  .command("reset")
  .description("Reset scanner data and re-scan from scratch")
  .argument(
    "[source]",
    "Reset only this source: claude, codex, gemini (default: all)",
  )
  .action(async (source?: string) => {
    const { scanOnce } = await import("./scanner/index.js");
    const { resetScanner, resetScannerSource } = await import(
      "./scanner/store.js"
    );
    const { getDb } = await import("./db/schema.js");
    getDb();

    if (source) {
      resetScannerSource(source);
      console.log(`Reset scanner data for "${source}"`);
    } else {
      resetScanner();
      console.log("Reset all scanner data");
    }

    const { filesScanned, newTurns } = scanOnce((msg) =>
      console.log(`[scan] ${msg}`),
    );
    console.log(`Done: ${filesScanned} files scanned, ${newTurns} new turns`);
    await printScanSummary();
  });

scanCmd
  .command("resync")
  .description("Atomic full resync: rebuild scanner data in a temp DB and swap")
  .action(async () => {
    const { resyncAll } = await import("./scanner/index.js");
    const { getDb } = await import("./db/schema.js");
    getDb();

    const result = resyncAll((msg) => console.log(`[resync] ${msg}`));
    if (result.success) {
      console.log(
        `Done: ${result.filesScanned} files, ${result.newTurns} turns`,
      );
      await printScanSummary();
    } else {
      console.error(`Resync failed: ${result.error}`);
      process.exit(1);
    }
  });

scanCmd
  .command("compare")
  .description("Compare scanner data against hooks/OTLP data")
  .action(async () => {
    const { scanOnce } = await import("./scanner/index.js");
    const { getDb } = await import("./db/schema.js");
    getDb();

    scanOnce(() => {});
    const { reconcile, formatReconcileReport } = await import(
      "./scanner/reconcile.js"
    );
    console.log(formatReconcileReport(reconcile()));
  });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

program.parseAsync().catch((err: unknown) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
