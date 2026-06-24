#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Read version from package.json so the plugin manifest stays in sync.
// Claude Code's local-plugin loader reads the `version` field from
// .claude-plugin/plugin.json (NOT package.json) to pick the cache
// directory name. Without it, the cache falls back to `unknown/` and
// every install reuses that same stale directory forever.
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

const manifest = {
  name: "fml",
  version: pkg.version,
  description: "FML agent tools for Claude Code",
  mcpServers: {
    fml: {
      command: "node",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude expands this plugin placeholder.
      args: ["${CLAUDE_PLUGIN_ROOT}/bin/fml-mcp-server"],
    },
  },
};

mkdirSync(".claude-plugin", { recursive: true });
writeFileSync(
  ".claude-plugin/plugin.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
);
