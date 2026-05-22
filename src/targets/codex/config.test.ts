import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCodexUserConfigPath, readCodexConfig } from "./config.js";

describe("readCodexConfig", () => {
  let tmpCodexDir: string;

  beforeEach(() => {
    tmpCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-test-"));
    process.env.PANOPTICON_CODEX_DIR = tmpCodexDir;
  });

  afterEach(() => {
    delete process.env.PANOPTICON_CODEX_DIR;
    fs.rmSync(tmpCodexDir, { recursive: true, force: true });
  });

  it("captures Codex config, hooks, MCP servers, rules, skills, and instructions", () => {
    fs.mkdirSync(path.join(tmpCodexDir, "rules"), { recursive: true });
    fs.mkdirSync(path.join(tmpCodexDir, "skills", "review"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpCodexDir, "config.toml"),
      [
        'model = "gpt-5-codex"',
        "",
        "[features]",
        "hooks = true",
        "",
        "[mcp_servers.panopticon]",
        'command = "node"',
        'args = ["/opt/panopticon/bin/mcp-server"]',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpCodexDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "node hook-handler" }],
            },
          ],
          state: {
            "ignored:session_start:0:0": {
              trusted_hash: "sha256:trusted",
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpCodexDir, "rules", "panopticon.rules"),
      [
        'prefix_rule(pattern = ["git", "status"], decision = "allow", justification = "Approved")',
        'prefix_rule(pattern = ["npm", "publish"], decision = "deny", justification = "No")',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpCodexDir, "skills", "review", "SKILL.md"),
      "# Review\n",
    );
    fs.writeFileSync(path.join(tmpCodexDir, "AGENTS.md"), "# Codex\n");

    const result = readCodexConfig();

    expect(result.managed).toBeNull();
    expect(result.project).toBeNull();
    expect(result.user.settings).toMatchObject({
      model: "gpt-5-codex",
      features: { hooks: true },
    });
    expect(result.user.hooks).toEqual([
      { event: "SessionStart", matcher: null, type: "command" },
    ]);
    expect(result.user.mcpServers).toEqual([
      { name: "panopticon", command: "node" },
    ]);
    expect(result.user.permissions).toEqual({
      allow: ["git status"],
      ask: [],
      deny: ["npm publish"],
    });
    expect(result.user.rules).toHaveLength(1);
    expect(result.user.skills).toEqual([
      { name: "review", content: "# Review\n" },
    ]);
    expect(result.instructions).toMatchObject([
      { path: path.join(tmpCodexDir, "AGENTS.md"), content: "# Codex\n" },
    ]);
    expect(result.enabledPlugins).toEqual([]);
    expect(result.pluginHooks).toEqual([]);
  });
});

describe("isCodexUserConfigPath", () => {
  it("matches Codex user config inventory files", () => {
    expect(isCodexUserConfigPath("/Users/gus/.codex/config.toml")).toBe(true);
    expect(isCodexUserConfigPath("/Users/gus/.codex/hooks.json")).toBe(true);
    expect(isCodexUserConfigPath("/Users/gus/.codex/rules/default.rules")).toBe(
      true,
    );
    expect(
      isCodexUserConfigPath("/Users/gus/.codex/skills/review/SKILL.md"),
    ).toBe(true);
    expect(isCodexUserConfigPath("/Users/gus/.codex/AGENTS.md")).toBe(true);
  });

  it("matches PANOPTICON_CODEX_DIR override paths", () => {
    const previous = process.env.PANOPTICON_CODEX_DIR;
    process.env.PANOPTICON_CODEX_DIR = "/tmp/custom-codex";
    try {
      expect(isCodexUserConfigPath("/tmp/custom-codex/config.toml")).toBe(true);
      expect(
        isCodexUserConfigPath("/tmp/custom-codex/skills/review/SKILL.md"),
      ).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.PANOPTICON_CODEX_DIR;
      } else {
        process.env.PANOPTICON_CODEX_DIR = previous;
      }
    }
  });

  it("does not match unrelated or non-global Codex files", () => {
    expect(isCodexUserConfigPath("/Users/gus/workspace/foo.ts")).toBe(false);
    expect(isCodexUserConfigPath("/Users/gus/.codex/history.jsonl")).toBe(
      false,
    );
    expect(isCodexUserConfigPath("/Users/gus/.codex/sessions/x.jsonl")).toBe(
      false,
    );
    expect(isCodexUserConfigPath("/Users/gus/.agents/skills/x/SKILL.md")).toBe(
      false,
    );
  });
});
