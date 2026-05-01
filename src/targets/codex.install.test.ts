import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      { pluginRoot: "/app", port: 4318, proxy: true },
    ) as Record<string, unknown>;

    expect(result.openai_base_url).toBe("http://localhost:4318/proxy/codex");
    expect(result.mcp_servers).toMatchObject({
      panopticon: {
        command: "node",
        args: [path.join("/app", "bin", "mcp-server")],
        default_tools_approval_mode: "approve",
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
    expect(hooksJson.hooks?.PermissionRequest).toBeDefined();
    const permissionGroup = hooksJson.hooks?.PermissionRequest?.[0] as {
      hooks?: Array<{ command?: string }>;
    };
    const expectedNode =
      process.platform === "win32" && fs.existsSync("C:\\Progra~1\\nodejs\\node.exe")
        ? "C:\\Progra~1\\nodejs\\node.exe"
        : `"${process.execPath.replaceAll('"', '\\"')}"`;
    expect(permissionGroup.hooks?.[0]?.command).toBe(
      `${expectedNode} "${path.join("/app", "bin", "hook-handler")}" codex 4318 --proxy`,
    );
  });
});
