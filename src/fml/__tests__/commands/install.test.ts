import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginRoot } from "../../commands/install.js";
import {
  removeFmlMcpServerConfig,
  upsertFmlMcpServerConfig,
} from "../../commands/mcp-config.js";

describe("resolvePluginRoot", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createPackageRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fml-plugin-root-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    return root;
  }

  it("finds the package root from the nested dist command chunk", () => {
    const root = createPackageRoot();
    const startDir = path.join(root, "dist", "fml", "commands");
    fs.mkdirSync(startDir, { recursive: true });

    expect(resolvePluginRoot(startDir)).toBe(root);
  });

  it("finds the package root from source tests", () => {
    const root = createPackageRoot();
    const startDir = path.join(root, "src", "fml", "commands");
    fs.mkdirSync(startDir, { recursive: true });

    expect(resolvePluginRoot(startDir)).toBe(root);
  });
});

describe("fml direct MCP config", () => {
  it("replaces legacy panopticon with fml while preserving fml options", () => {
    const updated = upsertFmlMcpServerConfig(
      {
        mcp_servers: {
          panopticon: {
            command: "node",
            args: ["/old/bin/mcp-server"],
          },
          fml: {
            command: "node",
            args: ["/old/bin/fml-mcp-server"],
            tools: {
              fml_local_query: { approval_mode: "approve" },
            },
          },
          github: {
            command: "github-mcp",
          },
        },
      },
      "mcp_servers",
      {
        command: "node",
        args: ["/new/bin/fml-mcp-server"],
      },
    );

    expect(updated.mcp_servers).toEqual({
      fml: {
        command: "node",
        args: ["/new/bin/fml-mcp-server"],
        tools: {
          fml_local_query: { approval_mode: "approve" },
        },
      },
      github: {
        command: "github-mcp",
      },
    });
  });

  it("removes only the fml MCP server", () => {
    const updated = removeFmlMcpServerConfig(
      {
        mcpServers: {
          fml: { command: "node" },
          github: { command: "github-mcp" },
        },
      },
      "mcpServers",
    );

    expect(updated).toEqual({
      mcpServers: {
        github: { command: "github-mcp" },
      },
    });
  });
});
