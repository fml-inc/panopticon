import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProvider } from "../providers/index.js";
import { registerTarget } from "./registry.js";
import type { TargetAdapter } from "./types.js";

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");

/**
 * Test whether a `baseUrl` string was rewritten by a previous
 * `applyInstallConfig` call (i.e. points at panopticon's proxy under a known
 * provider id). Used by `removeInstallConfig` to revert only what we own.
 */
function isProxyRewrittenBaseUrl(baseUrl: string): boolean {
  const match = baseUrl.match(/\/proxy\/([^/?#]+)/);
  return !!match && !!getProvider(match[1]);
}

/**
 * Map of provider id → env var name that OpenClaw's spawned agent subprocess
 * reads to override the upstream URL for that provider. Based on each SDK's
 * convention — Anthropic's Python/TS SDKs read ANTHROPIC_BASE_URL, OpenAI's
 * read OPENAI_BASE_URL, etc.
 *
 * Reason this exists: some OpenClaw providers (anthropic, specifically) route
 * through a dedicated SDK code path that ignores `models.providers.<id>.baseUrl`
 * and only respects the SDK's native env var. See issue #150.
 *
 * Only populated for providers where rewriting `models.providers.<id>.baseUrl`
 * alone has been shown to not work — adding other providers here should be
 * gated on actually reproducing a bypass.
 */
const SDK_BASE_URL_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
};

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

      // Configure OTLP endpoint for the diagnostics-otel plugin to send to
      cfg.diagnostics = (cfg.diagnostics as Record<string, unknown>) ?? {};
      (cfg.diagnostics as Record<string, unknown>).enabled = true;
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

      // Optionally route every configured provider through panopticon's proxy
      // so request/response bodies are captured. Providers panopticon doesn't
      // know about are left alone — we don't want to break the user's setup.
      if (opts.proxy) {
        const models = (cfg.models as Record<string, unknown>) ?? {};
        const providers =
          (models.providers as Record<string, Record<string, unknown>>) ?? {};
        const env = (cfg.env as Record<string, unknown>) ?? {};
        for (const id of Object.keys(providers)) {
          if (!getProvider(id)) {
            console.warn(
              `panopticon: OpenClaw provider "${id}" is not in panopticon's provider registry — leaving baseUrl unchanged`,
            );
            continue;
          }
          const proxyUrl = `http://localhost:${opts.port}/proxy/${id}`;
          providers[id].baseUrl = proxyUrl;

          // Belt-and-suspenders: some OpenClaw providers (anthropic) route
          // through an SDK code path that ignores models.providers.<id>.baseUrl
          // and only respects the SDK's env var. Set both; whichever is read
          // wins. See issue #150.
          const envVar = SDK_BASE_URL_ENV[id];
          if (envVar) {
            // Warn if we're clobbering a user-set value that isn't already
            // our proxy — they may have been using a different upstream
            // (e.g. corporate gateway, Cloudflare AI Gateway). `uninstall`
            // deletes this value without restoring the original, so losing
            // it here is a one-way trip until the user manually re-adds it.
            const existing = env[envVar];
            if (
              typeof existing === "string" &&
              existing !== proxyUrl &&
              !isProxyRewrittenBaseUrl(existing)
            ) {
              console.warn(
                `panopticon: overwriting existing ${envVar}="${existing}" with "${proxyUrl}". ` +
                  "Your original value is not saved — if you need it, note it now before running uninstall.",
              );
            }
            env[envVar] = proxyUrl;
          }
        }
        if (Object.keys(providers).length > 0) {
          models.providers = providers;
          cfg.models = models;
        }
        if (Object.keys(env).length > 0) {
          cfg.env = env;
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

      // Remove diagnostics.otel block and master toggle
      const diagnostics = cfg.diagnostics as
        | Record<string, unknown>
        | undefined;
      if (diagnostics) {
        delete diagnostics.otel;
        delete diagnostics.enabled;
        if (Object.keys(diagnostics).length === 0) delete cfg.diagnostics;
      }

      // Revert any provider baseUrl that points at panopticon's proxy
      const models = cfg.models as Record<string, unknown> | undefined;
      const providers = models?.providers as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (providers) {
        for (const provider of Object.values(providers)) {
          if (
            typeof provider.baseUrl === "string" &&
            isProxyRewrittenBaseUrl(provider.baseUrl)
          ) {
            delete provider.baseUrl;
          }
        }
      }

      // Revert any SDK base-URL env vars that point at panopticon's proxy
      const env = cfg.env as Record<string, unknown> | undefined;
      if (env) {
        for (const envVar of Object.values(SDK_BASE_URL_ENV)) {
          if (
            typeof env[envVar] === "string" &&
            isProxyRewrittenBaseUrl(env[envVar] as string)
          ) {
            delete env[envVar];
          }
        }
        if (Object.keys(env).length === 0) delete cfg.env;
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
          cfg.diagnostics?.enabled === true &&
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

  // No `ident.modelPatterns`: OpenClaw routes to many providers (kimi, gpt-*,
  // claude-*, etc.) so model-name-based detection would conflict with
  // claude/codex/gemini adapters. Source attribution for OpenClaw rows comes
  // from explicit `source: "openclaw"` on hook payloads (matched via eventMap)
  // and `service.name=openclaw-gateway` on OTel rows (matched via
  // _serviceNameMap in src/otlp/server.ts).

  // No `proxy` spec: OpenClaw proxy capture happens through the provider
  // registry — `applyInstallConfig` rewrites each configured provider's
  // baseUrl to panopticon's per-provider proxy prefix. See providers/builtin.ts.
};

registerTarget(openclaw);
