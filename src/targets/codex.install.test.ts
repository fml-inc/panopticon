import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function quoteCommandArg(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

describe("codex install config", () => {
  let tmpCodexDir = "";

  afterEach(() => {
    delete process.env.PANOPTICON_CODEX_DIR;
    vi.resetModules();
    if (tmpCodexDir) {
      fs.rmSync(tmpCodexDir, { recursive: true, force: true });
      tmpCodexDir = "";
    }
  });

  it("preserves existing panopticon tool approval settings", async () => {
    tmpCodexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-codex-install-"),
    );
    process.env.PANOPTICON_CODEX_DIR = tmpCodexDir;
    vi.resetModules();

    const { getTarget } = await import("./index.js");
    const codex = getTarget("codex")!;

    const pluginRoot = path.join(tmpCodexDir, "panopticon app");
    const result = codex.hooks.applyInstallConfig(
      {
        mcp_servers: {
          panopticon: {
            command: "node",
            args: ["/old/panopticon/bin/mcp-server"],
            tools: {
              search_intent: { approval_mode: "approve" },
              query: { approval_mode: "deny" },
            },
          },
        },
      },
      { pluginRoot, port: 4318, proxy: true },
    ) as Record<string, unknown>;

    expect(result.openai_base_url).toBe("http://localhost:4318/proxy/codex");
    expect(result.mcp_servers).toMatchObject({
      panopticon: {
        command: "node",
        args: [path.join(pluginRoot, "bin", "mcp-server")],
        tools: {
          search_intent: { approval_mode: "approve" },
          query: { approval_mode: "deny" },
        },
      },
    });

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(tmpCodexDir, "hooks.json"), "utf-8"),
    ) as {
      hooks?: Record<string, unknown[]>;
    };
    const permissionRequest = hooksJson.hooks?.PermissionRequest as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(permissionRequest).toBeDefined();
    const expectedHookCommand =
      process.platform === "win32"
        ? `cmd.exe /d /s /c ""${path.join(
            pluginRoot,
            "bin",
            "panopticon-codex-hook.cmd",
          )}" codex 4318 --proxy"`
        : `node ${quoteCommandArg(
            path.join(pluginRoot, "bin", "hook-handler"),
          )} codex 4318 --proxy`;
    expect(permissionRequest.at(-1)?.hooks[0].command).toBe(
      expectedHookCommand,
    );

    if (process.platform === "win32") {
      expect(
        fs.readFileSync(
          path.join(pluginRoot, "bin", "panopticon-codex-hook.cmd"),
          "utf-8",
        ),
      ).toContain('node "%~dp0hook-handler" %*');
    }
  });

  it("uses the current hooks feature flag and trusts installed hooks", async () => {
    tmpCodexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-codex-install-"),
    );
    process.env.PANOPTICON_CODEX_DIR = tmpCodexDir;
    vi.resetModules();

    const { getTarget } = await import("./index.js");
    const codex = getTarget("codex")!;

    const result = codex.hooks.applyInstallConfig(
      {
        features: {
          codex_hooks: true,
          goals: true,
        },
      },
      { pluginRoot: "/tmp/panopticon", port: 4318, proxy: false },
    ) as Record<string, unknown>;

    expect(result.features).toEqual({
      goals: true,
      hooks: true,
    });

    const hooksConfig = result.hooks as Record<string, unknown>;
    const state = hooksConfig.state as Record<
      string,
      { trusted_hash?: string }
    >;
    const hooksPath = path.join(fs.realpathSync(tmpCodexDir), "hooks.json");
    expect(Object.keys(state).sort()).toEqual(
      [
        "permission_request",
        "post_tool_use",
        "pre_tool_use",
        "session_start",
        "stop",
        "user_prompt_submit",
      ].map((event) => `${hooksPath}:${event}:0:0`),
    );
    for (const entry of Object.values(state)) {
      expect(entry.trusted_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("removes stale Panopticon hook state without disabling Codex hooks", async () => {
    tmpCodexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-codex-install-"),
    );
    process.env.PANOPTICON_CODEX_DIR = tmpCodexDir;
    vi.resetModules();

    const { getTarget } = await import("./index.js");
    const codex = getTarget("codex")!;
    const configPath = path.join(fs.realpathSync(tmpCodexDir), "config.toml");
    const staleKey = `${configPath}:session_start:0:0`;
    const otherKey = `${configPath}:pre_tool_use:1:0`;

    const result = codex.hooks.removeInstallConfig({
      features: {
        codex_hooks: true,
        hooks: true,
      },
      hooks: {
        state: {
          [staleKey]: { trusted_hash: "sha256:stale" },
          [otherKey]: { trusted_hash: "sha256:other" },
        },
        SessionStart: [
          {
            hooks: [{ type: "command", command: "node /opt/panopticon/hook" }],
          },
        ],
        PreToolUse: [
          {
            hooks: [{ type: "command", command: "echo keep" }],
          },
        ],
      },
    }) as Record<string, unknown>;

    expect(result.features).toEqual({ hooks: true });
    const hooksConfig = result.hooks as Record<string, unknown>;
    expect(hooksConfig.SessionStart).toBeUndefined();
    expect(hooksConfig.PreToolUse).toBeDefined();
    expect(hooksConfig.state).toEqual({
      [otherKey]: { trusted_hash: "sha256:other" },
    });
  });
});
