import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../config.js", () => {
  const _fs = require("node:fs");
  const _os = require("node:os");
  const _path = require("node:path");
  const tmpDir = _path.join(_os.tmpdir(), "pano-scanner-store-test");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: _path.join(tmpDir, "panopticon.db"),
      port: 4318,
      host: "127.0.0.1",
      serverPidFile: _path.join(tmpDir, "panopticon.pid"),
    },
    ensureDataDir: () => _fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import type { ParsedMessage } from "../targets/types.js";
import {
  insertMessages,
  shouldResetWatermark,
  upsertSession,
} from "./store.js";

function makeAssistantToolMessage(args: {
  sessionId: string;
  inputJson: string;
  toolName?: string;
  timestampMs?: number;
}): ParsedMessage {
  return {
    sessionId: args.sessionId,
    ordinal: 0,
    role: "assistant",
    content: "",
    timestampMs: args.timestampMs ?? 2,
    hasThinking: false,
    hasToolUse: true,
    isSystem: false,
    contentLength: 0,
    hasContextTokens: false,
    hasOutputTokens: false,
    toolCalls: [
      {
        toolUseId: `call-${args.toolName ?? "exec-command"}`,
        toolName: args.toolName ?? "exec_command",
        category: "Bash",
        inputJson: args.inputJson,
        timestampMs: args.timestampMs ?? 2,
      },
    ],
    toolResults: new Map(),
  };
}

function makeGitRepo(slug: string): string {
  const repoRoot = fs.mkdtempSync(path.join(config.dataDir, "repo-"));
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync(
    "git",
    ["remote", "add", "origin", `git@github.com:${slug}.git`],
    {
      cwd: repoRoot,
      stdio: "ignore",
    },
  );
  return repoRoot;
}

beforeAll(() => {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb();
});

afterAll(() => {
  closeDb();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM tool_calls").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM session_repositories").run();
  db.prepare("DELETE FROM session_cwds").run();
  db.prepare("DELETE FROM sessions").run();
});

describe("shouldResetWatermark", () => {
  it("returns false when the watermark is at byte 0 (fresh file)", () => {
    // Even if currentSize is somehow weird, a 0 watermark means we're
    // about to reparse from the start anyway — nothing to reset.
    expect(shouldResetWatermark(0, 0)).toBe(false);
    expect(shouldResetWatermark(100, 0)).toBe(false);
  });

  it("returns false when the file has grown (or stayed equal)", () => {
    expect(shouldResetWatermark(500, 100)).toBe(false);
    expect(shouldResetWatermark(100, 100)).toBe(false);
  });

  it("returns true when the file is smaller than the watermark", () => {
    // Truncation: rotated log, `> file`, partial overwrite.
    expect(shouldResetWatermark(50, 100)).toBe(true);
    // Recreation with smaller content: rm + new file.
    expect(shouldResetWatermark(0, 100)).toBe(true);
  });

  it("does not detect same-size replacement (acknowledged limitation)", () => {
    // File replaced with content of identical length — cannot detect via
    // size alone. Documented in the function comment; would need an
    // inode/mtime check to catch.
    expect(shouldResetWatermark(100, 100)).toBe(false);
  });
});

describe("scanner tool input attribution", () => {
  it("records exec_command workdir as a session cwd and repository", () => {
    const sessionId = "scanner-workdir-session";
    const launchCwd = fs.mkdtempSync(path.join(config.dataDir, "workspace-"));
    const repoRoot = makeGitRepo("fml-inc/panopticon");

    upsertSession(
      {
        sessionId,
        cwd: launchCwd,
        startedAtMs: 1,
      },
      path.join(config.dataDir, "session.jsonl"),
      "codex",
    );
    insertMessages([
      makeAssistantToolMessage({
        sessionId,
        inputJson: JSON.stringify({
          cmd: "sed -n '1,240p' README.md",
          workdir: repoRoot,
        }),
      }),
    ]);

    const cwds = getDb()
      .prepare(
        `SELECT cwd FROM session_cwds
         WHERE session_id = ?
         ORDER BY first_seen_ms ASC, cwd ASC`,
      )
      .all(sessionId) as Array<{ cwd: string }>;
    const repos = getDb()
      .prepare(
        `SELECT repository FROM session_repositories
         WHERE session_id = ?
         ORDER BY repository ASC`,
      )
      .all(sessionId) as Array<{ repository: string }>;

    expect(cwds.map((r) => r.cwd)).toEqual([launchCwd, repoRoot]);
    expect(repos.map((r) => r.repository)).toEqual(["fml-inc/panopticon"]);
  });

  it("records EnterWorktree path as a session cwd and repository", () => {
    const sessionId = "scanner-enter-worktree-session";
    const launchCwd = fs.mkdtempSync(path.join(config.dataDir, "workspace-"));
    const worktreeRoot = makeGitRepo("fml-inc/panopticon");

    upsertSession(
      {
        sessionId,
        cwd: launchCwd,
        startedAtMs: 1,
      },
      path.join(config.dataDir, "session.jsonl"),
      "codex",
    );
    insertMessages([
      makeAssistantToolMessage({
        sessionId,
        toolName: "EnterWorktree",
        inputJson: JSON.stringify({
          path: worktreeRoot,
        }),
      }),
    ]);

    const cwds = getDb()
      .prepare(
        `SELECT cwd FROM session_cwds
         WHERE session_id = ?
         ORDER BY first_seen_ms ASC, cwd ASC`,
      )
      .all(sessionId) as Array<{ cwd: string }>;
    const repos = getDb()
      .prepare(
        `SELECT repository FROM session_repositories
         WHERE session_id = ?
         ORDER BY repository ASC`,
      )
      .all(sessionId) as Array<{ repository: string }>;

    expect(cwds.map((r) => r.cwd)).toEqual([launchCwd, worktreeRoot]);
    expect(repos.map((r) => r.repository)).toEqual(["fml-inc/panopticon"]);
  });

  it("records repo-only path fields as repositories without adding cwds", () => {
    const sessionId = "scanner-repo-path-session";
    const launchCwd = fs.mkdtempSync(path.join(config.dataDir, "workspace-"));
    const repoRoot = makeGitRepo("fml-inc/panopticon");
    const srcDir = path.join(repoRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, "index.ts");
    fs.writeFileSync(filePath, "export {};\n");

    upsertSession(
      {
        sessionId,
        cwd: launchCwd,
        startedAtMs: 1,
      },
      path.join(config.dataDir, "session.jsonl"),
      "codex",
    );
    insertMessages([
      makeAssistantToolMessage({
        sessionId,
        inputJson: JSON.stringify({
          repo_root: repoRoot,
          dir_path: srcDir,
          file_path: filePath,
          path: srcDir,
        }),
      }),
    ]);

    const cwds = getDb()
      .prepare(
        `SELECT cwd FROM session_cwds
         WHERE session_id = ?
         ORDER BY first_seen_ms ASC, cwd ASC`,
      )
      .all(sessionId) as Array<{ cwd: string }>;
    const repos = getDb()
      .prepare(
        `SELECT repository FROM session_repositories
         WHERE session_id = ?
         ORDER BY repository ASC`,
      )
      .all(sessionId) as Array<{ repository: string }>;

    expect(cwds.map((r) => r.cwd)).toEqual([launchCwd]);
    expect(repos.map((r) => r.repository)).toEqual(["fml-inc/panopticon"]);
  });

  it("records tool input repository slugs directly", () => {
    const sessionId = "scanner-repository-slug-session";
    const launchCwd = fs.mkdtempSync(path.join(config.dataDir, "workspace-"));

    upsertSession(
      {
        sessionId,
        cwd: launchCwd,
        startedAtMs: 1,
      },
      path.join(config.dataDir, "session.jsonl"),
      "codex",
    );
    insertMessages([
      makeAssistantToolMessage({
        sessionId,
        inputJson: JSON.stringify({
          repository: "fml-inc/panopticon",
        }),
      }),
    ]);

    const cwds = getDb()
      .prepare(
        `SELECT cwd FROM session_cwds
         WHERE session_id = ?
         ORDER BY first_seen_ms ASC, cwd ASC`,
      )
      .all(sessionId) as Array<{ cwd: string }>;
    const repos = getDb()
      .prepare(
        `SELECT repository FROM session_repositories
         WHERE session_id = ?
         ORDER BY repository ASC`,
      )
      .all(sessionId) as Array<{ repository: string }>;

    expect(cwds.map((r) => r.cwd)).toEqual([launchCwd]);
    expect(repos.map((r) => r.repository)).toEqual(["fml-inc/panopticon"]);
  });
});
