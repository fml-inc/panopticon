#!/usr/bin/env node

declare const __PANOPTICON_VERSION__: string;

import { execSync, spawn, spawnSync } from "node:child_process";
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
  getEvent,
  listPlans,
  listSessions,
  rawQuery,
  searchEvents,
  sessionTimeline,
  toolStats,
} from "./db/query.js";
import { closeDb, getDb } from "./db/schema.js";
import { DAEMON_NAMES, type DaemonName, logPaths, openLogFd } from "./log.js";
import { permissionsApply, permissionsShow } from "./mcp/permissions.js";
import { addTarget, listTargets, removeTarget } from "./sync/config.js";
import {
  closeWatermarkDb,
  readWatermark,
  watermarkKey,
} from "./sync/watermark.js";
import { readTomlFile, writeTomlFile } from "./toml.js";
import { loadUnifiedConfig } from "./unified-config.js";
import { allVendors, getVendor, vendorIds } from "./vendors/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLAUDE_DESKTOP_CONFIG = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude_desktop_config.json",
);

function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function getPluginRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  dir = path.resolve(dir, "..");
  return dir;
}

const INSTALL_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "panopticon-app",
);

function isTransientLocation(pluginRoot: string): boolean {
  if (fs.existsSync(path.join(pluginRoot, "tsup.config.ts"))) return false;
  if (pluginRoot === INSTALL_DIR) return false;
  return true;
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

function installToLocalDir(sourceRoot: string): string {
  console.log("[0/7] Installing to ~/.local/share/panopticon-app/...");

  stopExistingDaemons();

  // If reinstalling from INSTALL_DIR itself (--force), stage to a temp dir first
  let effectiveSource = sourceRoot;
  let tempDir: string | null = null;
  if (sourceRoot === INSTALL_DIR) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-reinstall-"));
    for (const entry of fs.readdirSync(sourceRoot)) {
      if (entry === "node_modules") continue;
      fs.cpSync(path.join(sourceRoot, entry), path.join(tempDir, entry), {
        recursive: true,
      });
    }
    effectiveSource = tempDir;
  }

  if (fs.existsSync(INSTALL_DIR)) {
    fs.rmSync(INSTALL_DIR, { recursive: true });
  }
  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  for (const entry of fs.readdirSync(effectiveSource)) {
    if (entry === "node_modules") continue;
    const src = path.join(effectiveSource, entry);
    const dest = path.join(INSTALL_DIR, entry);
    fs.cpSync(src, dest, { recursive: true });
  }

  if (tempDir) fs.rmSync(tempDir, { recursive: true });

  console.log("      Installing dependencies...");
  const env = { ...process.env };
  delete env.npm_config_registry;

  execSync("npm install --production --no-package-lock", {
    cwd: INSTALL_DIR,
    stdio: "pipe",
    timeout: 120_000,
    env,
  });

  // Ensure bin scripts are executable
  const binDir = path.join(INSTALL_DIR, "bin");
  if (fs.existsSync(binDir)) {
    for (const file of fs.readdirSync(binDir)) {
      fs.chmodSync(path.join(binDir, file), 0o755);
    }
  }

  console.log(`      Installed to ${INSTALL_DIR}\n`);
  return INSTALL_DIR;
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

  // Collect all known vendor env var names for detection/cleanup
  const allVendorVarNames = new Set<string>();
  for (const v of allVendors()) {
    for (const [varName] of v.shellEnv.envVars(config.port, true)) {
      allVendorVarNames.add(varName);
    }
  }

  // Shared OTEL vars + all vendor-specific vars
  const PANOPTICON_VARS = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_METRIC_EXPORT_INTERVAL",
    ...allVendorVarNames,
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

  // Build the wanted env vars: shared OTEL vars + vendor-specific vars
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

  // Add vendor-specific env vars for targeted vendors
  const targetVendorList =
    target === "all"
      ? allVendors()
      : allVendors().filter((v) => v.id === target);

  for (const vendor of targetVendorList) {
    for (const [varName, value] of vendor.shellEnv.envVars(
      config.port,
      proxy,
    )) {
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
  .option("--desktop", "Install as MCP server for Claude Desktop instead")
  .option(
    "--target <target>",
    `Target CLI: ${vendorIds().join(", ")}, all`,
    "all",
  )
  .option("--proxy", "Also route API traffic through the panopticon proxy")
  .option("--force", "Overwrite customized env vars with defaults")
  .option("--skip-build", "Skip the build step (internal)")
  .action(async (opts: Opts) => {
    const validTargets = [...vendorIds(), "all"];
    if (!validTargets.includes(opts.target)) {
      console.error(
        `Invalid target: ${opts.target}. Must be ${validTargets.join(", ")}.`,
      );
      process.exit(1);
    }
    const pluginRoot = getPluginRoot();
    if (opts.desktop) {
      await installDesktop(pluginRoot, opts);
    } else {
      await installClaudeCode(pluginRoot, opts);
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
    console.log("Checking for updates...\n");

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-update-"),
    );

    try {
      const env = { ...process.env };
      delete env.npm_config_registry;

      // Download the latest package
      execSync("npm pack @fml-inc/panopticon@latest --pack-destination .", {
        cwd: tempDir,
        stdio: "pipe",
        timeout: 120_000,
        env,
      });

      const tgz = fs.readdirSync(tempDir).find((f) => f.endsWith(".tgz"));
      if (!tgz) throw new Error("Failed to download package");

      execSync(`tar xzf ${tgz}`, { cwd: tempDir, stdio: "pipe" });
      const packageDir = path.join(tempDir, "package");

      const newPkg = JSON.parse(
        fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"),
      );
      const newVersion = newPkg.version ?? "unknown";

      if (newVersion === currentVersion.split("+")[0]) {
        console.log("Already on the latest version.");
        return;
      }

      console.log(`Updating: ${currentVersion} -> ${newVersion}\n`);

      stopExistingDaemons();

      if (fs.existsSync(INSTALL_DIR)) {
        fs.rmSync(INSTALL_DIR, { recursive: true });
      }
      fs.renameSync(packageDir, INSTALL_DIR);

      console.log("Installing dependencies...");
      execSync("npm install --omit=dev --no-package-lock", {
        cwd: INSTALL_DIR,
        stdio: "pipe",
        timeout: 120_000,
        env,
      });

      const binDir = path.join(INSTALL_DIR, "bin");
      if (fs.existsSync(binDir)) {
        for (const file of fs.readdirSync(binDir)) {
          fs.chmodSync(path.join(binDir, file), 0o755);
        }
      }

      console.log(
        `\nUpdated to ${newVersion}. Run \`panopticon install --skip-build\` to reconfigure.`,
      );
    } catch (err: any) {
      console.error("Update failed:", err.stderr?.toString() ?? err.message);
      process.exit(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

async function installDesktop(
  pluginRoot: string,
  opts: { skipBuild?: boolean },
) {
  const skipBuild = opts.skipBuild;
  const totalSteps = skipBuild ? 3 : 4;
  let step = 0;

  console.log("Installing panopticon for Claude Desktop...\n");

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

  step++;
  console.log(`[${step}/${totalSteps}] Initializing database...`);
  ensureDataDir();
  getDb();
  closeDb();
  console.log(`      ${config.dbPath}\n`);

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

  step++;
  console.log(`[${step}/${totalSteps}] Configuring shell environment...`);
  configureShellEnv(false);

  console.log("Done! Restart Claude Desktop to activate.\n");
}

async function installClaudeCode(
  pluginRoot: string,
  opts: {
    force?: boolean;
    skipBuild?: boolean;
    target?: string;
    proxy?: boolean;
  },
) {
  const force = opts.force ?? false;
  const target = opts.target ?? "claude";

  console.log("Installing panopticon...\n");

  const hasBuildConfig = fs.existsSync(path.join(pluginRoot, "tsup.config.ts"));
  if (!opts.skipBuild && hasBuildConfig) {
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
  } else if (isTransientLocation(pluginRoot) || force) {
    installToLocalDir(pluginRoot);
    const installedCli = path.join(INSTALL_DIR, "bin", "panopticon");
    const args = [installedCli, "install", "--skip-build"];
    if (force) args.push("--force");
    if (target !== "all") args.push("--target", target);
    if (opts.proxy) args.push("--proxy");
    const result = spawnSync(process.argv[0], args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
    process.exit(result.status ?? 1);
  } else {
    console.log("[1/7] Already installed, skipping.\n");
  }

  const pluginJson = readJsonFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
  );
  const version = pluginJson?.version ?? "0.1.0";

  console.log("[2/7] Initializing database...");
  ensureDataDir();
  getDb();
  closeDb();
  console.log(`      ${config.dbPath}`);

  // Fetch model pricing from OpenRouter (non-blocking if it fails)
  const pricing = await refreshPricing();
  console.log(
    pricing
      ? `      Cached pricing for ${Object.keys(pricing.models).length} models\n`
      : "      Could not fetch pricing (will use defaults)\n",
  );

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
  console.log(`      Marketplace: ${config.marketplaceDir}`);
  console.log(`      Cache: ${cacheDir}\n`);

  // Register hooks/config for each targeted vendor
  const targetVendors =
    target === "all"
      ? allVendors()
      : ([getVendor(target)].filter(
          Boolean,
        ) as import("./vendors/types.js").VendorAdapter[]);

  for (const vendor of targetVendors) {
    console.log(
      `[4/7] Registering panopticon in ${vendor.detect.displayName}...`,
    );

    // Read existing config
    let existingConfig: Record<string, unknown>;
    if (vendor.config.configFormat === "toml") {
      existingConfig = readTomlFile(vendor.config.configPath);
    } else {
      existingConfig = readJsonFile(vendor.config.configPath) ?? {};
    }

    // Apply vendor-specific install config
    const updatedConfig = vendor.hooks.applyInstallConfig(existingConfig, {
      pluginRoot,
      port: config.port,
      proxy: !!opts.proxy,
    });

    // Write back
    if (vendor.config.configFormat === "toml") {
      writeTomlFile(vendor.config.configPath, updatedConfig);
    } else {
      writeJsonFile(vendor.config.configPath, updatedConfig);
    }

    if (opts.proxy && vendor.id === "codex") {
      console.log("      API proxy enabled (--proxy)");
    }
    console.log(`      ${vendor.config.configPath}\n`);
  }

  // Log skipped vendors
  const skippedVendors = allVendors().filter(
    (v) => !targetVendors.some((tv) => tv.id === v.id),
  );
  for (const vendor of skippedVendors) {
    console.log(`[4/7] Skipping ${vendor.detect.displayName} settings...\n`);
  }

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
    if (process.platform === "win32") {
      fs.copyFileSync(target, link);
    } else {
      fs.symlinkSync(target, link);
    }
  }
  console.log(`      Linked panopticon -> ${localBin}/panopticon\n`);

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

  console.log("[7/7] Configuring shell environment...");
  configureShellEnv(force, target, !!opts.proxy);

  const assistant =
    target === "all"
      ? allVendors()
          .map((v) => v.detect.displayName)
          .join(", ")
      : (getVendor(target)?.detect.displayName ?? target);
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
        console.log(`  otel_logs:    ${stats.otel_logs}`);
        console.log(`  otel_metrics: ${stats.otel_metrics}`);
        console.log(`  hook_events:  ${stats.hook_events}`);
      } catch {
        console.log("  (could not read database)");
      }
    } else {
      console.log("Database: not initialized (run 'panopticon setup')");
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
        closeWatermarkDb();
      }
    } catch {
      // Sync not configured or watermark DB not available
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
    console.log(`  otel_logs:    ${result.otel_logs}`);
    console.log(`  otel_metrics: ${result.otel_metrics}`);
    console.log(`  hook_events:  ${result.hook_events}`);

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
      .action((name: string, url: string, opts: Opts) => {
        addTarget({ name, url, token: opts.token ?? undefined });
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
        const auth = t.token ? " (token)" : "";
        console.log(`  ${t.name} → ${t.url}${auth}`);
      }
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
  .description("Get chronological events for a session")
  .argument("<session-id>", "The session ID to query")
  .option("--types <types...>", "Filter to specific event types")
  .option("--limit <n>", "Max events to return (default 20)", parseInt)
  .option("--offset <n>", "Number of events to skip", parseInt)
  .option("--full", "Return full payloads instead of truncated")
  .action((sessionId: string, opts: Opts) => {
    const result = sessionTimeline({
      sessionId,
      eventTypes: opts.types,
      limit: opts.limit,
      offset: opts.offset,
      fullPayloads: opts.full,
    });
    output(result);
  });

program
  .command("tools")
  .description("Per-tool usage aggregates: call count, success/failure")
  .option(
    "--since <duration>",
    'Time filter: ISO date or relative like "24h", "7d"',
  )
  .option("--session <id>", "Filter to a specific session")
  .action((opts: Opts) => {
    output(toolStats({ since: opts.since, session_id: opts.session }));
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
  .description("Full-text search across all events")
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
    const result = searchEvents({
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
  .command("event")
  .description("Get full details for a specific event by source and ID")
  .argument("<source>", "Event source: hook or otel")
  .argument("<id>", "Event ID from search/timeline results")
  .action((source: string, id: string) => {
    if (source !== "hook" && source !== "otel") {
      console.error(`Invalid source: ${source} (must be "hook" or "otel")`);
      process.exit(1);
    }
    const result = getEvent({ source, id: parseInt(id, 10) });
    if (!result) {
      console.error(`No ${source} event found with id ${id}`);
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
  .description("Fetch latest model pricing from OpenRouter")
  .action(async () => {
    console.log("Fetching pricing from OpenRouter...");
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

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

program.parseAsync().catch((err: unknown) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
