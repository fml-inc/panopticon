import fs from "node:fs";
import os from "node:os";
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
  const tmpDir = _path.join(_os.tmpdir(), "pano-hooks-ingest-test");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: _path.join(tmpDir, "panopticon.db"),
      port: 4318,
      host: "127.0.0.1",
      serverPidFile: _path.join(tmpDir, "panopticon.pid"),
      enablePreToolUseFileContextInjection: true,
      enablePreToolUseReadContextInjection: true,
    },
    ensureDataDir: () => _fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import {
  _resetPreToolUseFileContextSeen,
  _resetSessionRepoCache,
  _resetSessionTargetCache,
  emitOncePerSessionPath,
  extractEventPaths,
  extractShellPwd,
  type HookInput,
  isPanopticonMcpTool,
  processHookEvent,
  resolveAllEventRepos,
  resolveEventRepo,
} from "./ingest.js";

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

const testConfig = config as Mutable<typeof config>;

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "test-session",
    hook_event_name: "PreToolUse",
    ...overrides,
  };
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
  testConfig.enablePreToolUseFileContextInjection = true;
  testConfig.enablePreToolUseReadContextInjection = true;
  _resetSessionRepoCache();
  _resetSessionTargetCache();
  _resetPreToolUseFileContextSeen();
  const db = getDb();
  db.prepare("DELETE FROM claim_evidence").run();
  db.prepare("DELETE FROM evidence_ref_paths").run();
  db.prepare("DELETE FROM evidence_refs").run();
  db.prepare("DELETE FROM active_claims").run();
  db.prepare("DELETE FROM claims").run();
  db.prepare("DELETE FROM intent_edits").run();
  db.prepare("DELETE FROM intent_units_fts").run();
  db.prepare("DELETE FROM intent_units").run();
  db.prepare("DELETE FROM hook_events").run();
  db.prepare("DELETE FROM tool_calls").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM session_repositories").run();
  db.prepare("DELETE FROM session_cwds").run();
  db.prepare("DELETE FROM sessions").run();
});

// Stub resolver: returns "org/repo" if path contains a known repo name
function stubResolve(dir: string): string | null {
  if (dir.includes("/workspace/fml")) return "fml-inc/fml";
  if (dir.includes("/workspace/panopticon")) return "fml-inc/panopticon";
  if (dir.includes("/worktrees/district")) return "isoapp/district";
  return null;
}

describe("extractShellPwd", () => {
  it("returns shell_pwd from top level", () => {
    expect(extractShellPwd(makeInput({ shell_pwd: "/home/user/repo" }))).toBe(
      "/home/user/repo",
    );
  });

  it("returns shell_pwd from tool_input", () => {
    expect(
      extractShellPwd(
        makeInput({ tool_input: { shell_pwd: "/home/user/repo" } }),
      ),
    ).toBe("/home/user/repo");
  });

  it("prefers top-level over tool_input", () => {
    expect(
      extractShellPwd(
        makeInput({
          shell_pwd: "/top-level",
          tool_input: { shell_pwd: "/tool-input" },
        }),
      ),
    ).toBe("/top-level");
  });

  it("returns null when no shell_pwd", () => {
    expect(extractShellPwd(makeInput())).toBeNull();
  });

  it("returns null for non-string shell_pwd", () => {
    expect(extractShellPwd(makeInput({ shell_pwd: 123 as any }))).toBeNull();
  });
});

describe("resolveEventRepo", () => {
  beforeEach(() => {
    _resetSessionRepoCache();
  });

  it("uses explicit repository field first", () => {
    const data = makeInput({
      repository: "explicit/repo",
      shell_pwd: "/workspace/fml",
      cwd: "/workspace/panopticon",
    });
    expect(resolveEventRepo(data, stubResolve)).toBe("explicit/repo");
  });

  it("uses shell_pwd when no explicit repository", () => {
    const data = makeInput({
      shell_pwd: "/workspace/panopticon/src",
      cwd: "/Users/home",
    });
    expect(resolveEventRepo(data, stubResolve)).toBe("fml-inc/panopticon");
  });

  it("uses tool_input.file_path when shell_pwd doesn't resolve", () => {
    const data = makeInput({
      cwd: "/Users/home",
      tool_input: { file_path: "/workspace/fml/src/cli.ts" },
    });
    expect(resolveEventRepo(data, stubResolve)).toBe("fml-inc/fml");
  });

  it("uses tool_input.path as fallback for file_path", () => {
    const data = makeInput({
      cwd: "/Users/home",
      tool_input: { path: "/workspace/panopticon/src" },
    });
    expect(resolveEventRepo(data, stubResolve)).toBe("fml-inc/panopticon");
  });

  it("uses cwd as last resort", () => {
    const data = makeInput({ cwd: "/workspace/fml" });
    expect(resolveEventRepo(data, stubResolve)).toBe("fml-inc/fml");
  });

  it("returns null when nothing resolves", () => {
    const data = makeInput({ cwd: "/Users/home" });
    expect(resolveEventRepo(data, stubResolve)).toBeNull();
  });

  it("ignores relative file_path", () => {
    const data = makeInput({
      cwd: "/Users/home",
      tool_input: { file_path: "relative/path.ts" },
    });
    expect(resolveEventRepo(data, stubResolve)).toBeNull();
  });

  it("prefers shell_pwd over file_path", () => {
    const data = makeInput({
      shell_pwd: "/workspace/panopticon",
      tool_input: { file_path: "/workspace/fml/src/cli.ts" },
    });
    expect(resolveEventRepo(data, stubResolve)).toBe("fml-inc/panopticon");
  });

  it("prefers shell_pwd over cwd", () => {
    const data = makeInput({
      shell_pwd: "/workspace/panopticon",
      cwd: "/workspace/fml",
    });
    expect(resolveEventRepo(data, stubResolve)).toBe("fml-inc/panopticon");
  });

  describe("session repo cache", () => {
    it("caches resolved repo for the session", () => {
      // First event resolves a repo
      const event1 = makeInput({
        session_id: "session-1",
        shell_pwd: "/workspace/fml/src",
      });
      expect(resolveEventRepo(event1, stubResolve)).toBe("fml-inc/fml");

      // Second event has no paths — inherits from cache
      const event2 = makeInput({
        session_id: "session-1",
        hook_event_name: "Stop",
      });
      expect(resolveEventRepo(event2, stubResolve)).toBe("fml-inc/fml");
    });

    it("updates cache when repo changes within session", () => {
      // Working in fml
      const event1 = makeInput({
        session_id: "session-2",
        shell_pwd: "/workspace/fml",
      });
      expect(resolveEventRepo(event1, stubResolve)).toBe("fml-inc/fml");

      // Switched to panopticon
      const event2 = makeInput({
        session_id: "session-2",
        shell_pwd: "/workspace/panopticon",
      });
      expect(resolveEventRepo(event2, stubResolve)).toBe("fml-inc/panopticon");

      // Stop event inherits latest
      const event3 = makeInput({
        session_id: "session-2",
        hook_event_name: "Stop",
      });
      expect(resolveEventRepo(event3, stubResolve)).toBe("fml-inc/panopticon");
    });

    it("does not bleed between sessions", () => {
      const event1 = makeInput({
        session_id: "session-a",
        shell_pwd: "/workspace/fml",
      });
      resolveEventRepo(event1, stubResolve);

      const event2 = makeInput({
        session_id: "session-b",
        hook_event_name: "Stop",
      });
      expect(resolveEventRepo(event2, stubResolve)).toBeNull();
    });

    it("does not cache null", () => {
      const event1 = makeInput({
        session_id: "session-c",
        cwd: "/Users/home",
      });
      expect(resolveEventRepo(event1, stubResolve)).toBeNull();

      // Later event in same session resolves
      const event2 = makeInput({
        session_id: "session-c",
        shell_pwd: "/workspace/fml",
      });
      expect(resolveEventRepo(event2, stubResolve)).toBe("fml-inc/fml");
    });
  });

  describe("worktree paths", () => {
    it("resolves repo from worktree path via shell_pwd", () => {
      const data = makeInput({
        cwd: "/Users/p",
        shell_pwd: "/Users/p/.superset/worktrees/district/address-pr-feedback",
      });
      expect(resolveEventRepo(data, stubResolve)).toBe("isoapp/district");
    });

    it("resolves repo from worktree path in file_path", () => {
      const data = makeInput({
        cwd: "/Users/p",
        tool_input: {
          file_path:
            "/Users/p/.superset/worktrees/district/src/components/Foo.tsx",
        },
      });
      expect(resolveEventRepo(data, stubResolve)).toBe("isoapp/district");
    });
  });
});

describe("extractEventPaths", () => {
  it("extracts all path sources in priority order", () => {
    const data = makeInput({
      shell_pwd: "/workspace/fml",
      cwd: "/workspace/panopticon",
      tool_input: { file_path: "/workspace/panopticon/src/index.ts" },
    });
    const paths = extractEventPaths(data);
    expect(paths).toEqual([
      { dir: "/workspace/fml", source: "shell_pwd" },
      { dir: "/workspace/panopticon/src", source: "tool_input.file_path" },
      { dir: "/workspace/panopticon", source: "cwd" },
    ]);
  });

  it("deduplicates identical directories", () => {
    const data = makeInput({
      shell_pwd: "/workspace/fml",
      cwd: "/workspace/fml",
    });
    const paths = extractEventPaths(data);
    expect(paths).toEqual([{ dir: "/workspace/fml", source: "shell_pwd" }]);
  });

  it("extracts both file_path and path when different", () => {
    const data = makeInput({
      tool_input: {
        file_path: "/workspace/fml/src/cli.ts",
        path: "/workspace/panopticon/src",
      },
    });
    const paths = extractEventPaths(data);
    expect(paths.map((p) => p.source)).toEqual([
      "tool_input.file_path",
      "tool_input.path",
    ]);
  });

  it("ignores relative paths in tool_input", () => {
    const data = makeInput({
      tool_input: { file_path: "relative/path.ts" },
      cwd: "/workspace/fml",
    });
    const paths = extractEventPaths(data);
    expect(paths).toEqual([{ dir: "/workspace/fml", source: "cwd" }]);
  });

  it("extracts foreign absolute tool paths without normalizing to host style", () => {
    const foreignFilePath =
      process.platform === "win32"
        ? "/workspace/panopticon/src/index.ts"
        : "C:\\repo\\src\\index.ts";
    const expectedDir =
      process.platform === "win32"
        ? "/workspace/panopticon/src"
        : "C:\\repo\\src";

    const data = makeInput({
      tool_input: { file_path: foreignFilePath },
      cwd: "/workspace/fml",
    });
    const paths = extractEventPaths(data);

    expect(paths).toEqual([
      { dir: expectedDir, source: "tool_input.file_path" },
      { dir: "/workspace/fml", source: "cwd" },
    ]);
  });

  it("returns empty for events with no paths", () => {
    const data = makeInput({ hook_event_name: "Stop" });
    expect(extractEventPaths(data)).toEqual([]);
  });
});

describe("resolveAllEventRepos", () => {
  it("returns both repos when cwd and file_path are in different repos", () => {
    const data = makeInput({
      shell_pwd: "/workspace/fml",
      tool_input: {
        file_path: "/workspace/panopticon/scripts/test-superset-db.sh",
      },
    });
    const repos = resolveAllEventRepos(data, stubResolve);
    expect(repos).toEqual([
      { repo: "fml-inc/fml", dir: "/workspace/fml" },
      { repo: "fml-inc/panopticon", dir: "/workspace/panopticon/scripts" },
    ]);
  });

  it("returns single repo when all paths point to same repo", () => {
    const data = makeInput({
      shell_pwd: "/workspace/fml/src",
      tool_input: { file_path: "/workspace/fml/src/cli.ts" },
      cwd: "/workspace/fml",
    });
    const repos = resolveAllEventRepos(data, stubResolve);
    expect(repos).toEqual([{ repo: "fml-inc/fml", dir: "/workspace/fml/src" }]);
  });

  it("returns empty when nothing resolves", () => {
    const data = makeInput({ cwd: "/Users/home" });
    expect(resolveAllEventRepos(data, stubResolve)).toEqual([]);
  });

  it("uses explicit repository field", () => {
    const data = makeInput({
      repository: "explicit/repo",
      shell_pwd: "/workspace/fml",
    });
    const repos = resolveAllEventRepos(data, stubResolve);
    expect(repos[0]).toEqual({ repo: "explicit/repo", dir: "/workspace/fml" });
    // shell_pwd also resolves to fml — but explicit/repo is different, so fml
    // appears as a second entry
    expect(repos).toHaveLength(2);
    expect(repos[1]).toEqual({ repo: "fml-inc/fml", dir: "/workspace/fml" });
  });
});

describe("isPanopticonMcpTool", () => {
  it("matches plugin-prefixed panopticon MCP tools (bare tool names)", () => {
    expect(
      isPanopticonMcpTool("mcp__plugin_panopticon_panopticon__query"),
    ).toBe(true);
    expect(
      isPanopticonMcpTool(
        "mcp__plugin_panopticon_panopticon__permissions_apply",
      ),
    ).toBe(true);
  });

  it("still matches historical tool names with panopticon_ prefix", () => {
    // Backward-compat: pre-rename sessions captured tool names like
    // `panopticon_query`. The hook matches on plugin prefix, not tool name,
    // so these still resolve to panopticon.
    expect(
      isPanopticonMcpTool(
        "mcp__plugin_panopticon_panopticon__panopticon_query",
      ),
    ).toBe(true);
  });

  it("matches plain panopticon MCP server tools", () => {
    expect(isPanopticonMcpTool("mcp__panopticon__query")).toBe(true);
  });

  it("matches Codex slash-form panopticon MCP tool names", () => {
    expect(isPanopticonMcpTool("panopticon/session_summary_detail")).toBe(true);
    expect(isPanopticonMcpTool("panopticon/query")).toBe(true);
  });

  it("does not match other MCP tools", () => {
    expect(isPanopticonMcpTool("mcp__github__search_code")).toBe(false);
    expect(isPanopticonMcpTool("github/search_code")).toBe(false);
  });
});

describe("processHookEvent", () => {
  function insertIntentEdit(filePath: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO intent_units
       (id, intent_key, session_id, prompt_text, prompt_ts_ms, cwd, repository)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "intent:read-context",
      "history-session",
      "build read context target",
      1_000,
      "/workspace/panopticon",
      "fml-inc/panopticon",
    );
    db.prepare(
      `INSERT INTO intent_edits
       (id, edit_key, intent_unit_id, session_id, timestamp_ms, file_path, landed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, "edit:read-context", 1, "history-session", 1_100, filePath, 1);
  }

  it("keeps read-time file context behind its own flag", () => {
    testConfig.enablePreToolUseReadContextInjection = false;
    const filePath = "/workspace/panopticon/src/read-context.ts";
    insertIntentEdit(filePath);

    const disabled = processHookEvent({
      session_id: "reader",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: { file_path: filePath },
    });
    expect(disabled).toEqual({});

    testConfig.enablePreToolUseReadContextInjection = true;
    const enabled = processHookEvent({
      session_id: "reader-enabled",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: { file_path: filePath },
    });

    expect(
      (enabled.hookSpecificOutput as Record<string, unknown>).additionalContext,
    ).toContain("Panopticon read context");
  });

  it("allows read-time file context for Claude target hooks", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    const filePath = "/workspace/panopticon/src/read-context.ts";
    insertIntentEdit(filePath);

    const response = processHookEvent({
      session_id: "claude-reader",
      source: "claude",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: { file_path: filePath },
    });

    expect(
      (response.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon read context");
  });

  it("allows read-time file context for Codex target hooks", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    const filePath = "/workspace/panopticon/src/read-context.ts";
    insertIntentEdit(filePath);

    const response = processHookEvent({
      session_id: "codex-reader",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: { file_path: filePath },
    });

    expect(
      (response.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon read context");
  });

  it("allows read-time file context for simple Codex Bash file reads", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    const filePath = "/workspace/panopticon/src/read-context.ts";
    insertIntentEdit(filePath);

    const response = processHookEvent({
      session_id: "codex-bash-reader",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        command: "sed -n '1,80p' src/read-context.ts",
      },
    });

    expect(
      (response.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon read context");
  });

  it("allows read-time file context for chained and piped Bash reads", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    const filePath = "/workspace/panopticon/src/read-context.ts";
    insertIntentEdit(filePath);

    const response = processHookEvent({
      session_id: "codex-bash-piped-reader",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        command: "true && cat src/read-context.ts | head -n 5",
      },
    });

    expect(
      (response.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon read context");
  });

  it("allows read-time file context for multi-file Bash searches", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    insertIntentEdit("/workspace/panopticon/src/read-context.ts");

    const response = processHookEvent({
      session_id: "codex-bash-searcher",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        command: "rg -n read-context src/read-context.ts src/other.ts",
      },
    });

    expect(
      (response.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon read context");
  });

  it("does not treat 1> or 2> inside a word as a file descriptor redirect", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    insertIntentEdit("/workspace/panopticon/src/log");

    const response = processHookEvent({
      session_id: "codex-bash-word-fd",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        command: "cat src/log1> out",
      },
    });

    expect(response).toEqual({});
  });

  it("keeps the first file after grep -e as the read target", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    insertIntentEdit("/workspace/panopticon/a.txt");

    const response = processHookEvent({
      session_id: "codex-bash-grep-e",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        command: "grep -e foo a.txt b.txt",
      },
    });

    expect(
      (response.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon read context");
  });

  it("keeps the file after sed -e as the read target", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    insertIntentEdit("/workspace/panopticon/file.txt");

    const response = processHookEvent({
      session_id: "codex-bash-sed-e",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        command: "sed -e 's/x/y/' file.txt",
      },
    });

    expect(
      (response.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon read context");
  });

  it("does not classify sed -i as read-time context", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    insertIntentEdit("/workspace/panopticon/file.txt");

    const response = processHookEvent({
      session_id: "codex-bash-sed-in-place",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        command: "sed -i 's/x/y/' file.txt",
      },
    });

    expect(response).toEqual({});
  });

  it("expands home-directory Bash read paths", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    insertIntentEdit(path.join(os.homedir(), "notes.md"));

    const response = processHookEvent({
      session_id: "codex-bash-home-reader",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        command: "cat ~/notes.md",
      },
    });

    expect(
      (response.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon read context");
  });

  it("ignores directory-only Bash searches", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    insertIntentEdit("/workspace/panopticon/src/read-context.ts");

    const response = processHookEvent({
      session_id: "codex-bash-directory-searcher",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        command: "rg -n read-context src test scripts",
      },
    });

    expect(response).toEqual({});
  });

  it("allows edit-time file context for Codex target hooks", () => {
    const filePath = "/workspace/panopticon/src/read-context.ts";
    insertIntentEdit(filePath);

    const response = processHookEvent({
      session_id: "codex-editor",
      source: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        file_path: filePath,
        old_string: "before",
        new_string: "after",
      },
    });

    expect(
      (response.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon file context");
  });

  it("dedupes read-time file context independently of edit-time context", () => {
    testConfig.enablePreToolUseReadContextInjection = true;
    const filePath = "/workspace/panopticon/src/read-context.ts";
    insertIntentEdit(filePath);

    const firstRead = processHookEvent({
      session_id: "same-session",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: { file_path: filePath },
    });
    const secondRead = processHookEvent({
      session_id: "same-session",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: { file_path: filePath },
    });
    const edit = processHookEvent({
      session_id: "same-session",
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      cwd: "/workspace/panopticon",
      repository: "fml-inc/panopticon",
      tool_input: {
        file_path: filePath,
        old_string: "before",
        new_string: "after",
      },
    });

    expect(
      (firstRead.hookSpecificOutput as Record<string, unknown>)
        .additionalContext,
    ).toContain("Panopticon read context");
    expect(secondRead).toEqual({});
    expect(
      (edit.hookSpecificOutput as Record<string, unknown>).additionalContext,
    ).toContain("Panopticon file context");
  });

  it("keeps Pi hook events out of transcript messages and tool calls", () => {
    const sessionId = "pi-hook-no-transcript";

    processHookEvent({
      session_id: sessionId,
      source: "pi",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/panopticon",
      prompt: "write a pi file",
    });
    processHookEvent({
      session_id: sessionId,
      source: "pi",
      hook_event_name: "PreToolUse",
      tool_name: "write",
      cwd: "/workspace/panopticon",
      tool_call_id: "pi-call-1",
      tool_input: { path: "pi-output.txt", content: "hello" },
    });
    processHookEvent({
      session_id: sessionId,
      source: "pi",
      hook_event_name: "PostToolUse",
      tool_name: "write",
      cwd: "/workspace/panopticon",
      tool_call_id: "pi-call-1",
      tool_input: { path: "pi-output.txt", content: "hello" },
      tool_result: { content: "ok" },
    });

    const db = getDb();
    const hookEvents = db
      .prepare(
        `SELECT event_type, target, tool_name
         FROM hook_events
         WHERE session_id = ?
         ORDER BY id`,
      )
      .all(sessionId);
    expect(hookEvents).toEqual([
      { event_type: "UserPromptSubmit", target: "pi", tool_name: null },
      { event_type: "PreToolUse", target: "pi", tool_name: "write" },
      { event_type: "PostToolUse", target: "pi", tool_name: "write" },
    ]);

    const session = db
      .prepare(
        `SELECT target, has_hooks, first_prompt
         FROM sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          target: string;
          has_hooks: number;
          first_prompt: string;
        }
      | undefined;
    expect(session).toMatchObject({
      target: "pi",
      has_hooks: 1,
      first_prompt: "write a pi file",
    });
    const messageCount = db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?")
      .get(sessionId) as { c: number };
    const toolCallCount = db
      .prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = ?")
      .get(sessionId) as { c: number };
    expect(messageCount.c).toBe(0);
    expect(toolCallCount.c).toBe(0);
  });
});

describe("emitOncePerSessionPath", () => {
  beforeEach(() => {
    _resetPreToolUseFileContextSeen();
  });

  it("emits once per session+path then dedupes", () => {
    const build = () => "ctx";
    expect(emitOncePerSessionPath("s1", "/a.ts", build)).toBe("ctx");
    expect(emitOncePerSessionPath("s1", "/a.ts", build)).toBeNull();
  });

  it("does not mark the key when build yields nothing", () => {
    expect(emitOncePerSessionPath("s1", "/a.ts", () => null)).toBeNull();
    // History appeared later — the one shot is still available.
    expect(emitOncePerSessionPath("s1", "/a.ts", () => "ctx")).toBe("ctx");
    expect(emitOncePerSessionPath("s1", "/a.ts", () => "ctx")).toBeNull();
  });

  it("keys are independent across paths and sessions", () => {
    expect(emitOncePerSessionPath("s1", "/a.ts", () => "a")).toBe("a");
    expect(emitOncePerSessionPath("s1", "/b.ts", () => "b")).toBe("b");
    expect(emitOncePerSessionPath("s2", "/a.ts", () => "a2")).toBe("a2");
    expect(emitOncePerSessionPath("s1", "/a.ts", () => "a")).toBeNull();
  });

  it("reset clears the dedupe set", () => {
    expect(emitOncePerSessionPath("s1", "/a.ts", () => "ctx")).toBe("ctx");
    _resetPreToolUseFileContextSeen();
    expect(emitOncePerSessionPath("s1", "/a.ts", () => "ctx")).toBe("ctx");
  });
});
