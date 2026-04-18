import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, writeFile, writeSettings } from "./scanner.js";

describe("readConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty/null for an empty directory", () => {
    const result = readConfig(tmpDir);

    expect(result.managed).toBeNull(); // no managed settings on test machine
    expect(result.project).toBeNull();
    expect(result.projectLocal).toBeNull();
    // user layer reads from ~/.claude so we just check it's a valid layer
    expect(result.user).toBeDefined();
    expect(result.user.commands).toBeDefined();
    expect(result.user.skills).toBeDefined();
    // no instructions in the tmp dir
    const projectInstructions = result.instructions.filter((i) =>
      i.path.startsWith(tmpDir),
    );
    expect(projectInstructions).toEqual([]);
  });

  it("includes panopticonPermissions and memoryFiles fields", () => {
    const result = readConfig(tmpDir);

    // Shape-only checks — the actual files depend on the host machine
    expect(result.panopticonPermissions).toBeDefined();
    expect(result.panopticonPermissions).toHaveProperty("allowed");
    expect(result.panopticonPermissions).toHaveProperty("approvals");
    const allowed = result.panopticonPermissions.allowed;
    expect(allowed === null || typeof allowed === "object").toBe(true);

    expect(result.memoryFiles).toBeDefined();
    expect(typeof result.memoryFiles).toBe("object");
    // If any memory files exist, inner values must be strings (md content)
    for (const files of Object.values(result.memoryFiles)) {
      expect(typeof files).toBe("object");
      for (const content of Object.values(files)) {
        expect(typeof content).toBe("string");
      }
    }
  });

  it("returns project layer when .claude directory exists", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });

    const result = readConfig(tmpDir);

    expect(result.project).not.toBeNull();
    expect(result.project!.settings).toBeNull();
    expect(result.project!.hooks).toEqual([]);
    expect(result.project!.commands).toEqual([]);
    expect(result.project!.agents).toEqual([]);
    expect(result.project!.rules).toEqual([]);
    expect(result.project!.skills).toEqual([]);
  });

  // -- Permissions --------------------------------------------------------

  it("parses current permissions format (permissions.allow/ask/deny)", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(npm test)", "Read"],
          ask: ["Bash(git push *)"],
          deny: ["Bash(rm -rf *)"],
        },
      }),
    );

    const result = readConfig(tmpDir);

    expect(result.project!.permissions).toEqual({
      allow: ["Bash(npm test)", "Read"],
      ask: ["Bash(git push *)"],
      deny: ["Bash(rm -rf *)"],
    });
  });

  it("falls back to legacy allowedTools/deniedTools", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({
        allowedTools: ["Bash(npm test)", "Read"],
        deniedTools: ["Bash(rm -rf *)"],
      }),
    );

    const result = readConfig(tmpDir);

    expect(result.project!.permissions).toEqual({
      allow: ["Bash(npm test)", "Read"],
      ask: [],
      deny: ["Bash(rm -rf *)"],
    });
  });

  it("prefers permissions object over legacy keys", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Read"], ask: [], deny: [] },
        allowedTools: ["Bash(npm test)", "Read", "Write"],
      }),
    );

    const result = readConfig(tmpDir);

    // permissions object wins
    expect(result.project!.permissions.allow).toEqual(["Read"]);
  });

  // -- Hooks --------------------------------------------------------------

  it("parses legacy flat hook format", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", command: "lint-check" },
            { matcher: "Write", command: "format-check" },
          ],
          Stop: [{ command: "session-summary" }],
        },
      }),
    );

    const result = readConfig(tmpDir);

    expect(result.project!.hooks).toHaveLength(3);
    expect(result.project!.hooks[0]).toEqual({
      event: "PreToolUse",
      matcher: "Bash",
      type: "command",
    });
    expect(result.project!.hooks[2]).toEqual({
      event: "Stop",
      matcher: null,
      type: "command",
    });
  });

  it("parses current nested hook format", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [
                { type: "command", command: "check-style.sh" },
                { type: "command", command: "lint.sh" },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [{ type: "prompt", prompt: "Set up dev env" }],
            },
          ],
        },
      }),
    );

    const result = readConfig(tmpDir);

    expect(result.project!.hooks).toHaveLength(3);
    expect(result.project!.hooks[0]).toEqual({
      event: "PreToolUse",
      matcher: "Write|Edit",
      type: "command",
    });
    expect(result.project!.hooks[1]).toEqual({
      event: "PreToolUse",
      matcher: "Write|Edit",
      type: "command",
    });
    // prompt type is not "command"
    expect(result.project!.hooks[2]).toEqual({
      event: "SessionStart",
      matcher: null,
      type: "script",
    });
  });

  it("parses legacy script-type hooks", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "Bash", script: "echo done" }],
        },
      }),
    );

    const result = readConfig(tmpDir);

    expect(result.project!.hooks).toEqual([
      { event: "PostToolUse", matcher: "Bash", type: "script" },
    ]);
  });

  // -- MCP servers --------------------------------------------------------

  it("parses MCP servers from settings.json", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "mcp-github"] },
        },
      }),
    );

    const result = readConfig(tmpDir);

    expect(result.project!.mcpServers).toEqual([
      { name: "github", command: "npx" },
    ]);
  });

  it("reads MCP servers from .mcp.json and merges with settings", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx" },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".claude", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "overridden-should-not-appear" },
          postgres: { command: "node" },
        },
      }),
    );

    const result = readConfig(tmpDir);
    const names = result.project!.mcpServers.map((s) => s.name);

    expect(names).toEqual(["github", "postgres"]);
    // settings.json wins for dupes
    expect(result.project!.mcpServers[0].command).toBe("npx");
  });

  // -- Commands, agents, rules --------------------------------------------

  it("reads commands from .claude/commands/", () => {
    const commandsDir = path.join(tmpDir, ".claude", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, "review.md"),
      "Review the current changes for correctness.\nFocus on security.",
    );
    fs.writeFileSync(path.join(commandsDir, "deploy.md"), "Deploy to staging.");
    fs.writeFileSync(path.join(commandsDir, "notes.txt"), "Not a command");

    const result = readConfig(tmpDir);
    const names = result.project!.commands.map((c) => c.name).sort();

    expect(names).toEqual(["deploy", "review"]);
    const review = result.project!.commands.find((c) => c.name === "review");
    expect(review!.content).toContain("Focus on security");
  });

  it("reads agents and rules", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude", "agents"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "agents", "reviewer.md"),
      "You are a code reviewer.",
    );
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "rules", "no-any.md"),
      "Never use TypeScript any.",
    );

    const result = readConfig(tmpDir);

    expect(result.project!.agents).toEqual([
      { name: "reviewer", content: "You are a code reviewer." },
    ]);
    expect(result.project!.rules).toEqual([
      { name: "no-any", content: "Never use TypeScript any." },
    ]);
  });

  // -- Skills -------------------------------------------------------------

  it("reads skills from .claude/skills/", () => {
    const skillDir = path.join(tmpDir, ".claude", "skills", "deploy");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "Deploy the application to staging.",
    );
    // Directory without SKILL.md should be ignored
    fs.mkdirSync(path.join(tmpDir, ".claude", "skills", "empty"), {
      recursive: true,
    });

    const result = readConfig(tmpDir);

    expect(result.project!.skills).toEqual([
      { name: "deploy", content: "Deploy the application to staging." },
    ]);
  });

  // -- Project local ------------------------------------------------------

  it("reads projectLocal from settings.local.json", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ command: "local-cleanup" }],
        },
        mcpServers: {
          localDb: { command: "node" },
        },
        permissions: {
          allow: ["Bash(pnpm dev)"],
        },
      }),
    );

    const result = readConfig(tmpDir);

    expect(result.projectLocal).not.toBeNull();
    expect(result.projectLocal!.hooks).toEqual([
      { event: "Stop", matcher: null, type: "command" },
    ]);
    expect(result.projectLocal!.mcpServers).toEqual([
      { name: "localDb", command: "node" },
    ]);
    expect(result.projectLocal!.permissions.allow).toEqual(["Bash(pnpm dev)"]);
    expect(result.projectLocal!.commands).toEqual([]);
    expect(result.projectLocal!.agents).toEqual([]);
    expect(result.projectLocal!.skills).toEqual([]);
  });

  // -- Instructions -------------------------------------------------------

  it("collects instruction files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "# Project\n\nRoot instructions\n",
    );
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "DotClaude instructions\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "Agent-level instructions\n",
    );

    const result = readConfig(tmpDir);
    const projectInstructions = result.instructions.filter((i) =>
      i.path.startsWith(tmpDir),
    );

    expect(projectInstructions).toHaveLength(3);
    const paths = projectInstructions.map((i) => path.basename(i.path));
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("AGENTS.md");
  });

  it("finds per-directory CLAUDE.md files", () => {
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "Root\n");
    fs.mkdirSync(path.join(tmpDir, "src", "api"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "api", "CLAUDE.md"),
      "API guidelines\n",
    );
    fs.mkdirSync(path.join(tmpDir, "src", "ui"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "ui", "CLAUDE.md"),
      "UI guidelines\n",
    );

    const result = readConfig(tmpDir);
    const projectInstructions = result.instructions.filter((i) =>
      i.path.startsWith(tmpDir),
    );

    expect(projectInstructions).toHaveLength(3);
    const paths = projectInstructions.map((i) => i.path);
    expect(paths).toContain(path.resolve(tmpDir, "src", "api", "CLAUDE.md"));
    expect(paths).toContain(path.resolve(tmpDir, "src", "ui", "CLAUDE.md"));
  });

  it("excludes node_modules and .git from per-directory scan", () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules", "pkg"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "pkg", "CLAUDE.md"),
      "Ignored\n",
    );
    fs.mkdirSync(path.join(tmpDir, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".git", "hooks", "CLAUDE.md"),
      "Ignored\n",
    );

    const result = readConfig(tmpDir);
    const projectInstructions = result.instructions.filter((i) =>
      i.path.startsWith(tmpDir),
    );

    expect(projectInstructions).toEqual([]);
  });

  it("includes lineCount in instructions", () => {
    fs.writeFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "Line 1\nLine 2\nLine 3\n",
    );

    const result = readConfig(tmpDir);
    const root = result.instructions.find(
      (i) => i.path === path.resolve(tmpDir, "CLAUDE.md"),
    );

    expect(root).toBeDefined();
    expect(root!.lineCount).toBe(4);
  });

  // -- Edge cases ---------------------------------------------------------

  it("handles malformed settings.json gracefully", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      "not valid json{{{",
    );

    const result = readConfig(tmpDir);

    expect(result.project!.settings).toBeNull();
    expect(result.project!.hooks).toEqual([]);
    expect(result.project!.mcpServers).toEqual([]);
  });
});

describe("writeSettings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-write-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates settings.json when it does not exist", () => {
    writeSettings(
      "project",
      { permissions: { allow: ["Read"], ask: [], deny: [] } },
      tmpDir,
    );

    const filePath = path.join(tmpDir, ".claude", "settings.json");
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content).toEqual({
      permissions: { allow: ["Read"], ask: [], deny: [] },
    });
  });

  it("merges into existing settings.json", () => {
    const dir = path.join(tmpDir, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Read"], ask: [], deny: [] },
        existing: true,
      }),
    );

    writeSettings("project", { model: "claude-sonnet-4-6" }, tmpDir);

    const content = JSON.parse(
      fs.readFileSync(path.join(dir, "settings.json"), "utf-8"),
    );
    expect(content).toEqual({
      permissions: { allow: ["Read"], ask: [], deny: [] },
      existing: true,
      model: "claude-sonnet-4-6",
    });
  });

  it("writes settings.local.json for projectLocal level", () => {
    writeSettings("projectLocal", { hooks: {} }, tmpDir);

    const filePath = path.join(tmpDir, ".claude", "settings.local.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content).toEqual({ hooks: {} });
  });
});

describe("writeFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-writefile-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a command file to .claude/commands/", () => {
    writeFile("project", "command", "review", "Review all changes.", tmpDir);

    const filePath = path.join(tmpDir, ".claude", "commands", "review.md");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Review all changes.");
  });

  it("writes an agent file to .claude/agents/", () => {
    writeFile("project", "agent", "reviewer", "You review code.", tmpDir);

    const filePath = path.join(tmpDir, ".claude", "agents", "reviewer.md");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("You review code.");
  });

  it("writes a rule file to .claude/rules/", () => {
    writeFile("project", "rule", "no-any", "Never use any.", tmpDir);

    const filePath = path.join(tmpDir, ".claude", "rules", "no-any.md");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Never use any.");
  });

  it("writes a skill as SKILL.md in .claude/skills/<name>/", () => {
    writeFile("project", "skill", "deploy", "Deploy to staging.", tmpDir);

    const filePath = path.join(
      tmpDir,
      ".claude",
      "skills",
      "deploy",
      "SKILL.md",
    );
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Deploy to staging.");
  });

  it("creates directories if they do not exist", () => {
    writeFile("project", "command", "test", "Run tests.", tmpDir);

    const dir = path.join(tmpDir, ".claude", "commands");
    expect(fs.existsSync(dir)).toBe(true);
  });
});
