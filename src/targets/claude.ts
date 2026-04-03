import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { defaultToolCategory } from "../scanner/categories.js";
import { readNewLines } from "../scanner/reader.js";
import { registerTarget } from "./registry.js";
import type { ParsedToolCall, ParseResult, TargetAdapter } from "./types.js";

const CLAUDE_TOOL_CATEGORIES: Record<string, string> = {
  Read: "Read",
  read_file: "Read",
  ReadNotebook: "Read",
  Edit: "Edit",
  StrReplace: "Edit",
  MultiEdit: "Edit",
  Write: "Write",
  create_file: "Write",
  NotebookEdit: "Write",
  Bash: "Bash",
  Grep: "Grep",
  Glob: "Glob",
  list_dir: "Glob",
  Task: "Task",
  Agent: "Task",
  TaskCreate: "Task",
  TaskUpdate: "Task",
  Skill: "Tool",
  WebSearch: "Web",
  WebFetch: "Web",
  ToolSearch: "Web",
};

function claudeToolCategory(toolName: string): string {
  const mapped = CLAUDE_TOOL_CATEGORIES[toolName];
  if (mapped) return mapped;
  if (toolName.startsWith("mcp__")) return "MCP";
  if (toolName.toLowerCase().includes("subagent")) return "Task";
  return defaultToolCategory(toolName);
}

/** Extract total text length from a tool_result content field. */
function extractToolResultTextLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let len = 0;
    for (const b of content) {
      if (
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).type === "text"
      ) {
        const text = (b as Record<string, unknown>).text;
        if (typeof text === "string") len += text.length;
      }
    }
    return len;
  }
  return 0;
}

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
    normalizeToolCategory: claudeToolCategory,
    discover() {
      const projectsDir = path.join(CLAUDE_DIR, "projects");
      const files: { filePath: string }[] = [];
      const safeReaddir = (d: string) => {
        try {
          return fs.readdirSync(d);
        } catch {
          return [];
        }
      };
      const safeIsDir = (d: string) => {
        try {
          return fs.statSync(d).isDirectory();
        } catch {
          return false;
        }
      };
      try {
        for (const slug of fs.readdirSync(projectsDir)) {
          const slugDir = path.join(projectsDir, slug);
          if (!safeIsDir(slugDir)) continue;
          for (const entry of fs.readdirSync(slugDir)) {
            const entryPath = path.join(slugDir, entry);
            if (entry.endsWith(".jsonl")) {
              files.push({ filePath: entryPath });
            }
            // Recurse into session UUID directories for subagent JSONL files
            // e.g. {slug}/{uuid}/subagents/agent-*.jsonl
            if (safeIsDir(entryPath)) {
              const subagentsDir = path.join(entryPath, "subagents");
              for (const sub of safeReaddir(subagentsDir)) {
                if (sub.endsWith(".jsonl")) {
                  files.push({
                    filePath: path.join(subagentsDir, sub),
                  });
                }
              }
            }
          }
        }
      } catch {
        /* projects dir may not exist */
      }
      return files;
    },

    parseFile(filePath: string, fromByteOffset: number): ParseResult | null {
      const { lines, newByteOffset } = readNewLines(filePath, fromByteOffset);
      if (lines.length === 0) return null;

      let meta: ParseResult["meta"];
      const turns: ParseResult["turns"] = [];
      const events: ParseResult["events"] = [];
      const messages: ParseResult["messages"] = [];
      let turnIndex = 0;
      let ordinal = 0;
      let firstPrompt: string | undefined;
      // Map tool_use_id → subagent session ID (e.g. "agent-abc123")
      const subagentMap = new Map<string, string>();

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
          const textParts: string[] = [];
          const toolResults = new Map<
            string,
            { contentLength: number; contentRaw: string }
          >();

          if (typeof content === "string") {
            preview = content.slice(0, 200);
            textParts.push(content);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block !== "object" || block === null) continue;
              const b = block as Record<string, unknown>;
              if (b.type === "text" && typeof b.text === "string") {
                textParts.push(b.text);
              } else if (b.type === "tool_result") {
                const raw = JSON.stringify(b.content ?? "");
                const textLen = extractToolResultTextLength(b.content);
                toolResults.set(b.tool_use_id as string, {
                  contentLength: textLen,
                  contentRaw: raw,
                });
              }
            }
            if (textParts.length > 0) {
              preview = textParts[0].slice(0, 200);
            }
          }
          if (!firstPrompt && preview) firstPrompt = preview;

          const fullContent = textParts.join("\n");

          // Skip meta/system messages (following agentsview's filtering)
          const isMeta = obj.isMeta === true;
          const isCompact = obj.isCompactSummary === true;
          if (
            !isMeta &&
            !isCompact &&
            (fullContent.length > 0 || toolResults.size > 0)
          ) {
            messages.push({
              sessionId: sid,
              ordinal: ordinal++,
              role: "user",
              content: fullContent,
              timestampMs: tsMs,
              hasThinking: false,
              hasToolUse: false,
              isSystem: false,
              contentLength: fullContent.length,
              hasContextTokens: false,
              hasOutputTokens: false,
              toolCalls: [],
              toolResults,
            });
          }

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

          // Build message content and tool calls from content blocks
          const textParts: string[] = [];
          let hasThinking = false;
          let hasToolUse = false;
          const toolCalls: ParsedToolCall[] = [];

          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block !== "object" || block === null) continue;
              const b = block as Record<string, unknown>;

              if (b.type === "text" && typeof b.text === "string") {
                textParts.push(b.text);
              }

              if (b.type === "thinking") {
                hasThinking = true;
                if (typeof b.thinking === "string") {
                  textParts.push(`[Thinking]\n${b.thinking}\n[/Thinking]`);
                }

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

              if (b.type === "tool_use") {
                hasToolUse = true;
                const toolName = (b.name as string) ?? "";
                const input = b.input as Record<string, unknown> | undefined;
                const inputJson = input ? JSON.stringify(input) : undefined;

                // Extract skill name for Skill tools
                let skillName: string | undefined;
                if (toolName === "Skill" && input) {
                  skillName = (input.skill ?? input.name) as string | undefined;
                }

                toolCalls.push({
                  toolUseId: (b.id as string) ?? "",
                  toolName,
                  category: claudeToolCategory(toolName),
                  inputJson,
                  skillName,
                });

                events.push({
                  sessionId: sid,
                  eventType: "tool_call",
                  timestampMs: tsMs,
                  toolName,
                  toolInput: inputJson?.slice(0, 10_000),
                  metadata: { tool_use_id: b.id },
                });
              }
            }
          }

          const fullContent = textParts.join("\n");
          const inputTokens = (usage?.input_tokens as number) ?? 0;
          const outTokens = (usage?.output_tokens as number) ?? 0;
          const cacheRead = (usage?.cache_read_input_tokens as number) ?? 0;
          const cacheCreation =
            (usage?.cache_creation_input_tokens as number) ?? 0;
          const ctxTokens = inputTokens + cacheRead + cacheCreation;
          const hasCtx = inputTokens > 0 || cacheRead > 0 || cacheCreation > 0;

          messages.push({
            sessionId: sid,
            ordinal: ordinal++,
            role: "assistant",
            content: fullContent,
            timestampMs: tsMs,
            hasThinking,
            hasToolUse,
            isSystem: false,
            contentLength: fullContent.length,
            model,
            tokenUsage: usage ? JSON.stringify(usage) : undefined,
            contextTokens: hasCtx ? ctxTokens : undefined,
            outputTokens: outTokens > 0 ? outTokens : undefined,
            hasContextTokens: hasCtx,
            hasOutputTokens: outTokens > 0,
            toolCalls,
            toolResults: new Map(),
          });

          turns.push({
            sessionId: sid,
            turnIndex: turnIndex++,
            timestampMs: tsMs,
            model,
            role: "assistant",
            inputTokens,
            outputTokens: outTokens,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            reasoningTokens: 0,
          });
        }

        // Extract content blocks from user messages (events only — message already built above)
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
            // Subagent activity — build tool_use_id → agent session mapping
            const tuid = (data?.parentToolUseID ?? obj.parentToolUseID) as
              | string
              | undefined;
            const agentId = (data?.agentId ?? obj.agentId) as
              | string
              | undefined;
            if (tuid && agentId) {
              subagentMap.set(tuid, `agent-${agentId}`);
            }
            events.push({
              sessionId: sid,
              eventType: "agent_progress",
              timestampMs: tsMs,
              metadata: {
                parentToolUseID: tuid,
                toolUseID: obj.toolUseID,
              },
            });
          }
        }

        // Queue operations (user prompt queue)
        if (type === "queue-operation") {
          const operation = obj.operation as string | undefined;
          // Extract subagent mapping from enqueue operations
          if (operation === "enqueue" && typeof obj.content === "string") {
            try {
              const qc = JSON.parse(obj.content) as Record<string, unknown>;
              const tuid = qc.tool_use_id as string | undefined;
              const taskId = qc.task_id as string | undefined;
              if (tuid && taskId) {
                subagentMap.set(tuid, `agent-${taskId}`);
              }
            } catch {
              // Try XML-style extraction as fallback
              const tuidMatch = obj.content.match(
                /<tool-use-id>([^<]+)<\/tool-use-id>/,
              );
              const taskMatch = obj.content.match(
                /<task-id>([^<]+)<\/task-id>/,
              );
              if (tuidMatch?.[1] && taskMatch?.[1]) {
                subagentMap.set(tuidMatch[1], `agent-${taskMatch[1]}`);
              }
            }
          }
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

      // Annotate tool calls with subagent session IDs
      if (subagentMap.size > 0) {
        for (const msg of messages) {
          for (const tc of msg.toolCalls) {
            const agentSid = subagentMap.get(tc.toolUseId);
            if (agentSid && (tc.category === "Task" || tc.toolName === "Agent"))
              tc.subagentSessionId = agentSid;
          }
        }
      }

      return { meta, turns, events, messages, newByteOffset };
    },
  },
};

registerTarget(claude);
