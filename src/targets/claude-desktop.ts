import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTarget } from "./registry.js";
import type { TargetAdapter } from "./types.js";

const CLAUDE_DESKTOP_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
);
const CLAUDE_DESKTOP_CONFIG = path.join(
  CLAUDE_DESKTOP_DIR,
  "claude_desktop_config.json",
);

const claudeDesktop: TargetAdapter = {
  id: "claude-desktop",

  config: {
    dir: CLAUDE_DESKTOP_DIR,
    configPath: CLAUDE_DESKTOP_CONFIG,
    configFormat: "json",
  },

  hooks: {
    // Claude Desktop uses MCP servers, not hooks
    events: [],
    applyInstallConfig(existing, opts) {
      const cfg = { ...existing };
      const serverBin = path.join(opts.pluginRoot, "bin", "mcp-server");
      cfg.mcpServers = (cfg.mcpServers as Record<string, unknown>) ?? {};
      (cfg.mcpServers as Record<string, unknown>).panopticon = {
        command: "node",
        args: [serverBin],
      };
      return cfg;
    },
    removeInstallConfig(existing) {
      const cfg = { ...existing };
      const servers = cfg.mcpServers as Record<string, unknown> | undefined;
      if (servers) {
        delete servers.panopticon;
        if (Object.keys(servers).length === 0) delete cfg.mcpServers;
      }
      return cfg;
    },
  },

  shellEnv: {
    envVars() {
      return [];
    },
  },

  events: {
    eventMap: {},
    formatPermissionResponse(_eventName, { allow, reason }) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: allow ? "allow" : "deny",
          permissionDecisionReason: reason,
        },
      };
    },
  },

  detect: {
    displayName: "Claude Desktop",
    isInstalled: () => fs.existsSync(CLAUDE_DESKTOP_DIR),
    isConfigured() {
      try {
        const cfg = JSON.parse(fs.readFileSync(CLAUDE_DESKTOP_CONFIG, "utf-8"));
        return !!cfg.mcpServers?.panopticon;
      } catch {
        return false;
      }
    },
  },
};

registerTarget(claudeDesktop);
