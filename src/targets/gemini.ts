import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookInput } from "../hooks/ingest.js";
import { registerTarget } from "./registry.js";
import type { ScannerParseResult, TargetAdapter } from "./types.js";

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

    parseFile(
      filePath: string,
      fromByteOffset: number,
    ): ScannerParseResult | null {
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

      const meta: ScannerParseResult["meta"] = {
        sessionId,
        startedAtMs: session.startTime
          ? new Date(session.startTime as string).getTime()
          : undefined,
      };

      const turns: ScannerParseResult["turns"] = [];
      const events: ScannerParseResult["events"] = [];
      let turnIndex = 0;
      let firstPrompt: string | undefined;

      for (const msg of messages) {
        const type = msg.type as string;
        const timestamp = msg.timestamp as string | undefined;
        const timestampMs = timestamp
          ? new Date(timestamp).getTime()
          : Date.now();

        if (type === "user") {
          const content = msg.content as Array<{ text?: string }> | undefined;
          const text = content?.[0]?.text;
          if (!firstPrompt && text) firstPrompt = text.slice(0, 200);
          turns.push({
            sessionId,
            turnIndex: turnIndex++,
            timestampMs,
            role: "user",
            contentPreview: text?.slice(0, 200),
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
          });
        }

        if (type === "gemini") {
          const model = msg.model as string | undefined;
          const tokens = msg.tokens as Record<string, number> | undefined;
          if (model && !meta.model) meta.model = model;
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
            inputTokens: tokens?.input ?? 0,
            outputTokens: tokens?.output ?? 0,
            cacheReadTokens: tokens?.cached ?? 0,
            cacheCreationTokens: 0,
            reasoningTokens: tokens?.thoughts ?? 0,
          });

          // Tool calls
          const toolCalls = msg.toolCalls as
            | Array<Record<string, unknown>>
            | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const result = tc.result as
                | Array<Record<string, unknown>>
                | undefined;
              const output = result?.[0]?.functionResponse;
              events.push({
                sessionId,
                eventType: "tool_call",
                timestampMs,
                toolName: (tc.name ?? tc.displayName) as string | undefined,
                toolInput: tc.args
                  ? JSON.stringify(tc.args).slice(0, 1000)
                  : undefined,
                toolOutput: output
                  ? JSON.stringify(output).slice(0, 1000)
                  : undefined,
              });
            }
          }

          // Thoughts/reasoning
          const thoughts = msg.thoughts as
            | Array<Record<string, unknown>>
            | undefined;
          if (thoughts) {
            for (const t of thoughts) {
              events.push({
                sessionId,
                eventType: "reasoning",
                timestampMs,
                content: ((t.description ?? t.subject) as string)?.slice(
                  0,
                  500,
                ),
              });
            }
          }
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
      return { meta, turns, events, newByteOffset: size };
    },
  },
};

registerTarget(gemini);
