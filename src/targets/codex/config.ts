import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../config.js";
import { readTomlFile } from "../../toml.js";
import type { ConfigLayer, HarnessConfigSnapshot } from "../config-types.js";

function codexDir(): string {
  return process.env.PANOPTICON_CODEX_DIR ?? path.join(os.homedir(), ".codex");
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function readRules(dir: string): Array<{ name: string; content: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: Array<{ name: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".rules")) continue;
    const content = readFileOrNull(path.join(dir, entry.name));
    if (content === null) continue;
    results.push({ name: entry.name.replace(/\.rules$/, ""), content });
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

function parseHooks(json: Record<string, unknown>): ConfigLayer["hooks"] {
  const hooks: ConfigLayer["hooks"] = [];
  const rawHooks = asRecord(json.hooks);
  if (!rawHooks) return hooks;

  for (const [event, entries] of Object.entries(rawHooks)) {
    if (event === "state" || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const group = asRecord(entry);
      if (!group) continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : null;
      if (!Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        const h = asRecord(hook);
        if (!h) continue;
        hooks.push({
          event,
          matcher,
          type: typeof h.type === "string" ? h.type : "command",
        });
      }
    }
  }

  return hooks;
}

function parseMcpServers(
  settings: Record<string, unknown>,
): ConfigLayer["mcpServers"] {
  const servers: ConfigLayer["mcpServers"] = [];
  const raw = asRecord(settings.mcp_servers);
  if (!raw) return servers;
  for (const [name, def] of Object.entries(raw)) {
    const server = asRecord(def);
    if (!server) continue;
    servers.push({
      name,
      command: typeof server.command === "string" ? server.command : "",
    });
  }
  return servers;
}

const RULE_PATTERN_RE =
  /^prefix_rule\(pattern = \[(.+?)\], decision = "(allow|ask|deny)"/;

function parseRulePermissions(
  rules: Array<{ name: string; content: string }>,
): ConfigLayer["permissions"] {
  const permissions: ConfigLayer["permissions"] = {
    allow: [],
    ask: [],
    deny: [],
  };

  for (const ruleFile of rules) {
    for (const line of ruleFile.content.split("\n")) {
      const match = line.match(RULE_PATTERN_RE);
      if (!match) continue;
      try {
        const tokens = JSON.parse(`[${match[1]}]`) as unknown[];
        const command = tokens
          .filter((token): token is string => typeof token === "string")
          .join(" ");
        if (!command) continue;
        permissions[match[2] as "allow" | "ask" | "deny"].push(command);
      } catch {
        // Ignore malformed user-authored rule lines.
      }
    }
  }

  return permissions;
}

function buildInstruction(
  filePath: string,
): { path: string; content: string; lineCount: number } | null {
  const content = readFileOrNull(filePath);
  if (content === null) return null;
  return { path: filePath, content, lineCount: content.split("\n").length };
}

/**
 * Read Codex CLI user config into the shared setup snapshot shape.
 *
 * Codex keeps most user-global config in config.toml, hook declarations in
 * hooks.json, permission rules under rules/, and skills under skills/.
 */
export function readCodexConfig(): HarnessConfigSnapshot {
  const dir = codexDir();
  const configPath = path.join(dir, "config.toml");
  const hooksJson = readJsonOrNull(path.join(dir, "hooks.json"));
  const settings = fs.existsSync(configPath) ? readTomlFile(configPath) : null;
  const rules = readRules(path.join(dir, "rules"));

  const user: ConfigLayer = {
    settings,
    hooks: hooksJson ? parseHooks(hooksJson) : [],
    mcpServers: settings ? parseMcpServers(settings) : [],
    permissions: parseRulePermissions(rules),
    commands: [],
    agents: [],
    rules,
    skills: readSkills(path.join(dir, "skills")),
  };

  const instructions: HarnessConfigSnapshot["instructions"] = [];
  for (const p of [path.join(dir, "AGENTS.md")]) {
    const instruction = buildInstruction(p);
    if (instruction) instructions.push(instruction);
  }

  return {
    managed: null,
    user,
    project: null,
    projectLocal: null,
    instructions,
    enabledPlugins: [],
    pluginHooks: [],
    panopticonPermissions: readPanopticonPermissions(),
    memoryFiles: {},
  };
}

export function isCodexUserConfigPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  const dir = codexDir().replace(/\\/g, "/").replace(/\/$/, "");
  const rel = p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : null;

  if (p.endsWith("/.codex/config.toml") || rel === "config.toml") return true;
  if (p.endsWith("/.codex/hooks.json") || rel === "hooks.json") return true;
  if (p.includes("/.codex/rules/") && p.endsWith(".rules")) return true;
  if (rel?.startsWith("rules/") && rel.endsWith(".rules")) return true;
  if (p.includes("/.codex/skills/") && p.endsWith("/SKILL.md")) return true;
  if (rel?.startsWith("skills/") && rel.endsWith("/SKILL.md")) return true;
  if (p.endsWith("/.codex/AGENTS.md") || rel === "AGENTS.md") return true;
  return false;
}
