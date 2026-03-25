import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerVendor } from "./registry.js";
import type { VendorAdapter } from "./types.js";

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");

const openclaw: VendorAdapter = {
  id: "openclaw",

  config: {
    dir: OPENCLAW_DIR,
    configPath: CONFIG_PATH,
    configFormat: "json",
  },

  hooks: {
    events: ["command:new", "command:reset", "tool_result_persist"],
    applyInstallConfig(existing, opts) {
      const cfg = { ...existing };

      // Enable diagnostics-otel plugin
      cfg.plugins = (cfg.plugins as Record<string, unknown>) ?? {};
      const plugins = cfg.plugins as Record<string, unknown>;
      plugins.allow = (plugins.allow as string[]) ?? [];
      if (!(plugins.allow as string[]).includes("diagnostics-otel")) {
        (plugins.allow as string[]).push("diagnostics-otel");
      }
      plugins.entries = (plugins.entries as Record<string, unknown>) ?? {};
      (plugins.entries as Record<string, unknown>)["diagnostics-otel"] = {
        enabled: true,
      };

      // Configure OTLP endpoint
      cfg.diagnostics = (cfg.diagnostics as Record<string, unknown>) ?? {};
      (cfg.diagnostics as Record<string, unknown>).otel = {
        enabled: true,
        endpoint: `http://localhost:${opts.port}`,
        protocol: "http/protobuf",
        serviceName: "openclaw-gateway",
        traces: true,
        metrics: true,
        logs: true,
        sampleRate: 1.0,
      };

      // Optionally route Moonshot API through proxy
      if (opts.proxy) {
        cfg.models = (cfg.models as Record<string, unknown>) ?? {};
        const models = cfg.models as Record<string, unknown>;
        models.providers = (models.providers as Record<string, unknown>) ?? {};
        const providers = models.providers as Record<string, unknown>;
        if (providers.moonshot) {
          (providers.moonshot as Record<string, unknown>).baseUrl =
            `http://localhost:${opts.port}/proxy/moonshot`;
        }
      }

      return cfg;
    },
  },

  shellEnv: {
    // OpenClaw reads diagnostics config from its JSON file;
    // standard OTEL_* vars are already set by panopticon for all vendors
    envVars() {
      return [];
    },
  },

  events: {
    eventMap: {
      "command:new": "SessionStart",
      "command:reset": "SessionEnd",
      tool_result_persist: "PostToolUse",
    },
    formatPermissionResponse({ allow, reason }) {
      return { decision: allow ? "allow" : "deny", reason };
    },
  },

  detect: {
    displayName: "OpenClaw",
    isInstalled: () => fs.existsSync(OPENCLAW_DIR),
    isConfigured() {
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        return (
          cfg.diagnostics?.otel?.enabled === true ||
          cfg.plugins?.entries?.["diagnostics-otel"]?.enabled === true
        );
      } catch {
        return false;
      }
    },
  },

  proxy: {
    upstreamHost: "api.moonshot.ai",
    accumulatorType: "openai",
  },
};

registerVendor(openclaw);
