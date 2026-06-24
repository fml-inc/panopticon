import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execBinSync, resolveBin } from "../bin-utils.js";
import { panopticonExec } from "../daemon-utils.js";
import { FML_DATA_DIR, FML_LOG_DIR } from "../dirs.js";
import { removeFmlDirectMcp } from "./mcp-config.js";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
const MARKETPLACE_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "claude-plugins",
);
const PLUGIN_CACHE_DIR = path.join(
  CLAUDE_DIR,
  "plugins",
  "cache",
  "local-plugins",
  "fml",
);

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function handleUninstall(opts: {
  purge?: boolean;
  target?: string;
}): void {
  const targetSpecific = opts.target && opts.target !== "all";

  console.log("Uninstalling fml...\n");

  // 1. Tell Claude Code to uninstall the plugin (kills MCP server, evicts cache)
  if (targetSpecific) {
    console.log("[1/5] Skipping plugin uninstall (target-specific uninstall)");
  } else {
    console.log("[1/5] Uninstalling MCP plugin...");
    // Uninstall from user scope via CLI
    const claudeBin = resolveBin("claude");
    if (claudeBin) {
      try {
        execBinSync(
          claudeBin,
          ["plugin", "uninstall", "fml@local-plugins", "--scope", "user"],
          { timeout: 10_000 },
        );
        console.log("      Uninstalled (user scope)");
      } catch {
        // Not installed at this scope
      }
    }

    // Clean all scopes from installed_plugins.json directly — the CLI
    // can only remove project-scoped entries from within that project dir,
    // so we handle it ourselves.
    const installedPluginsPath = path.join(
      CLAUDE_DIR,
      "plugins",
      "installed_plugins.json",
    );
    const installedPlugins = readJsonFile(installedPluginsPath) as {
      version?: number;
      plugins?: Record<string, unknown[]>;
    } | null;
    const plugins = installedPlugins?.plugins;
    const fmlEntries = plugins?.["fml@local-plugins"];
    if (plugins && fmlEntries) {
      // Clean project-level settings that reference fml
      for (const entry of fmlEntries) {
        const e = entry as { scope?: string; projectPath?: string };
        if (e.scope === "project" && e.projectPath) {
          const projSettings = path.join(
            e.projectPath,
            ".claude",
            "settings.json",
          );
          const proj = readJsonFile(projSettings) as Record<
            string,
            Record<string, unknown>
          > | null;
          if (proj?.enabledPlugins?.["fml@local-plugins"] != null) {
            delete proj.enabledPlugins["fml@local-plugins"];
            writeJsonFile(projSettings, proj);
            console.log(`      Cleaned ${projSettings}`);
          }
        }
      }
      delete plugins["fml@local-plugins"];
      writeJsonFile(
        installedPluginsPath,
        installedPlugins as Record<string, unknown>,
      );
      console.log("      Cleaned installed_plugins.json");
    }
  }

  // 2. Remove fml plugin from Claude Code settings
  if (targetSpecific) {
    console.log("[2/5] Skipping plugin settings (target-specific uninstall)");
  } else {
    console.log("[2/5] Removing plugin from Claude Code settings...");
    const settings = readJsonFile(CLAUDE_SETTINGS_PATH) as Record<
      string,
      Record<string, unknown>
    > | null;
    if (settings) {
      if (settings.enabledPlugins) {
        delete settings.enabledPlugins["fml@local-plugins"];
      }
      if (settings.extraKnownMarketplaces) {
        delete settings.extraKnownMarketplaces["local-plugins"];
      }
      writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
      console.log(`      Updated ${CLAUDE_SETTINGS_PATH}`);
    } else {
      console.log("      No settings file found, skipping");
    }
  }

  // 3. Remove marketplace symlink and manifest entry
  if (targetSpecific) {
    console.log("[3/5] Skipping marketplace (target-specific uninstall)");
  } else {
    console.log("[3/5] Removing marketplace registration...");
    const marketplaceLink = path.join(MARKETPLACE_DIR, "fml");
    try {
      fs.rmSync(marketplaceLink, { recursive: true, force: true });
      console.log(`      Removed ${marketplaceLink}`);
    } catch {
      console.log("      No marketplace link found, skipping");
    }

    const manifestPath = path.join(
      MARKETPLACE_DIR,
      ".claude-plugin",
      "marketplace.json",
    );
    const manifest = readJsonFile(manifestPath);
    if (manifest && Array.isArray(manifest.plugins)) {
      manifest.plugins = (
        manifest.plugins as Array<Record<string, unknown>>
      ).filter((p) => p.name !== "fml");
      writeJsonFile(manifestPath, manifest);
      console.log(`      Updated ${manifestPath}`);
    }
  }

  // 4. Run panopticon uninstall
  console.log("[4/5] Running panopticon uninstall...");
  const panoArgs = ["uninstall"];
  if (opts.target) panoArgs.push("--target", opts.target);
  if (opts.purge) panoArgs.push("--purge");
  const result = panopticonExec(...panoArgs, { timeout: 30_000 });
  if (result.ok) {
    for (const line of result.stdout.trim().split("\n")) {
      console.log(`      ${line}`);
    }
  } else {
    console.error("      panopticon uninstall failed:");
    for (const line of result.stdout.trim().split("\n")) {
      console.error(`      ${line}`);
    }
  }
  for (const target of removeFmlDirectMcp(opts.target ?? "all")) {
    console.log(`      Removed FML MCP from ${target.displayName}`);
  }

  // 5. Remove fml data, logs, and plugin cache
  if (targetSpecific) {
    console.log("[5/5] Skipping data removal (target-specific uninstall)");
  } else {
    console.log("[5/5] Removing plugin cache...");
    try {
      fs.rmSync(PLUGIN_CACHE_DIR, { recursive: true, force: true });
      console.log(`      Removed ${PLUGIN_CACHE_DIR}`);
    } catch {
      console.log("      No plugin cache found");
    }
  }

  if (opts.purge) {
    console.log("Removing fml data and logs...");
    for (const dir of [FML_DATA_DIR, FML_LOG_DIR]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`      Removed ${dir}`);
      } catch {
        console.log(`      Could not remove ${dir}`);
      }
    }
  } else {
    console.log("Keeping fml data (use --purge to remove)");
  }

  console.log("\nDone! FML has been uninstalled.");
}
