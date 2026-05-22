import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import type { ConfigLayer, HarnessConfigSnapshot } from "../config-types.js";
import { piAgentDir } from "./paths.js";

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function readJsonOrNull(filePath: string): Record<string, unknown> | null {
  const raw = readFileOrNull(filePath);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function emptyLayer(
  settings: Record<string, unknown> | null = null,
): ConfigLayer {
  return {
    settings,
    hooks: [],
    mcpServers: [],
    permissions: { allow: [], ask: [], deny: [] },
    commands: [],
    agents: [],
    rules: [],
    skills: [],
  };
}

function readSkills(dir: string): Array<{ name: string; content: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: Array<{ name: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const content = readFileOrNull(path.join(dir, entry.name, "SKILL.md"));
    if (content !== null) {
      results.push({ name: entry.name, content });
    }
  }
  return results;
}

function readPanopticonPermissions(): HarnessConfigSnapshot["panopticonPermissions"] {
  const base = path.join(config.dataDir, "permissions");
  return {
    allowed: readJsonOrNull(path.join(base, "allowed.json")),
    approvals: readJsonOrNull(path.join(base, "approvals.json")),
  };
}

function parsePiPackages(
  settings: Record<string, unknown> | null,
): Array<{ pluginName: string; marketplace: string }> {
  const packages = settings?.packages;
  if (!Array.isArray(packages)) return [];
  return packages
    .filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    )
    .map((item) => {
      if (item.startsWith("npm:")) {
        return { pluginName: item.slice("npm:".length), marketplace: "npm" };
      }
      return { pluginName: path.basename(item), marketplace: "local" };
    });
}

function readPiExtensions(
  extensionsDir: string,
): Array<{ pluginName: string; marketplace: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => ({
      pluginName: entry.name.replace(/\.js$/, ""),
      marketplace: "pi-extension",
    }));
}

function dedupePlugins(
  plugins: Array<{ pluginName: string; marketplace: string }>,
): Array<{ pluginName: string; marketplace: string }> {
  const seen = new Set<string>();
  const out: Array<{ pluginName: string; marketplace: string }> = [];
  for (const plugin of plugins) {
    const key = `${plugin.pluginName}@${plugin.marketplace}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(plugin);
  }
  return out;
}

/**
 * Read Pi coding agent user config into the shared setup snapshot shape.
 * Pi does not use Claude's hooks.json plugin system, so extension/package
 * inventory is represented as enabledPlugins and hook lists remain empty.
 */
export function readPiConfig(): HarnessConfigSnapshot {
  const agentDir = piAgentDir();
  const settings = readJsonOrNull(path.join(agentDir, "settings.json"));
  const models = readJsonOrNull(path.join(agentDir, "models.json"));
  const user = emptyLayer(
    models === null ? settings : { ...(settings ?? {}), models },
  );
  user.skills = readSkills(path.join(agentDir, "skills"));

  const enabledPlugins = dedupePlugins([
    ...parsePiPackages(settings),
    ...readPiExtensions(path.join(agentDir, "extensions")),
  ]);

  return {
    managed: null,
    user,
    project: null,
    projectLocal: null,
    instructions: [],
    enabledPlugins,
    pluginHooks: [],
    panopticonPermissions: readPanopticonPermissions(),
    memoryFiles: {},
  };
}

export function isPiUserConfigPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  if (p.endsWith("/.pi/agent/settings.json")) return true;
  if (p.endsWith("/.pi/agent/models.json")) return true;
  if (p.includes("/.pi/agent/extensions/") && p.endsWith(".js")) return true;
  if (p.includes("/.pi/agent/skills/") && p.endsWith("/SKILL.md")) {
    return true;
  }
  return false;
}
