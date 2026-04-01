import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigLayer {
  settings: Record<string, unknown> | null;
  hooks: Array<{ event: string; matcher: string | null; type: string }>;
  mcpServers: Array<{ name: string; command: string }>;
  commands: Array<{ name: string; content: string }>;
  agents: Array<{ name: string; content: string }>;
  rules: Array<{ name: string; content: string }>;
  skills: Array<{ name: string; content: string }>;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
}

export interface ClaudeCodeConfig {
  managed: ConfigLayer | null;
  user: ConfigLayer;
  project: ConfigLayer | null;
  projectLocal: ConfigLayer | null;
  instructions: Array<{ path: string; content: string; lineCount: number }>;
  enabledPlugins: Array<{ pluginName: string; marketplace: string }>;
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

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

function readMdFiles(dir: string): Array<{ name: string; content: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: Array<{ name: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const content = readFileOrNull(path.join(dir, entry.name));
    if (content === null) continue;
    results.push({ name: entry.name.replace(/\.md$/, ""), content });
  }
  return results;
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

// ---------------------------------------------------------------------------
// Settings parsers
// ---------------------------------------------------------------------------

function parseHooks(json: Record<string, unknown>): ConfigLayer["hooks"] {
  const hooks: ConfigLayer["hooks"] = [];
  const raw = json.hooks;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return hooks;
  for (const [event, entries] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const matcher = typeof e.matcher === "string" ? e.matcher : null;

      // Current format: entry has a nested `hooks` array
      if (Array.isArray(e.hooks)) {
        for (const hook of e.hooks) {
          if (typeof hook !== "object" || hook === null) continue;
          const h = hook as Record<string, unknown>;
          hooks.push({
            event,
            matcher,
            type: h.type === "command" ? "command" : "script",
          });
        }
      } else {
        // Legacy format: entry IS a hook directly
        hooks.push({
          event,
          matcher,
          type: e.command ? "command" : "script",
        });
      }
    }
  }
  return hooks;
}

function parseMcpServers(
  json: Record<string, unknown>,
): ConfigLayer["mcpServers"] {
  const servers: ConfigLayer["mcpServers"] = [];
  const raw = json.mcpServers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return servers;
  for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof def !== "object" || def === null) continue;
    const s = def as Record<string, unknown>;
    servers.push({
      name,
      command: typeof s.command === "string" ? s.command : "",
    });
  }
  return servers;
}

function parsePermissions(
  json: Record<string, unknown>,
): ConfigLayer["permissions"] {
  const allow: string[] = [];
  const ask: string[] = [];
  const deny: string[] = [];

  function collectStrings(arr: unknown): string[] {
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is string => typeof v === "string");
  }

  // Current format: permissions.allow / permissions.ask / permissions.deny
  const perms = json.permissions;
  if (perms && typeof perms === "object" && !Array.isArray(perms)) {
    const p = perms as Record<string, unknown>;
    allow.push(...collectStrings(p.allow));
    ask.push(...collectStrings(p.ask));
    deny.push(...collectStrings(p.deny));
  }

  // Legacy format: allowedTools / deniedTools (fall back if permissions empty)
  if (allow.length === 0 && deny.length === 0) {
    allow.push(...collectStrings(json.allowedTools));
    deny.push(...collectStrings(json.deniedTools));
  }

  return { allow, ask, deny };
}

function parseEnabledPlugins(
  settings: Record<string, unknown> | null,
): Array<{ pluginName: string; marketplace: string }> {
  if (!settings) return [];
  const raw = settings.enabledPlugins;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const result: Array<{ pluginName: string; marketplace: string }> = [];
  for (const [key, enabled] of Object.entries(raw as Record<string, unknown>)) {
    if (!enabled) continue;
    const atIndex = key.indexOf("@");
    if (atIndex > 0) {
      result.push({
        pluginName: key.slice(0, atIndex),
        marketplace: key.slice(atIndex + 1),
      });
    } else {
      result.push({ pluginName: key, marketplace: "" });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Layer builder
// ---------------------------------------------------------------------------

function buildLayer(
  settingsPath: string,
  dirs: {
    commands?: string;
    agents?: string;
    rules?: string;
    skills?: string;
  },
  mcpJsonPath?: string,
): ConfigLayer {
  const settings = readJsonOrNull(settingsPath);

  // MCP servers: merge settings.json and .mcp.json (settings wins on dupes)
  const mcpFromSettings = settings ? parseMcpServers(settings) : [];
  const mcpFromFile = mcpJsonPath
    ? parseMcpServers(readJsonOrNull(mcpJsonPath) ?? {})
    : [];
  const mcpNames = new Set(mcpFromSettings.map((s) => s.name));
  const mcpServers = [
    ...mcpFromSettings,
    ...mcpFromFile.filter((s) => !mcpNames.has(s.name)),
  ];

  return {
    settings,
    hooks: settings ? parseHooks(settings) : [],
    mcpServers,
    permissions: settings
      ? parsePermissions(settings)
      : { allow: [], ask: [], deny: [] },
    commands: dirs.commands ? readMdFiles(dirs.commands) : [],
    agents: dirs.agents ? readMdFiles(dirs.agents) : [],
    rules: dirs.rules ? readMdFiles(dirs.rules) : [],
    skills: dirs.skills ? readSkills(dirs.skills) : [],
  };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const gitRootCache = new Map<string, string | null>();

/**
 * Resolve the git repository root for a directory.
 * Cached per cwd for the lifetime of the process.
 */
export function resolveGitRoot(cwd: string): string | null {
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd)!;
  let root: string | null = null;
  try {
    root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git repo
  }
  gitRootCache.set(cwd, root);
  return root;
}

/**
 * Check if a file path is gitignored.
 */
export function isGitignored(filePath: string, cwd: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "check-ignore", "-q", filePath], {
      timeout: 3000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true; // exit code 0 = ignored
  } catch {
    return false; // exit code 1 = not ignored, or not a git repo
  }
}

// ---------------------------------------------------------------------------
// Instruction discovery
// ---------------------------------------------------------------------------

function findPerDirectoryClaudeMd(
  root: string,
  excludePaths: Set<string>,
): string[] {
  // Try git ls-files first (fast, respects .gitignore)
  const gitRoot = resolveGitRoot(root);
  if (gitRoot) {
    try {
      const output = execFileSync(
        "git",
        ["-C", gitRoot, "ls-files", "--full-name", "*/CLAUDE.md", "CLAUDE.md"],
        {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (output) {
        return output
          .split("\n")
          .map((rel) => path.resolve(gitRoot, rel))
          .filter((p) => !excludePaths.has(p));
      }
      return [];
    } catch {
      // Fall through to find
    }
  }

  // Fallback: use find command
  try {
    const output = execFileSync(
      "find",
      [
        root,
        "-name",
        "CLAUDE.md",
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.git/*",
      ],
      {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (output) {
      return output
        .split("\n")
        .map((p) => path.resolve(p))
        .filter((p) => !excludePaths.has(p));
    }
  } catch {
    // Fall through
  }

  return [];
}

function buildInstruction(
  filePath: string,
): { path: string; content: string; lineCount: number } | null {
  const content = readFileOrNull(filePath);
  if (content === null) return null;
  return { path: filePath, content, lineCount: content.split("\n").length };
}

function getManagedDir(): string {
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode";
  }
  // Linux, WSL
  return "/etc/claude-code";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all Claude Code config from the filesystem.
 * Returns structured layers (managed, user, project, projectLocal) plus
 * instruction files.
 */
export function readConfig(cwd?: string): ClaudeCodeConfig {
  const rawCwd = cwd ? path.resolve(cwd) : process.cwd();
  // Use git root if available so project config is found even from subdirs
  const root = resolveGitRoot(rawCwd) ?? rawCwd;
  const home = os.homedir();
  const claudeHome = path.join(home, ".claude");
  const dotClaude = path.join(root, ".claude");
  const managedDir = getManagedDir();

  // Managed (enterprise) layer
  let managed: ConfigLayer | null = null;
  const managedSettings = readJsonOrNull(
    path.join(managedDir, "managed-settings.json"),
  );
  if (managedSettings) {
    managed = {
      settings: managedSettings,
      hooks: parseHooks(managedSettings),
      mcpServers: parseMcpServers(managedSettings),
      permissions: parsePermissions(managedSettings),
      commands: [],
      agents: [],
      rules: [],
      skills: [],
    };
  }

  // User layer
  const user = buildLayer(
    path.join(claudeHome, "settings.json"),
    {
      commands: path.join(claudeHome, "commands"),
      rules: path.join(claudeHome, "rules"),
      skills: path.join(claudeHome, "skills"),
    },
    path.join(claudeHome, ".mcp.json"),
  );

  // Project layer — null if no .claude directory
  let project: ConfigLayer | null = null;
  try {
    if (fs.statSync(dotClaude).isDirectory()) {
      project = buildLayer(
        path.join(dotClaude, "settings.json"),
        {
          commands: path.join(dotClaude, "commands"),
          agents: path.join(dotClaude, "agents"),
          rules: path.join(dotClaude, "rules"),
          skills: path.join(dotClaude, "skills"),
        },
        path.join(dotClaude, ".mcp.json"),
      );
    }
  } catch {
    // no .claude directory
  }

  // Project local layer — null if no settings.local.json
  let projectLocal: ConfigLayer | null = null;
  const localSettings = readJsonOrNull(
    path.join(dotClaude, "settings.local.json"),
  );
  if (localSettings) {
    projectLocal = {
      settings: localSettings,
      hooks: parseHooks(localSettings),
      mcpServers: parseMcpServers(localSettings),
      permissions: parsePermissions(localSettings),
      commands: [],
      agents: [],
      rules: [],
      skills: [],
    };
  }

  // Instructions — fixed candidates + per-directory discovery
  const instructions: ClaudeCodeConfig["instructions"] = [];
  const knownPaths = new Set<string>();

  const instructionCandidates = [
    path.join(managedDir, "CLAUDE.md"),
    path.join(claudeHome, "CLAUDE.md"),
    path.join(root, "CLAUDE.md"),
    path.join(dotClaude, "CLAUDE.md"),
    path.join(root, "AGENTS.md"),
  ];

  for (const p of instructionCandidates) {
    const resolved = path.resolve(p);
    const inst = buildInstruction(resolved);
    if (inst) {
      instructions.push(inst);
      knownPaths.add(resolved);
    }
  }

  for (const p of findPerDirectoryClaudeMd(root, knownPaths)) {
    const inst = buildInstruction(p);
    if (inst) instructions.push(inst);
  }

  // Enabled plugins — merge user + project, deduplicate
  const pluginSet = new Set<string>();
  const enabledPlugins: ClaudeCodeConfig["enabledPlugins"] = [];
  for (const layer of [project, user]) {
    for (const p of parseEnabledPlugins(layer?.settings ?? null)) {
      const key = `${p.pluginName}@${p.marketplace}`;
      if (!pluginSet.has(key)) {
        pluginSet.add(key);
        enabledPlugins.push(p);
      }
    }
  }

  return { managed, user, project, projectLocal, instructions, enabledPlugins };
}

/**
 * Merge-write a settings patch into the given layer's settings.json.
 */
export function writeSettings(
  level: "project" | "projectLocal" | "user",
  patch: Record<string, unknown>,
  cwd?: string,
): void {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const home = os.homedir();

  let filePath: string;
  switch (level) {
    case "project":
      filePath = path.join(root, ".claude", "settings.json");
      break;
    case "projectLocal":
      filePath = path.join(root, ".claude", "settings.local.json");
      break;
    case "user":
      filePath = path.join(home, ".claude", "settings.json");
      break;
  }

  const existing = readJsonOrNull(filePath) ?? {};
  const merged = { ...existing, ...patch };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`);
}

/**
 * Write a config file (command, agent, rule, or skill) to the given layer.
 */
export function writeFile(
  level: "project" | "user",
  type: "command" | "agent" | "rule" | "skill",
  name: string,
  content: string,
  cwd?: string,
): void {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const home = os.homedir();

  const base =
    level === "project"
      ? path.join(root, ".claude")
      : path.join(home, ".claude");

  if (type === "skill") {
    const dir = path.join(base, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  } else {
    const dir = path.join(base, `${type}s`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), content);
  }
}
