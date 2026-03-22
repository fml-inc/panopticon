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

const { permissionsShow, permissionsApply } = await import("./permissions.js");

const PERMISSIONS_DIR = path.join(mockDataDir, "permissions");
const ALLOWED_PATH = path.join(PERMISSIONS_DIR, "allowed.json");
const APPROVALS_PATH = path.join(PERMISSIONS_DIR, "approvals.json");
const BACKUPS_DIR = path.join(PERMISSIONS_DIR, "backups");

beforeEach(() => {
  fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(mockDataDir, { recursive: true, force: true });
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
});
