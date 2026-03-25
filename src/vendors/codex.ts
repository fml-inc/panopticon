import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerVendor } from "./registry.js";
import type { VendorAdapter } from "./types.js";

const CODEX_DIR = path.join(os.homedir(), ".codex");

const codex: VendorAdapter = {
  id: "codex",

  config: {
    dir: CODEX_DIR,
    configPath: path.join(CODEX_DIR, "config.toml"),
    configFormat: "toml",
  },

  hooks: {
    events: [
      "session_start",
      "session_end",
      "user_prompt_submit",
      "pre_tool_use",
      "post_tool_use",
      "post_tool_use_failure",
      "stop",
    ],
    applyInstallConfig(existing, opts) {
      const codexConfig = { ...existing };
      const hookBin = path.join(opts.pluginRoot, "bin", "hook-handler");
      const mcpBin = path.join(opts.pluginRoot, "bin", "mcp-server");

      // Deep-copy hooks to avoid mutating the input
      const hooks = structuredClone(
        (codexConfig.hooks ?? {}) as Record<string, unknown[]>,
      );
      for (const event of this.events) {
        const entries = (hooks[event] ?? []) as Array<Record<string, unknown>>;
        // Remove existing panopticon entries
        hooks[event] = entries.filter((h) => h.name !== "panopticon");
        // Add panopticon hook
        (hooks[event] as unknown[]).push({
          name: "panopticon",
          type: "command",
          command: ["node", hookBin],
          timeout: 10,
        });
      }
      codexConfig.hooks = hooks;

      // Configure API proxy (opt-in via --proxy)
      if (opts.proxy) {
        codexConfig.openai_base_url = `http://localhost:${opts.port}/proxy/codex`;
      } else {
        delete codexConfig.openai_base_url;
      }

      // Configure OTel telemetry
      codexConfig.telemetry = {
        ...(codexConfig.telemetry as Record<string, unknown> | undefined),
        otlp_exporter: "otlp-http",
        otlp_endpoint: `http://localhost:${opts.port}`,
      };

      // Register MCP server
      const mcpServers = (codexConfig.mcp_servers ?? {}) as Record<
        string,
        unknown
      >;
      mcpServers.panopticon = { command: "node", args: [mcpBin] };
      codexConfig.mcp_servers = mcpServers;

      return codexConfig;
    },
  },

  shellEnv: {
    // Codex CLI reads its config from TOML, no shell env vars needed
    envVars() {
      return [];
    },
  },

  events: {
    // Codex uses snake_case but the hook handler already accepts both cases;
    // no mapping needed since ingest.ts normalizes at storage time
    eventMap: {},
    formatPermissionResponse({ allow, reason }) {
      // Codex uses the same format as Claude Code
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
    displayName: "Codex CLI",
    isInstalled: () => fs.existsSync(CODEX_DIR),
    isConfigured() {
      try {
        const content = fs.readFileSync(
          path.join(CODEX_DIR, "config.toml"),
          "utf-8",
        );
        return content.includes("panopticon");
      } catch {
        return false;
      }
    },
  },

  proxy: {
    upstreamHost(headers) {
      // Codex auto-detect: ChatGPT OAuth (JWT) vs API key route to different upstreams
      const auth = headers.authorization ?? "";
      return auth.startsWith("Bearer eyJ") ? "chatgpt.com" : "api.openai.com";
    },
    rewritePath(requestPath, headers) {
      const auth = headers.authorization ?? "";
      const isChatGptOAuth = auth.startsWith("Bearer eyJ");
      return isChatGptOAuth
        ? `/backend-api/codex${requestPath}`
        : `/v1${requestPath}`;
    },
    accumulatorType: "openai",
  },
};

registerVendor(codex);
