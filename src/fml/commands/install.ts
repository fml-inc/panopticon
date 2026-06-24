import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addTarget, listTargets } from "../../sync/index.js";
import { printBanner } from "../banner.js";
import { execBinSync, resolveBin } from "../bin-utils.js";
import {
  DEFAULT_SYNC_URL,
  DEFAULT_TARGET_NAME,
  envConfigExists,
  writeEnvConfig,
} from "../config.js";
import { panopticonExec } from "../daemon-utils.js";
import { FML_DATA_DIR, FML_LOG_DIR } from "../dirs.js";
import { resolveSyncTokenCommand } from "../sync/client.js";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
const MARKETPLACE_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "claude-plugins",
);

export function resolvePluginRoot(
  startDir = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "bin"))
    ) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(startDir, "..", "..", "..");
    }
    dir = parent;
  }
}

function getPluginRoot(): string {
  return resolvePluginRoot();
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Best-effort migration for installs upgrading from the old `panopticon`
 * plugin surface. The fml plugin now owns the single `.claude-plugin/plugin.json`
 * at the package root (named "fml"), and both the legacy `panopticon` and the
 * new `fml` marketplace symlinks resolve to that same root. Leaving the old
 * `panopticon@local-plugins` registration in place points Claude Code at a
 * manifest whose name no longer matches, which surfaces as a load warning or a
 * stale entry. Deregister it. The deprecated `panopticon` slash command still
 * ships inside the fml plugin, so this does not remove that compatibility path.
 */
function migrateLegacyPanopticonPlugin(claudeBin: string | null): void {
  let removedSomething = false;

  // 1. Ask Claude Code to uninstall the user-scoped registration (best effort).
  if (claudeBin) {
    try {
      execBinSync(
        claudeBin,
        ["plugin", "uninstall", "panopticon@local-plugins", "--scope", "user"],
        { timeout: 10_000 },
      );
      removedSomething = true;
    } catch {
      // Not installed at this scope — nothing to do.
    }
  }

  // 2. Drop the entry from installed_plugins.json directly (covers scopes the
  //    CLI won't touch from outside their project dir).
  const installedPluginsPath = path.join(
    CLAUDE_DIR,
    "plugins",
    "installed_plugins.json",
  );
  const installed = readJsonFile(installedPluginsPath) as {
    plugins?: Record<string, unknown[]>;
  } | null;
  if (installed?.plugins?.["panopticon@local-plugins"]) {
    delete installed.plugins["panopticon@local-plugins"];
    writeJsonFile(installedPluginsPath, installed as Record<string, unknown>);
    removedSomething = true;
  }

  // 3. Remove the legacy enabledPlugins flag from user settings.
  const settings = readJsonFile(CLAUDE_SETTINGS_PATH) as Record<
    string,
    Record<string, unknown>
  > | null;
  if (settings?.enabledPlugins?.["panopticon@local-plugins"] != null) {
    delete settings.enabledPlugins["panopticon@local-plugins"];
    writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
    removedSomething = true;
  }

  // 4. Remove the stale marketplace entry + symlink.
  const manifestPath = path.join(
    MARKETPLACE_DIR,
    ".claude-plugin",
    "marketplace.json",
  );
  const manifest = readJsonFile(manifestPath);
  if (manifest && Array.isArray(manifest.plugins)) {
    const plugins = manifest.plugins as Array<Record<string, unknown>>;
    const kept = plugins.filter((p) => p.name !== "panopticon");
    if (kept.length !== plugins.length) {
      manifest.plugins = kept;
      writeJsonFile(manifestPath, manifest);
      removedSomething = true;
    }
  }
  try {
    fs.rmSync(path.join(MARKETPLACE_DIR, "panopticon"), {
      recursive: true,
      force: true,
    });
  } catch {}

  if (removedSomething) {
    console.log("      Migrated legacy panopticon plugin registration");
  }
}

export async function handleInstall(
  opts: { force?: boolean } = {},
): Promise<void> {
  const force = opts.force ?? false;
  const pluginRoot = getPluginRoot();
  console.log(`Installing fml${force ? " (--force)" : ""}...\n`);

  // 1. Configure the bundled local collection engine.
  console.log("[1/5] Setting up local collection...");
  const result = panopticonExec(
    "install",
    "--collection-only",
    ...(force ? ["--force"] : []),
    {
      timeout: 60_000,
    },
  );
  if (result.ok) {
    for (const line of result.stdout.trim().split("\n")) {
      console.log(`      ${line}`);
    }
  } else {
    console.error("      local collection setup failed:");
    for (const line of result.stdout.trim().split("\n")) {
      console.error(`      ${line}`);
    }
  }
  console.log();

  // 2. Ensure fml-specific directories exist
  console.log("[2/5] Creating fml directories...");
  for (const dir of [FML_DATA_DIR, FML_LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  console.log(`      ${FML_DATA_DIR}`);
  console.log(`      ${FML_LOG_DIR}\n`);

  // 3. Ensure plugin manifest has the current version
  console.log("[3/5] Writing plugin manifest...");
  const pkgJson = readJsonFile(path.join(pluginRoot, "package.json"));
  const version = (pkgJson?.version as string) ?? "0.0.0-dev";
  const pluginManifestDir = path.join(pluginRoot, ".claude-plugin");
  fs.mkdirSync(pluginManifestDir, { recursive: true });
  writeJsonFile(path.join(pluginManifestDir, "plugin.json"), {
    name: "fml",
    version,
    description: "FML agent tools for Claude Code",
    mcpServers: {
      fml: {
        command: "node",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude expands this plugin placeholder.
        args: ["${CLAUDE_PLUGIN_ROOT}/bin/fml-mcp-server"],
      },
    },
  });
  console.log(`      Version: ${version}\n`);

  // 4. Register fml plugin in local marketplace + Claude Code settings
  console.log("[4/5] Setting up fml plugin...");
  fs.mkdirSync(path.join(MARKETPLACE_DIR, ".claude-plugin"), {
    recursive: true,
  });

  const manifestPath = path.join(
    MARKETPLACE_DIR,
    ".claude-plugin",
    "marketplace.json",
  );
  const manifest = readJsonFile(manifestPath) ?? {
    name: "local-plugins",
    owner: { name: os.userInfo().username },
    plugins: [],
  };

  const plugins = (manifest.plugins as Array<Record<string, unknown>>) ?? [];
  if (!plugins.some((p) => p.name === "fml")) {
    plugins.push({
      name: "fml",
      source: "./fml",
      description: "FML agent tools for Claude Code",
    });
    manifest.plugins = plugins;
  }
  writeJsonFile(manifestPath, manifest);

  // Symlink plugin source into marketplace
  const marketplaceLink = path.join(MARKETPLACE_DIR, "fml");
  try {
    fs.unlinkSync(marketplaceLink);
  } catch {}
  fs.rmSync(marketplaceLink, { recursive: true, force: true });
  // Junctions on Windows don't require admin/Developer Mode the way directory
  // symlinks do; everywhere else use a plain dir symlink.
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(pluginRoot, marketplaceLink, symlinkType);
  console.log(`      Marketplace: ${MARKETPLACE_DIR}`);
  console.log(`      Plugin: ${pluginRoot}`);

  // Layer fml-specific settings on top for Claude Code
  const settings = (readJsonFile(CLAUDE_SETTINGS_PATH) ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces ?? {};
  settings.extraKnownMarketplaces["local-plugins"] = {
    source: { source: "directory", path: MARKETPLACE_DIR },
  };
  settings.enabledPlugins = settings.enabledPlugins ?? {};
  settings.enabledPlugins["fml@local-plugins"] = true;
  writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
  console.log(`      Claude settings: ${CLAUDE_SETTINGS_PATH}`);

  // Register plugin with Claude Code (install if new, update if existing)
  const claudeBin = resolveBin("claude");
  if (!claudeBin) {
    console.log(
      "      warn: claude CLI not found, run 'claude plugin install fml@local-plugins' manually",
    );
  } else {
    try {
      try {
        execBinSync(claudeBin, ["plugin", "install", "fml@local-plugins"], {
          timeout: 15_000,
        });
      } catch {
        execBinSync(claudeBin, ["plugin", "update", "fml@local-plugins"], {
          timeout: 15_000,
        });
      }
      console.log("      Plugin registered via Claude Code CLI");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`      warn: claude plugin install/update failed: ${msg}`);
      console.log(
        "      Run 'claude plugin install fml@local-plugins' manually",
      );
    }
  }

  // Migrate away from the old panopticon plugin registration (best-effort).
  try {
    migrateLegacyPanopticonPlugin(claudeBin);
  } catch {
    // Never let migration cleanup fail the install.
  }
  console.log();

  // 5. Auto-configure sync target (best-effort)
  console.log("[5/5] Configuring sync target...");
  const existingTargets = listTargets();
  const existingProd = existingTargets.find((t) => t.url === DEFAULT_SYNC_URL);
  if (existingProd) {
    console.log(`      Production target already configured`);
  } else {
    const tokenCommand = resolveSyncTokenCommand();
    addTarget({
      name: DEFAULT_TARGET_NAME,
      url: DEFAULT_SYNC_URL,
      tokenCommand,
    });
    console.log(`      Target "${DEFAULT_TARGET_NAME}": ${DEFAULT_SYNC_URL}`);
    if (tokenCommand) {
      console.log(`      Auth: ${tokenCommand}`);
    } else {
      // No gh and no fml login yet — target is URL-only. `fml login` will
      // back-patch it to `fml sync-token` once the user signs in.
      console.log(
        "      Auth: not configured — run `fml login` to enable sync.",
      );
    }
  }

  // Set the active env to the default only on a fresh install. `fml install`
  // runs on every `npm install -g` (postinstall), so clobbering this on each
  // run would reset the env pointer and orphan the user's per-env login token
  // (tokens are stored per env at auth.<env>.json).
  if (!envConfigExists()) {
    writeEnvConfig({ active: DEFAULT_TARGET_NAME });
  }

  console.log("");
  printBanner();
  console.log("Done! Start a new coding session to activate.\n");
  console.log("\nNext steps:");
  console.log("  fml login          Sign in to your FML account");
  console.log("  fml org            Select organization");
  console.log("  fml sync status    Check sync status");
  console.log("  fml status         Verify setup");
}
