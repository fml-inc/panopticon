import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTarget } from "./registry.js";
import type { TargetAdapter } from "./types.js";

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");

const openclaw: TargetAdapter = {
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
            `http://localhost:${opts.port}/proxy/openclaw`;
        }
      }

      return cfg;
    },
    removeInstallConfig(existing) {
      const cfg = { ...existing };

      // Remove diagnostics-otel from plugins
      const plugins = cfg.plugins as Record<string, unknown> | undefined;
      if (plugins) {
        const allow = plugins.allow as string[] | undefined;
        if (allow) {
          plugins.allow = allow.filter((p) => p !== "diagnostics-otel");
          if ((plugins.allow as string[]).length === 0) delete plugins.allow;
        }
        const entries = plugins.entries as Record<string, unknown> | undefined;
        if (entries) {
          delete entries["diagnostics-otel"];
          if (Object.keys(entries).length === 0) delete plugins.entries;
        }
        if (Object.keys(plugins).length === 0) delete cfg.plugins;
      }

      // Remove diagnostics.otel block
      const diagnostics = cfg.diagnostics as
        | Record<string, unknown>
        | undefined;
      if (diagnostics) {
        delete diagnostics.otel;
        if (Object.keys(diagnostics).length === 0) delete cfg.diagnostics;
      }

      // Revert moonshot baseUrl rewrite if it points at the proxy
      const models = cfg.models as Record<string, unknown> | undefined;
      const providers = models?.providers as
        | Record<string, unknown>
        | undefined;
      const moonshot = providers?.moonshot as
        | Record<string, unknown>
        | undefined;
      if (moonshot && typeof moonshot.baseUrl === "string") {
        if (moonshot.baseUrl.includes("/proxy/openclaw")) {
          delete moonshot.baseUrl;
        }
      }

      return cfg;
    },
  },

  shellEnv: {
    // OpenClaw reads diagnostics config from its JSON file;
    // standard OTEL_* vars are already set by panopticon for all targets
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
          cfg.diagnostics?.otel?.enabled === true &&
          cfg.plugins?.entries?.["diagnostics-otel"]?.enabled === true
        );
      } catch {
        return false;
      }
    },
  },

  otel: {
    serviceName: "openclaw-gateway",
    metrics: {
      // OpenClaw's diagnostics-otel plugin emits "openclaw.tokens" with
      // openclaw.token (input/output/cache_read/cache_write/total) and
      // openclaw.model attributes.
      metricNames: ["openclaw.tokens"],
      aggregation: "SUM",
      tokenTypeAttrs: ['$."openclaw.token"'],
      modelAttrs: ['$."openclaw.model"'],
      tokenTypeMap: {
        cache_read: "cacheRead",
        cache_write: "cacheCreation",
      },
      excludeTokenTypes: ["total"],
    },
  },

  ident: {
    // Kimi models from Moonshot, plus any explicit moonshot/* references
    modelPatterns: [/^kimi-/i, /^moonshot\//i],
  },

  proxy: {
    // OpenClaw routes Moonshot/Kimi traffic. Moonshot's API lives under /v1.
    upstreamHost: "api.moonshot.ai",
    rewritePath(requestPath) {
      return `/v1${requestPath}`;
    },
    accumulatorType: "openai",
  },
};

registerTarget(openclaw);
