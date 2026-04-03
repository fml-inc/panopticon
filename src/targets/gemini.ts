import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookInput } from "../hooks/ingest.js";
import { defaultToolCategory } from "../scanner/categories.js";
import { registerTarget } from "./registry.js";
import type { ParsedToolCall, ParseResult, TargetAdapter } from "./types.js";

const GEMINI_TOOL_CATEGORIES: Record<string, string> = {
  read_file: "Read",
  read_many_files: "Read",
  write_file: "Write",
  edit_file: "Edit",
  run_shell_command: "Bash",
  shell: "Bash",
  glob: "Glob",
  list_directory: "Glob",
  grep: "Grep",
  search_files: "Grep",
  web_search: "Web",
};

function geminiToolCategory(toolName: string): string {
  return GEMINI_TOOL_CATEGORIES[toolName] ?? defaultToolCategory(toolName);
}

const GEMINI_DIR = path.join(os.homedir(), ".gemini");

const gemini: TargetAdapter = {
  id: "gemini",

  config: {
    dir: GEMINI_DIR,
    configPath: path.join(GEMINI_DIR, "settings.json"),
    configFormat: "json",
  },

  hooks: {
    // Gemini's native event names
    events: ["SessionStart", "BeforeModel", "BeforeTool", "AfterTool"],
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
        // Remove existing panopticon hooks (check both old and new format)
        hooks[event] = (hooks[event] as Array<Record<string, unknown>>)
          .map((group) => ({
            ...group,
            hooks: (
              (group.hooks as Array<Record<string, unknown>>) || []
            ).filter(
              (h) =>
                !(h.command as string)?.includes("panopticon") &&
                !(h.path as string)?.includes("panopticon"),
            ),
          }))
          .filter((group) => (group.hooks as unknown[]).length > 0);
        // Add panopticon hook
        (hooks[event] as unknown[]).push({
          hooks: [
            {
              type: "command",
              command: `node ${hookBin} gemini ${opts.port}${opts.proxy ? " --proxy" : ""}`,
            },
          ],
        });
      }
      settings.hooks = hooks;

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
        otlpProtocol: "http",
        otlpEndpoint: `http://localhost:${opts.port}`,
      });

      return settings;
    },
    removeInstallConfig(existing) {
      const settings = { ...existing };

      // Remove panopticon hooks from each event (check both old and new format)
      const hooks = settings.hooks as Record<string, unknown[]> | undefined;
      if (hooks) {
        for (const event of Object.keys(hooks)) {
          hooks[event] = (hooks[event] as Array<Record<string, unknown>>)
            .map((group) => ({
              ...group,
              hooks: (
                (group.hooks as Array<Record<string, unknown>>) || []
              ).filter(
                (h) =>
                  !(h.command as string)?.includes("panopticon") &&
                  !(h.path as string)?.includes("panopticon"),
              ),
            }))
            .filter((group) => (group.hooks as unknown[]).length > 0);
          if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
        }
        if (Object.keys(hooks).length === 0) delete settings.hooks;
      }

      // Remove hooksConfig if empty
      delete settings.hooksConfig;

      // Remove MCP server
      const servers = settings.mcpServers as
        | Record<string, unknown>
        | undefined;
      if (servers) {
        delete servers.panopticon;
        if (Object.keys(servers).length === 0) delete settings.mcpServers;
      }

      // Remove telemetry config
      delete settings.telemetry;

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

  otel: {
    serviceName: "gemini-cli",
    metrics: {
      metricNames: ["gemini_cli.token.usage", "gen_ai.client.token.usage"],
      aggregation: "MAX",
      tokenTypeAttrs: ['$."gen_ai.token.type"'],
      modelAttrs: ['$."gen_ai.response.model"'],
    },
  },

  scanner: {
    normalizeToolCategory: geminiToolCategory,
    discover() {
      const tmpDir = path.join(GEMINI_DIR, "tmp");
      const files: { filePath: string }[] = [];
      const safeReaddir = (d: string) => {
        try {
          return fs.readdirSync(d);
        } catch {
          return [];
        }
      };
      for (const project of safeReaddir(tmpDir)) {
        const chatsDir = path.join(tmpDir, project, "chats");
        for (const entry of safeReaddir(chatsDir)) {
          if (entry.startsWith("session-") && entry.endsWith(".json"))
            files.push({ filePath: path.join(chatsDir, entry) });
        }
      }
      return files;
    },

    parseFile(filePath: string, fromByteOffset: number): ParseResult | null {
      let size: number;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        return null;
      }
      if (size <= fromByteOffset) return null;

      // Gemini writes a single JSON object, re-read fully when changed.
      let session: Record<string, unknown>;
      try {
        session = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        return null;
      }

      const sessionId = session.sessionId as string | undefined;
      if (!sessionId) return null;

      const messages = session.messages as
        | Array<Record<string, unknown>>
        | undefined;
      if (!messages?.length) return null;

      const meta: ParseResult["meta"] = {
        sessionId,
        startedAtMs: session.startTime
          ? new Date(session.startTime as string).getTime()
          : undefined,
      };

      const turns: ParseResult["turns"] = [];
      const events: ParseResult["events"] = [];
      const parsedMessages: ParseResult["messages"] = [];
      let turnIndex = 0;
      let ordinal = 0;
      let firstPrompt: string | undefined;

      for (const msg of messages) {
        const type = msg.type as string;
        const timestamp = msg.timestamp as string | undefined;
        const timestampMs = timestamp
          ? new Date(timestamp).getTime()
          : Date.now();

        if (type === "user") {
          const content = msg.content as Array<{ text?: string }> | undefined;
          const textParts: string[] = [];
          if (content) {
            for (const block of content) {
              if (block.text) textParts.push(block.text);
            }
          }
          const fullContent = textParts.join("\n");
          const preview = textParts[0]?.slice(0, 200);
          if (!firstPrompt && preview) firstPrompt = preview;

          turns.push({
            sessionId,
            turnIndex: turnIndex++,
            timestampMs,
            role: "user",
            contentPreview: preview,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
          });

          if (fullContent.length > 0) {
            parsedMessages.push({
              sessionId,
              ordinal: ordinal++,
              role: "user",
              content: fullContent,
              timestampMs,
              hasThinking: false,
              hasToolUse: false,
              isSystem: false,
              contentLength: fullContent.length,
              hasContextTokens: false,
              hasOutputTokens: false,
              toolCalls: [],
              toolResults: new Map(),
            });
          }
        }

        if (type === "gemini") {
          const model = msg.model as string | undefined;
          const tokens = msg.tokens as Record<string, number> | undefined;
          if (model && !meta.model) meta.model = model;

          const inputTokens = tokens?.input ?? 0;
          const outTokens = tokens?.output ?? 0;
          const cacheRead = tokens?.cached ?? 0;
          const reasoning = tokens?.thoughts ?? 0;

          turns.push({
            sessionId,
            turnIndex: turnIndex++,
            timestampMs,
            model,
            role: "assistant",
            contentPreview:
              typeof msg.content === "string"
                ? msg.content.slice(0, 200)
                : undefined,
            inputTokens,
            outputTokens: outTokens,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: 0,
            reasoningTokens: reasoning,
          });

          // Build message content
          const textParts: string[] = [];
          if (typeof msg.content === "string") textParts.push(msg.content);

          // Tool calls
          const msgToolCalls = msg.toolCalls as
            | Array<Record<string, unknown>>
            | undefined;
          const toolCalls: ParsedToolCall[] = [];
          const toolResults = new Map<
            string,
            { contentLength: number; contentRaw: string }
          >();

          if (msgToolCalls) {
            for (let tcIdx = 0; tcIdx < msgToolCalls.length; tcIdx++) {
              const tc = msgToolCalls[tcIdx];
              const toolName = ((tc.name ?? tc.displayName) as string) ?? "";
              const inputJson = tc.args ? JSON.stringify(tc.args) : undefined;
              const toolUseId =
                (tc.id as string) || `${toolName}-${timestampMs}-${tcIdx}`;

              toolCalls.push({
                toolUseId,
                toolName,
                category: geminiToolCategory(toolName),
                inputJson,
              });

              const result = tc.result as
                | Array<Record<string, unknown>>
                | undefined;
              const fnResponse = result?.[0]?.functionResponse as
                | Record<string, unknown>
                | undefined;
              const responseObj = fnResponse?.response as
                | Record<string, unknown>
                | undefined;
              const output =
                typeof responseObj?.output === "string"
                  ? responseObj.output
                  : fnResponse
                    ? JSON.stringify(fnResponse)
                    : undefined;
              if (output) {
                toolResults.set(toolUseId, {
                  contentLength: output.length,
                  contentRaw: output,
                });
              }

              events.push({
                sessionId,
                eventType: "tool_call",
                timestampMs,
                toolName,
                toolInput: inputJson?.slice(0, 1000),
                toolOutput: output?.slice(0, 1000),
              });
            }
          }

          // Thoughts/reasoning
          let hasThinking = false;
          const thoughts = msg.thoughts as
            | Array<Record<string, unknown>>
            | undefined;
          if (thoughts) {
            hasThinking = true;
            for (const t of thoughts) {
              const text = (t.description ?? t.subject) as string | undefined;
              if (text) textParts.push(`[Thinking]\n${text}\n[/Thinking]`);
              events.push({
                sessionId,
                eventType: "reasoning",
                timestampMs,
                content: text?.slice(0, 500),
              });
            }
          }

          const fullContent = textParts.join("\n");
          const ctxTokens = inputTokens + cacheRead;
          const hasCtx = inputTokens > 0 || cacheRead > 0;

          parsedMessages.push({
            sessionId,
            ordinal: ordinal++,
            role: "assistant",
            content: fullContent,
            timestampMs,
            hasThinking,
            hasToolUse: toolCalls.length > 0,
            isSystem: false,
            contentLength: fullContent.length,
            model,
            tokenUsage: tokens ? JSON.stringify(tokens) : undefined,
            contextTokens: hasCtx ? ctxTokens : undefined,
            outputTokens: outTokens > 0 ? outTokens : undefined,
            hasContextTokens: hasCtx,
            hasOutputTokens: outTokens > 0,
            toolCalls,
            toolResults,
          });
        }

        if (type === "info") {
          events.push({
            sessionId,
            eventType: "info",
            timestampMs,
            content:
              typeof msg.content === "string"
                ? msg.content.slice(0, 500)
                : undefined,
          });
        }
      }

      if (firstPrompt) meta.firstPrompt = firstPrompt;
      return {
        meta,
        turns,
        events,
        messages: parsedMessages,
        newByteOffset: size,
        absoluteIndices: true,
      };
    },
  },
};

registerTarget(gemini);
