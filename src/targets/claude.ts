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

          // Extract content blocks from assistant messages
          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block !== "object" || block === null) continue;
              const b = block as Record<string, unknown>;

              if (b.type === "tool_use") {
                const input = b.input as Record<string, unknown> | undefined;
                events.push({
                  sessionId: sid,
                  eventType: "tool_call",
                  timestampMs: tsMs,
                  toolName: b.name as string | undefined,
                  toolInput: input
                    ? JSON.stringify(input).slice(0, 10_000)
                    : undefined,
                  metadata: { tool_use_id: b.id },
                });
              }

              if (b.type === "thinking") {
                events.push({
                  sessionId: sid,
                  eventType: "thinking",
                  timestampMs: tsMs,
                  content:
                    typeof b.thinking === "string"
                      ? b.thinking.slice(0, 2_000)
                      : undefined,
                  metadata: {
                    has_signature: !!b.signature,
                  },
                });
              }
            }
          }
        }

        // Extract content blocks from user messages
        if (type === "user") {
          const msg = obj.message as Record<string, unknown> | undefined;
          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block !== "object" || block === null) continue;
              const b = block as Record<string, unknown>;

              if (b.type === "tool_result") {
                const resultContent = b.content;
                events.push({
                  sessionId: sid,
                  eventType: "tool_result",
                  timestampMs: tsMs,
                  toolOutput:
                    typeof resultContent === "string"
                      ? resultContent.slice(0, 500)
                      : undefined,
                  metadata: {
                    tool_use_id: b.tool_use_id,
                    is_error: b.is_error,
                  },
                });
              }

              if (b.type === "image") {
                const src = b.source as Record<string, unknown> | undefined;
                events.push({
                  sessionId: sid,
                  eventType: "image",
                  timestampMs: tsMs,
                  metadata: {
                    media_type: src?.media_type,
                    source_type: src?.type,
                  },
                });
              }
            }
          }
        }

        // System events
        if (type === "system") {
          const data = obj.data as Record<string, unknown> | undefined;
          const level = obj.level as string | undefined;
          const subtype = obj.subtype as string | undefined;

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
          } else if (
            subtype === "stop_hook_summary" ||
            level === "suggestion"
          ) {
            events.push({
              sessionId: sid,
              eventType: subtype ?? "system",
              timestampMs: tsMs,
              metadata: {
                subtype,
                level,
                hookCount: obj.hookCount,
                hookInfos: obj.hookInfos,
                stopReason: obj.stopReason,
                preventedContinuation: obj.preventedContinuation,
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

        // Progress events
        if (type === "progress") {
          const data = obj.data as Record<string, unknown> | undefined;
          const hookEvent = data?.hookEvent as string | undefined;
          const progressType = data?.type as string | undefined;

          if (hookEvent || data?.durationMs) {
            // Hook-related progress (PreToolUse, PostToolUse, Stop, etc.)
            events.push({
              sessionId: sid,
              eventType: hookEvent ? `progress:${hookEvent}` : "progress",
              timestampMs: tsMs,
              toolName: (data?.hookName ?? data?.toolName) as
                | string
                | undefined,
              metadata: {
                hookEvent,
                durationMs: data?.durationMs,
              },
            });
          } else if (progressType === "agent_progress") {
            // Subagent activity
            events.push({
              sessionId: sid,
              eventType: "agent_progress",
              timestampMs: tsMs,
              metadata: {
                parentToolUseID: data?.parentToolUseID ?? obj.parentToolUseID,
                toolUseID: obj.toolUseID,
              },
            });
          }
        }

        // Queue operations (user prompt queue)
        if (type === "queue-operation") {
          const operation = obj.operation as string | undefined;
          events.push({
            sessionId: sid,
            eventType: `queue:${operation ?? "unknown"}`,
            timestampMs: tsMs,
            content:
              typeof obj.content === "string"
                ? obj.content.slice(0, 500)
                : undefined,
          });
        }

        // Last prompt marker
        if (type === "last-prompt") {
          events.push({
            sessionId: sid,
            eventType: "last_prompt",
            timestampMs: tsMs,
            content:
              typeof obj.lastPrompt === "string"
                ? obj.lastPrompt.slice(0, 500)
                : undefined,
          });
        }
      }

      if (meta && firstPrompt && !meta.firstPrompt)
        meta.firstPrompt = firstPrompt;
      return { meta, turns, events, newByteOffset };
    },
  },
};

registerTarget(claude);
