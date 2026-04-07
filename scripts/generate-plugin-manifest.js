#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";

const manifest = {
  name: "panopticon",
  description:
    "Observability for Claude Code — captures OTel signals and hook events, queryable via MCP",
  mcpServers: {
    panopticon: {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/bin/mcp-server"],
    },
  },
};

mkdirSync(".claude-plugin", { recursive: true });
writeFileSync(
  ".claude-plugin/plugin.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
);
