import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  execFileSyncMock,
  spawnSyncMock,
  existsSyncMock,
  readFileSyncMock,
  mkdirSyncMock,
  rmSyncMock,
  warnMock,
  errorMock,
  debugMock,
} = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  warnMock: vi.fn(),
  errorMock: vi.fn(),
  debugMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    mkdirSync: mkdirSyncMock,
    rmSync: rmSyncMock,
  },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  rmSync: rmSyncMock,
}));

vi.mock("../config.js", () => ({
  config: {
    dataDir: "/tmp/panopticon-summary-tests",
  },
}));

vi.mock("../log.js", () => ({
  log: {
    llm: {
      warn: warnMock,
      error: errorMock,
      debug: debugMock,
    },
  },
}));

async function loadLlm() {
  return import("./llm.js");
}

describe("summary llm wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    execFileSyncMock.mockReturnValue("/usr/local/bin/claude");
    spawnSyncMock.mockReturnValue({
      stdout: Buffer.from(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "OK",
        }),
      ),
      stderr: Buffer.from(""),
      status: 0,
      signal: null,
      error: undefined,
    });
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue("OK");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses successful Claude print JSON", async () => {
    const { parseClaudePrintJson } = await loadLlm();

    expect(
      parseClaudePrintJson(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "  concise summary  ",
        }),
      ),
    ).toEqual({
      ok: true,
      result: "concise summary",
      reason: "ok",
    });
  });

  it("rejects structured error payloads", async () => {
    const { parseClaudePrintJson } = await loadLlm();

    expect(
      parseClaudePrintJson(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in · Please run /login",
        }),
      ),
    ).toEqual({
      ok: false,
      result: null,
      reason: "Not logged in · Please run /login",
    });
  });

  it("uses a neutral cwd and preserves auth env while stripping the panopticon proxy", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    process.env.ANTHROPIC_BASE_URL = "http://localhost:4318/proxy/anthropic";
    const { invokeLlm } = await loadLlm();

    expect(invokeLlm("Summarize this")).toBe("OK");

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      {
        cwd: string;
        env: Record<string, string>;
      },
    ];

    expect(binary).toBe("/usr/local/bin/claude");
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "Summarize this",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--permission-mode",
        "default",
        "--disable-slash-commands",
        "--setting-sources",
        "user",
        "--tools",
        "",
      ]),
    );
    expect(args).not.toContain("--bare");
    expect(options.cwd).toBe(
      path.join("/tmp/panopticon-summary-tests", "claude-headless"),
    );
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(options.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("preserves non-panopticon Anthropic base URLs and enables bare mode for API-key auth", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example.com";
    const { invokeLlm } = await loadLlm();

    expect(invokeLlm("Summarize this")).toBe("OK");

    const [, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      {
        env: Record<string, string>;
      },
    ];
    expect(args).toContain("--bare");
    expect(options.env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com");
  });

  it("returns null for structured CLI errors even when stdout is populated", async () => {
    spawnSyncMock.mockReturnValue({
      stdout: Buffer.from(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in · Please run /login",
        }),
      ),
      stderr: Buffer.from(""),
      status: 1,
      signal: null,
      error: undefined,
    });
    const { invokeLlm } = await loadLlm();

    expect(invokeLlm("Summarize this")).toBeNull();
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("Not logged in · Please run /login"),
    );
  });

  it("disables built-in tools even when MCP is enabled and passes strict MCP config", async () => {
    const { invokeLlm } = await loadLlm();

    expect(invokeLlm("Summarize this", { withMcp: true })).toBe("OK");

    const [, args] = spawnSyncMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(
      expect.arrayContaining([
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        "--allowedTools",
      ]),
    );

    const mcpConfig = args[args.indexOf("--mcp-config") + 1];
    expect(JSON.parse(mcpConfig)).toEqual({
      mcpServers: {
        panopticon: {
          command: "node",
          args: [
            expect.stringContaining(path.join("dist", "mcp", "server.js")),
          ],
        },
      },
    });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      [
        "mcp__panopticon__timeline",
        "mcp__panopticon__get",
        "mcp__panopticon__query",
        "mcp__panopticon__search",
        "mcp__panopticon__status",
      ].join(" "),
    );
  });

  it("fails fast when the MCP server bundle cannot be found", async () => {
    existsSyncMock.mockReturnValue(false);
    const { invokeLlm } = await loadLlm();

    expect(invokeLlm("Summarize this", { withMcp: true })).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      "panopticon MCP server not found for Claude headless run",
    );
  });

  it("runs codex exec in a neutral cwd and reads the last-message file", async () => {
    execFileSyncMock.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === "codex") return "/usr/local/bin/codex";
      return "/usr/local/bin/claude";
    });
    const { invokeLlm } = await loadLlm();

    expect(invokeLlm("Summarize this", { runner: "codex" })).toBe("OK");

    const [binary, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string },
    ];
    expect(binary).toBe("/usr/local/bin/codex");
    expect(args).toEqual(
      expect.arrayContaining([
        "exec",
        "Summarize this",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--output-last-message",
      ]),
    );
    expect(options.cwd).toBe(
      path.join("/tmp/panopticon-summary-tests", "codex-headless"),
    );
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    expect(outputPath).toEqual(
      expect.stringMatching(/last-message-\d+-\d+-.*\.txt$/),
    );
  });
});
