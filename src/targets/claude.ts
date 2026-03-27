import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { readNewLines } from "../scanner/reader.js";
import { registerTarget } from "./registry.js";
import type { ScannerParseResult, TargetAdapter } from "./types.js";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");

const claude: TargetAdapter = {
  id: "claude",

  config: {
    dir: CLAUDE_DIR,
    configPath: path.join(CLAUDE_DIR, "settings.json"),
    configFormat: "json",
  },

  hooks: {
    // Claude Code uses plugin marketplace, not direct hook registration.
    // Marketplace setup is handled separately in the install command;
    // this method handles the settings.json portion only.
    events: [],
    applyInstallConfig(existing, _opts) {
      const settings = { ...existing };
      settings.extraKnownMarketplaces =
        (settings.extraKnownMarketplaces as Record<string, unknown>) ?? {};
      (settings.extraKnownMarketplaces as Record<string, unknown>)[
        "local-plugins"
      ] = {
        source: { source: "directory", path: config.marketplaceDir },
      };
      settings.enabledPlugins =
        (settings.enabledPlugins as Record<string, unknown>) ?? {};
      (settings.enabledPlugins as Record<string, unknown>)[
        "panopticon@local-plugins"
      ] = true;
      return settings;
    },
    removeInstallConfig(existing) {
      const settings = { ...existing };
      const marketplaces = settings.extraKnownMarketplaces as
        | Record<string, unknown>
        | undefined;
      if (marketplaces) {
        delete marketplaces["local-plugins"];
        if (Object.keys(marketplaces).length === 0)
          delete settings.extraKnownMarketplaces;
      }
      const plugins = settings.enabledPlugins as
        | Record<string, unknown>
        | undefined;
      if (plugins) {
        delete plugins["panopticon@local-plugins"];
        delete plugins["fml@local-plugins"];
        if (Object.keys(plugins).length === 0) delete settings.enabledPlugins;
      }
      return settings;
    },
  },

  shellEnv: {
    envVars(port, proxy) {
      const vars: Array<[string, string]> = [
        ["CLAUDE_CODE_ENABLE_TELEMETRY", "1"],
      ];
      if (proxy) {
        vars.push([
          "ANTHROPIC_BASE_URL",
          `http://localhost:${port}/proxy/anthropic`,
        ]);
      }
      return vars;
    },
  },

  events: {
    // Claude Code already sends canonical event names
    eventMap: {},
    formatPermissionResponse({ allow, reason }) {
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
    displayName: "Claude Code",
    isInstalled: () => fs.existsSync(CLAUDE_DIR),
    isConfigured() {
      try {
        const settings = JSON.parse(
          fs.readFileSync(path.join(CLAUDE_DIR, "settings.json"), "utf-8"),
        );
        const plugins = settings.enabledPlugins ?? {};
        return (
          !!plugins["panopticon@local-plugins"] ||
          !!plugins["fml@local-plugins"]
        );
      } catch {
        return false;
      }
    },
  },

  proxy: {
    upstreamHost: "api.anthropic.com",
    accumulatorType: "anthropic",
  },

  otel: {
    metrics: {
      metricNames: ["claude_code.token.usage"],
      aggregation: "SUM",
      tokenTypeAttrs: ["$.type"],
      modelAttrs: ["$.model"],
    },
  },

  ident: {
    modelPatterns: [/^claude-/],
  },

  scanner: {
    discover() {
      const projectsDir = path.join(CLAUDE_DIR, "projects");
      const files: { filePath: string }[] = [];
      try {
        for (const slug of fs.readdirSync(projectsDir)) {
          const slugDir = path.join(projectsDir, slug);
          try {
            if (!fs.statSync(slugDir).isDirectory()) continue;
          } catch {
            continue;
          }
          for (const entry of fs.readdirSync(slugDir)) {
            if (entry.endsWith(".jsonl")) {
              files.push({ filePath: path.join(slugDir, entry) });
            }
          }
        }
      } catch {
        /* projects dir may not exist */
      }
      return files;
    },

    parseFile(
      filePath: string,
      fromByteOffset: number,
    ): ScannerParseResult | null {
      const { lines, newByteOffset } = readNewLines(filePath, fromByteOffset);
      if (lines.length === 0) return null;

      let meta: ScannerParseResult["meta"];
      const turns: ScannerParseResult["turns"] = [];
      let turnIndex = 0;
      let firstPrompt: string | undefined;

      for (const line of lines) {
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        const type = obj.type as string;
        const sessionId = obj.sessionId as string | undefined;

        if (!meta && sessionId) {
          meta = {
            sessionId,
            cliVersion: obj.version as string | undefined,
            cwd: obj.cwd as string | undefined,
            startedAtMs: obj.timestamp
              ? new Date(obj.timestamp as string).getTime()
              : undefined,
          };
        }

        if (type === "user") {
          const msg = obj.message as Record<string, unknown> | undefined;
          const content = msg?.content;
          let preview: string | undefined;
          if (typeof content === "string") {
            preview = content.slice(0, 200);
          } else if (Array.isArray(content)) {
            const text = content.find(
              (b: Record<string, unknown>) => b.type === "text",
            );
            if (text) preview = (text.text as string)?.slice(0, 200);
          }
          if (!firstPrompt && preview) firstPrompt = preview;

          turns.push({
            sessionId: sessionId ?? meta?.sessionId ?? "",
            turnIndex: turnIndex++,
            timestampMs: obj.timestamp
              ? new Date(obj.timestamp as string).getTime()
              : Date.now(),
            role: "user",
            contentPreview: preview,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
          });
        }

        if (type === "assistant") {
          const msg = obj.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, unknown> | undefined;
          const model = msg?.model as string | undefined;
          if (meta && model && !meta.model) meta.model = model;

          turns.push({
            sessionId: sessionId ?? meta?.sessionId ?? "",
            turnIndex: turnIndex++,
            timestampMs: obj.timestamp
              ? new Date(obj.timestamp as string).getTime()
              : Date.now(),
            model,
            role: "assistant",
            inputTokens: (usage?.input_tokens as number) ?? 0,
            outputTokens: (usage?.output_tokens as number) ?? 0,
            cacheReadTokens: (usage?.cache_read_input_tokens as number) ?? 0,
            cacheCreationTokens:
              (usage?.cache_creation_input_tokens as number) ?? 0,
            reasoningTokens: 0,
          });
        }
      }

      if (meta && firstPrompt && !meta.firstPrompt)
        meta.firstPrompt = firstPrompt;
      return { meta, turns, newByteOffset };
    },
  },
};

registerTarget(claude);
