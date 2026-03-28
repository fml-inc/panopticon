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

      // Clean up stale hooks from older panopticon/fml installs that wrote
      // hook entries directly into settings.json.  The plugin system now
      // handles hooks via hooks.json, so these are redundant and break when
      // package paths change.
      const hooks = settings.hooks as Record<string, unknown[]> | undefined;
      if (hooks) {
        for (const event of Object.keys(hooks)) {
          const entries = hooks[event];
          if (!Array.isArray(entries)) continue;
          hooks[event] = entries.filter(
            (h) =>
              !(
                typeof h === "object" &&
                h !== null &&
                JSON.stringify(h).includes("hook-handler")
              ),
          );
          if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
        }
        if (Object.keys(hooks).length === 0) delete settings.hooks;
      }

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
      const events: ScannerParseResult["events"] = [];
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
        const sid = sessionId ?? meta?.sessionId ?? "";
        const tsMs = obj.timestamp
          ? new Date(obj.timestamp as string).getTime()
          : Date.now();

        if (!meta && sessionId) {
          meta = {
            sessionId,
            cliVersion: obj.version as string | undefined,
            cwd: obj.cwd as string | undefined,
            startedAtMs: tsMs,
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
            sessionId: sid,
            turnIndex: turnIndex++,
            timestampMs: tsMs,
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
            sessionId: sid,
            turnIndex: turnIndex++,
            timestampMs: tsMs,
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

        // System events: API errors, retries
        if (type === "system") {
          const data = obj.data as Record<string, unknown> | undefined;
          const level = obj.level as string | undefined;
          if (data?.type === "api_error" || level === "error") {
            events.push({
              sessionId: sid,
              eventType: "error",
              timestampMs: tsMs,
              content:
                typeof data?.message === "string" ? data.message : undefined,
              metadata: {
                level,
                retryAttempt: data?.retryAttempt,
                maxRetries: data?.maxRetries,
                retryInMs: data?.retryInMs,
              },
            });
          }
        }

        // File history snapshots
        if (type === "file-history-snapshot") {
          const data = obj.data as Record<string, unknown> | undefined;
          const messageId = obj.messageId as string | undefined;
          events.push({
            sessionId: sid,
            eventType: "file_snapshot",
            timestampMs: tsMs,
            metadata: { messageId, ...(data ?? {}) },
          });
        }

        // Progress events with duration
        if (type === "progress") {
          const data = obj.data as Record<string, unknown> | undefined;
          if (data?.durationMs || data?.hookEvent) {
            events.push({
              sessionId: sid,
              eventType: "progress",
              timestampMs: tsMs,
              toolName: data.hookName as string | undefined,
              metadata: {
                hookEvent: data.hookEvent,
                durationMs: data.durationMs,
              },
            });
          }
        }
      }

      if (meta && firstPrompt && !meta.firstPrompt)
        meta.firstPrompt = firstPrompt;
      return { meta, turns, events, newByteOffset };
    },
  },
};

registerTarget(claude);
