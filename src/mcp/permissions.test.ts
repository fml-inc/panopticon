import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config before importing permissions module
const mockDataDir = path.join(os.tmpdir(), `panopticon-test-${process.pid}`);

vi.mock("../config.js", () => ({
  config: {
    get dataDir() {
      return mockDataDir;
    },
  },
}));

const mockCodexDir = path.join(
  os.tmpdir(),
  `panopticon-codex-test-${process.pid}`,
);
process.env.PANOPTICON_CODEX_DIR = mockCodexDir;

const { permissionsShow, permissionsPreview, permissionsApply } = await import(
  "./permissions.js"
);

const PERMISSIONS_DIR = path.join(mockDataDir, "permissions");
const ALLOWED_PATH = path.join(PERMISSIONS_DIR, "allowed.json");
const APPROVALS_PATH = path.join(PERMISSIONS_DIR, "approvals.json");
const BACKUPS_DIR = path.join(PERMISSIONS_DIR, "backups");
const CODEX_RULES_PATH = path.join(mockCodexDir, "rules", "panopticon.rules");

beforeEach(() => {
  fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(mockDataDir, { recursive: true, force: true });
  fs.rmSync(mockCodexDir, { recursive: true, force: true });
});

describe("permissionsShow", () => {
  it("returns defaults when no files exist", () => {
    // Remove the dir we created in beforeEach so files don't exist
    fs.rmSync(PERMISSIONS_DIR, { recursive: true, force: true });

    const result = permissionsShow();
    expect(result.approvals).toEqual({
      approved_categories: ["safe"],
      denied_categories: [],
      custom_overrides: {},
      last_run: null,
    });
    expect(result.allowed).toEqual({ bash_commands: [], tools: [] });
    expect(result.approvals_path).toBe(APPROVALS_PATH);
    expect(result.allowed_path).toBe(ALLOWED_PATH);
  });

  it("reads existing approvals and allowed files", () => {
    const approvals = {
      approved_categories: ["safe", "low_check"],
      denied_categories: ["high_destructive"],
      custom_overrides: {},
      last_run: "2026-01-01T00:00:00.000Z",
    };
    const allowed = {
      bash_commands: ["ls", "git status"],
      tools: ["Read", "Grep"],
    };
    fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals));
    fs.writeFileSync(ALLOWED_PATH, JSON.stringify(allowed));

    const result = permissionsShow();
    expect(result.approvals).toEqual(approvals);
    expect(result.allowed).toEqual(allowed);
  });
});

describe("permissionsApply", () => {
  const minimalCategories = {
    safe: {
      status: "approved" as const,
      patterns: ["Bash(ls *)"],
      observed_commands: ["ls"],
      call_count: 10,
    },
  };

  it("splits Bash patterns from tool names", () => {
    const result = permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: [
        "Bash(ls *)",
        "Bash(git status *)",
        "Read",
        "Grep",
        "Bash(pnpm type-check *)",
      ],
      categories: minimalCategories,
    });

    expect(result.success).toBe(true);

    const allowed = JSON.parse(fs.readFileSync(ALLOWED_PATH, "utf-8"));
    expect(allowed.bash_commands).toEqual([
      "ls",
      "git status",
      "pnpm type-check",
    ]);
    expect(allowed.tools).toEqual(["Read", "Grep"]);
  });

  it("always includes 'safe' in approved_categories", () => {
    permissionsApply({
      approved_categories: ["medium_build"],
      denied_categories: [],
      permissions: [],
      categories: {},
    });

    const approvals = JSON.parse(fs.readFileSync(APPROVALS_PATH, "utf-8"));
    expect(approvals.approved_categories).toContain("safe");
    expect(approvals.approved_categories).toContain("medium_build");
  });

  it("deduplicates categories", () => {
    permissionsApply({
      approved_categories: ["safe", "safe", "low_check"],
      denied_categories: ["high_destructive", "high_destructive"],
      permissions: [],
      categories: {},
    });

    const approvals = JSON.parse(fs.readFileSync(APPROVALS_PATH, "utf-8"));
    expect(approvals.approved_categories).toEqual(["safe", "low_check"]);
    expect(approvals.denied_categories).toEqual(["high_destructive"]);
  });

  it("creates timestamped backup", () => {
    permissionsApply({
      repository: "org/repo",
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Read"],
      categories: minimalCategories,
    });

    const backups = fs.readdirSync(BACKUPS_DIR);
    expect(backups).toHaveLength(1);

    const backup = JSON.parse(
      fs.readFileSync(path.join(BACKUPS_DIR, backups[0]), "utf-8"),
    );
    expect(backup.repository).toBe("org/repo");
    expect(backup.generated_permissions).toEqual(["Read"]);
    expect(backup.approvals_state.approved_categories).toContain("safe");
  });

  it("writes allowed.json with updated timestamp", () => {
    permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(find *)"],
      categories: {},
    });

    const allowed = JSON.parse(fs.readFileSync(ALLOWED_PATH, "utf-8"));
    expect(allowed.updated).toBeTruthy();
    expect(new Date(allowed.updated).getTime()).toBeGreaterThan(0);
  });

  it("handles empty permissions list", () => {
    const result = permissionsApply({
      approved_categories: [],
      denied_categories: [],
      permissions: [],
      categories: {},
    });

    expect(result.success).toBe(true);
    const allowed = JSON.parse(fs.readFileSync(ALLOWED_PATH, "utf-8"));
    expect(allowed.bash_commands).toEqual([]);
    expect(allowed.tools).toEqual([]);
  });

  it("handles MCP tool names in permissions", () => {
    permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: [
        "mcp__plugin_panopticon_panopticon__panopticon_query",
        "WebSearch",
        "Bash(ls *)",
      ],
      categories: {},
    });

    const allowed = JSON.parse(fs.readFileSync(ALLOWED_PATH, "utf-8"));
    expect(allowed.tools).toEqual([
      "mcp__plugin_panopticon_panopticon__panopticon_query",
      "WebSearch",
    ]);
    expect(allowed.bash_commands).toEqual(["ls"]);
  });

  it("overwrites previous allowed.json on re-apply", () => {
    permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Read", "Bash(ls *)"],
      categories: {},
    });

    permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Grep"],
      categories: {},
    });

    const allowed = JSON.parse(fs.readFileSync(ALLOWED_PATH, "utf-8"));
    expect(allowed.tools).toEqual(["Grep"]);
    expect(allowed.bash_commands).toEqual([]);
  });

  it("returns diff in the apply result", () => {
    permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(ls *)", "Read"],
      categories: {},
    });

    const result = permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(ls *)", "Bash(git log *)", "Grep"],
      categories: {},
    });

    expect(result.diff.added.sort()).toEqual(["Bash(git log *)", "Grep"]);
    expect(result.diff.removed).toEqual(["Read"]);
    expect(result.diff.unchanged).toEqual(["Bash(ls *)"]);
  });

  it("leaves no .tmp files behind", () => {
    permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(ls *)", "Read"],
      categories: {},
    });

    const leftovers = fs
      .readdirSync(PERMISSIONS_DIR)
      .filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("permissionsPreview", () => {
  it("writes nothing to disk", () => {
    const before = fs.existsSync(ALLOWED_PATH);
    permissionsPreview({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(ls *)", "Read"],
      categories: {},
    });
    expect(fs.existsSync(ALLOWED_PATH)).toBe(before);
  });

  it("returns structured diff against current allowed state", () => {
    permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(ls *)", "Read"],
      categories: {},
    });

    const preview = permissionsPreview({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(ls *)", "Bash(git log *)", "Grep"],
      categories: {},
    });

    expect(preview.diff.added.sort()).toEqual(["Bash(git log *)", "Grep"]);
    expect(preview.diff.removed).toEqual(["Read"]);
    expect(preview.diff.unchanged).toEqual(["Bash(ls *)"]);
    expect(preview.proposed.allowed.bash_commands).toEqual(["ls", "git log"]);
  });
});

describe("codex target", () => {
  it("permissionsShow reports codex as not installed when dir is missing", () => {
    // Ensure codex dir does not exist
    fs.rmSync(mockCodexDir, { recursive: true, force: true });
    const result = permissionsShow();
    expect(result.codex.installed).toBe(false);
    expect(result.codex.rules_path).toBeNull();
    expect(result.codex.rule_count).toBe(0);
  });

  it("permissionsShow reports installed codex and counts existing rules", () => {
    fs.mkdirSync(path.join(mockCodexDir, "rules"), { recursive: true });
    fs.writeFileSync(
      CODEX_RULES_PATH,
      '# header\nprefix_rule(pattern = ["ls"], decision = "allow", justification = "x")\nprefix_rule(pattern = ["git", "status"], decision = "allow", justification = "x")\n',
    );

    const result = permissionsShow();
    expect(result.codex.installed).toBe(true);
    expect(result.codex.rules_path).toBe(CODEX_RULES_PATH);
    expect(result.codex.rule_count).toBe(2);
  });

  it("permissionsApply writes codex rules when installed", () => {
    fs.mkdirSync(mockCodexDir, { recursive: true });

    const result = permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(ls *)", "Bash(npx tsup *)", "Read"],
      categories: {},
    });

    expect(result.codex.installed).toBe(true);
    expect(result.codex.rule_count).toBe(2);
    expect(result.codex.error).toBeUndefined();

    const rules = fs.readFileSync(CODEX_RULES_PATH, "utf-8");
    expect(rules).toContain('prefix_rule(pattern = ["ls"]');
    expect(rules).toContain('prefix_rule(pattern = ["npx", "tsup"]');
  });

  it("permissionsApply skips codex when dir is missing but still succeeds", () => {
    fs.rmSync(mockCodexDir, { recursive: true, force: true });

    const result = permissionsApply({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(ls *)"],
      categories: {},
    });

    expect(result.success).toBe(true);
    expect(result.codex.installed).toBe(false);
    expect(result.codex.rules_path).toBeNull();
    expect(fs.existsSync(CODEX_RULES_PATH)).toBe(false);
  });

  it("permissionsPreview returns codex diff when installed", () => {
    fs.mkdirSync(path.join(mockCodexDir, "rules"), { recursive: true });
    fs.writeFileSync(
      CODEX_RULES_PATH,
      '# header\nprefix_rule(pattern = ["ls"], decision = "allow", justification = "x")\n',
    );

    const preview = permissionsPreview({
      approved_categories: ["safe"],
      denied_categories: [],
      permissions: ["Bash(ls *)", "Bash(npx tsup *)"],
      categories: {},
    });

    expect(preview.codex.installed).toBe(true);
    expect(preview.codex.proposed_rule_count).toBe(2);
    expect(preview.codex.diff.added).toEqual(["prefix_rule: npx tsup"]);
    expect(preview.codex.diff.unchanged).toEqual(["prefix_rule: ls"]);
  });
});
