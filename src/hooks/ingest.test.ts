import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetSessionRepoCache,
  extractEventPaths,
  extractShellPwd,
  type HookInput,
  isPanopticonMcpTool,
  resolveAllEventRepos,
  resolveEventRepo,
} from "./ingest.js";

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "test-session",
    hook_event_name: "PreToolUse",
    ...overrides,
  };
}

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

  it("does not match other MCP tools", () => {
    expect(isPanopticonMcpTool("mcp__github__search_code")).toBe(false);
  });
});
