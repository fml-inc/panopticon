import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookInput } from "../hooks/ingest.js";
import { registerVendor } from "./registry.js";
import type { VendorAdapter } from "./types.js";

const GEMINI_DIR = path.join(os.homedir(), ".gemini");

const gemini: VendorAdapter = {
  id: "gemini",

  config: {
    dir: GEMINI_DIR,
    configPath: path.join(GEMINI_DIR, "settings.json"),
    configFormat: "json",
  },

  hooks: {
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
    ],
    applyInstallConfig(existing, opts) {
      const settings = { ...existing };
      const hookBin = path.join(opts.pluginRoot, "bin", "hook-handler");
      const mcpBin = path.join(opts.pluginRoot, "bin", "mcp-server");

      // Deep-copy hooks to avoid mutating the input
      const hooks = structuredClone(
        (settings.hooks as Record<string, unknown[]>) ?? {},
      );
      for (const event of this.events) {
        hooks[event] = hooks[event] || [];
        // Remove existing panopticon hooks
        hooks[event] = (hooks[event] as Array<Record<string, unknown>>)
          .map((group) => ({
            ...group,
            hooks: (
              (group.hooks as Array<Record<string, unknown>>) || []
            ).filter((h) => !(h.path as string)?.includes("panopticon")),
          }))
          .filter((group) => (group.hooks as unknown[]).length > 0);
        // Add panopticon hook
        (hooks[event] as unknown[]).push({
          hooks: [{ path: hookBin, skipExecution: false }],
        });
      }
      settings.hooks = hooks;

      // Enable hooks
      settings.hooksConfig =
        (settings.hooksConfig as Record<string, unknown>) || {};
      (settings.hooksConfig as Record<string, unknown>).enabled = true;

      // Register MCP server
      settings.mcpServers =
        (settings.mcpServers as Record<string, unknown>) || {};
      (settings.mcpServers as Record<string, unknown>).panopticon = {
        command: "node",
        args: [mcpBin],
      };

      // Configure telemetry
      settings.telemetry =
        (settings.telemetry as Record<string, unknown>) || {};
      Object.assign(settings.telemetry as Record<string, unknown>, {
        enabled: true,
        target: "local",
        useCollector: true,
        OTLP_ENDPOINT: `http://localhost:${opts.port}`,
        OTLP_PROTOCOL: "http",
      });

      return settings;
    },
  },

  shellEnv: {
    envVars(port) {
      return [
        ["GEMINI_TELEMETRY_ENABLED", "true"],
        ["GEMINI_TELEMETRY_TARGET", "local"],
        ["GEMINI_TELEMETRY_USE_COLLECTOR", "true"],
        ["GEMINI_TELEMETRY_OTLP_ENDPOINT", `http://localhost:${port}`],
        ["GEMINI_TELEMETRY_OTLP_PROTOCOL", "http"],
        ["GEMINI_TELEMETRY_LOG_PROMPTS", "true"],
      ];
    },
  },

  events: {
    eventMap: {
      BeforeTool: "PreToolUse",
      AfterTool: "PostToolUse",
      BeforeModel: "UserPromptSubmit",
    },

    normalizePayload(data: HookInput): HookInput {
      // Extract user_prompt from Gemini's llm_request.messages format
      const messages = (data as Record<string, unknown>).llm_request as
        | { messages?: Array<{ role: string; content: unknown }> }
        | undefined;
      if (messages?.messages && Array.isArray(messages.messages)) {
        const lastUser = [...messages.messages]
          .reverse()
          .find((m) => m.role === "user");
        if (lastUser?.content) {
          const text =
            typeof lastUser.content === "string"
              ? lastUser.content
              : Array.isArray(lastUser.content)
                ? (lastUser.content as Array<{ type: string; text?: string }>)
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("\n")
                : "";
          if (text) {
            (data as Record<string, unknown>).user_prompt = text;
          }
        }
      }
      return data;
    },

    formatPermissionResponse({ allow, reason }) {
      return { decision: allow ? "allow" : "deny", reason };
    },
  },

  detect: {
    displayName: "Gemini CLI",
    isInstalled: () => fs.existsSync(GEMINI_DIR),
    isConfigured() {
      try {
        const settings = JSON.parse(
          fs.readFileSync(path.join(GEMINI_DIR, "settings.json"), "utf-8"),
        );
        return !!settings.telemetry?.enabled;
      } catch {
        return false;
      }
    },
  },

  proxy: {
    upstreamHost: "generativelanguage.googleapis.com",
    accumulatorType: "openai",
  },
};

registerVendor(gemini);
