#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Read version from package.json so the plugin manifest stays in sync.
// Claude Code's local-plugin loader reads the `version` field from
// .claude-plugin/plugin.json (NOT package.json) to pick the cache
// directory name. Without it, the cache falls back to `unknown/` and
// every install reuses that same stale directory forever.
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

const manifest = {
  name: "panopticon",
  version: pkg.version,
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
