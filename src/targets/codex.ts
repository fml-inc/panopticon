import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readNewLines } from "../scanner/reader.js";
import { registerTarget } from "./registry.js";
import type { ScannerParseResult, TargetAdapter } from "./types.js";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_HOOKS_JSON = path.join(CODEX_DIR, "hooks.json");

// PascalCase event names matching the Codex hooks engine schema
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
];

function readHooksJson(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CODEX_HOOKS_JSON, "utf-8"));
  } catch {
    return {};
  }
}

function writeHooksJson(data: Record<string, unknown>): void {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(CODEX_HOOKS_JSON, `${JSON.stringify(data, null, 2)}\n`);
}

const codex: TargetAdapter = {
  id: "codex",

  config: {
    dir: CODEX_DIR,
    configPath: path.join(CODEX_DIR, "config.toml"),
    configFormat: "toml",
  },

  hooks: {
    events: HOOK_EVENTS,
    applyInstallConfig(existing, opts) {
      const codexConfig = { ...existing };
      const hookBin = path.join(opts.pluginRoot, "bin", "hook-handler");
      const mcpBin = path.join(opts.pluginRoot, "bin", "mcp-server");

      // Enable the codex_hooks feature flag
      codexConfig.features =
        (codexConfig.features as Record<string, unknown>) ?? {};
      (codexConfig.features as Record<string, unknown>).codex_hooks = true;
      // Codex reads this at top level, not under [features]
      codexConfig.suppress_unstable_features_warning = true;

      // Remove any legacy TOML hook entries
      delete codexConfig.hooks;

      // Write hooks.json (the format the new hooks engine expects)
      const hooksFile = readHooksJson();
      const hooks = (hooksFile.hooks as Record<string, unknown[]>) ?? {};
      const proxyFlag = opts.proxy ? " --proxy" : "";
      const command = `node ${hookBin} codex ${opts.port}${proxyFlag}`;
      for (const event of HOOK_EVENTS) {
        const groups = (hooks[event] ?? []) as Array<Record<string, unknown>>;
        // Remove existing panopticon groups
        hooks[event] = groups.filter((g) => {
          const h = ((g.hooks as unknown[]) ?? []) as Array<
            Record<string, unknown>
          >;
          return !h.some((entry) =>
            (entry.command as string)?.includes("panopticon"),
          );
        });
        // Add panopticon hook group
        (hooks[event] as unknown[]).push({
          hooks: [{ type: "command", command, timeout: 10 }],
        });
      }
      hooksFile.hooks = hooks;
      writeHooksJson(hooksFile);

      // Configure API proxy (opt-in via --proxy)
      if (opts.proxy) {
        codexConfig.openai_base_url = `http://localhost:${opts.port}/proxy/codex`;
      } else {
        delete codexConfig.openai_base_url;
      }

      // Configure OTel telemetry
      delete codexConfig.telemetry; // Remove legacy format
      const endpoint = `http://localhost:${opts.port}`;
      const exporterConfig = { endpoint, protocol: "binary" };
      codexConfig.otel = {
        ...((codexConfig.otel as Record<string, unknown>) ?? {}),
        log_user_prompt: true,
        exporter: { "otlp-http": exporterConfig },
        trace_exporter: { "otlp-http": exporterConfig },
        metrics_exporter: { "otlp-http": exporterConfig },
      };

      // Register MCP server
      const mcpServers = (codexConfig.mcp_servers ?? {}) as Record<
        string,
        unknown
      >;
      mcpServers.panopticon = { command: "node", args: [mcpBin] };
      codexConfig.mcp_servers = mcpServers;

      return codexConfig;
    },
    removeInstallConfig(existing) {
      const cfg = { ...existing };

      // Remove feature flags
      const features = cfg.features as Record<string, unknown> | undefined;
      if (features) {
        delete features.codex_hooks;
        if (Object.keys(features).length === 0) delete cfg.features;
      }
      delete cfg.suppress_unstable_features_warning;

      // Remove any legacy TOML hook entries
      delete cfg.hooks;

      // Remove panopticon hooks from hooks.json
      const hooksFile = readHooksJson();
      const hooks = hooksFile.hooks as Record<string, unknown[]> | undefined;
      if (hooks) {
        for (const event of Object.keys(hooks)) {
          hooks[event] = (
            hooks[event] as Array<Record<string, unknown>>
          ).filter((g) => {
            const h = ((g.hooks as unknown[]) ?? []) as Array<
              Record<string, unknown>
            >;
            return !h.some((entry) =>
              (entry.command as string)?.includes("panopticon"),
            );
          });
          if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
        }
        if (Object.keys(hooks).length === 0) {
          // Remove hooks.json entirely if empty
          try {
            fs.unlinkSync(CODEX_HOOKS_JSON);
          } catch {}
        } else {
          hooksFile.hooks = hooks;
          writeHooksJson(hooksFile);
        }
      }

      // Remove proxy URL if it points to panopticon
      if (
        typeof cfg.openai_base_url === "string" &&
        cfg.openai_base_url.includes("panopticon")
      ) {
        delete cfg.openai_base_url;
      }

      // Remove OTel config
      delete cfg.telemetry; // Legacy format
      const otel = cfg.otel as Record<string, unknown> | undefined;
      if (otel) {
        delete otel.log_user_prompt;
        delete otel.exporter;
        delete otel.trace_exporter;
        delete otel.metrics_exporter;
        if (Object.keys(otel).length === 0) delete cfg.otel;
      }

      // Remove MCP server
      const servers = cfg.mcp_servers as Record<string, unknown> | undefined;
      if (servers) {
        delete servers.panopticon;
        if (Object.keys(servers).length === 0) delete cfg.mcp_servers;
      }

      return cfg;
    },
  },

  shellEnv: {
    // Codex CLI reads its config from TOML, no shell env vars needed
    envVars() {
      return [];
    },
  },

  events: {
    // Codex uses snake_case but the hook handler already accepts both cases;
    // no mapping needed since ingest.ts normalizes at storage time
    eventMap: {},
    formatPermissionResponse({ allow, reason }) {
      // Codex uses the same format as Claude Code
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
    displayName: "Codex CLI",
    isInstalled: () => fs.existsSync(CODEX_DIR),
    isConfigured() {
      try {
        const content = fs.readFileSync(CODEX_HOOKS_JSON, "utf-8");
        return content.includes("panopticon");
      } catch {
        return false;
      }
    },
  },

  otel: {
    serviceName: "codex_cli_rs",
    metrics: {
      metricNames: ["codex.turn.token_usage"],
      aggregation: "SUM",
      tokenTypeAttrs: ["$.token_type"],
      modelAttrs: ["$.model"],
      tokenTypeMap: {
        cached_input: "cacheRead",
        reasoning_output: "output",
      },
      excludeTokenTypes: ["total"],
    },
    logFields: {
      eventTypeExprs: ["body", `json_extract(attributes, '$."event.name"')`],
      timestampMsExprs: [
        "CAST(timestamp_ns / 1000000 AS INTEGER)",
        `CAST(strftime('%s', json_extract(attributes, '$."event.timestamp"')) AS INTEGER) * 1000`,
      ],
    },
  },

  ident: {
    modelPatterns: [/^(gpt-|o[1-9]|chatgpt-)/],
  },

  proxy: {
    upstreamHost(headers) {
      // Codex auto-detect: ChatGPT OAuth (JWT) vs API key route to different upstreams
      const auth = headers.authorization ?? "";
      return auth.startsWith("Bearer eyJ") ? "chatgpt.com" : "api.openai.com";
    },
    rewritePath(requestPath, headers) {
      const auth = headers.authorization ?? "";
      const isChatGptOAuth = auth.startsWith("Bearer eyJ");
      return isChatGptOAuth
        ? `/backend-api/codex${requestPath}`
        : `/v1${requestPath}`;
    },
    accumulatorType: "openai",
  },

  scanner: {
    discover() {
      const sessionsDir = path.join(CODEX_DIR, "sessions");
      const files: { filePath: string }[] = [];
      const safeReaddir = (d: string) => {
        try {
          return fs.readdirSync(d);
        } catch {
          return [];
        }
      };
      for (const year of safeReaddir(sessionsDir)) {
        for (const month of safeReaddir(path.join(sessionsDir, year))) {
          for (const day of safeReaddir(path.join(sessionsDir, year, month))) {
            const dayDir = path.join(sessionsDir, year, month, day);
            for (const entry of safeReaddir(dayDir)) {
              if (entry.endsWith(".jsonl"))
                files.push({ filePath: path.join(dayDir, entry) });
            }
          }
        }
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
      let currentModel: string | undefined;
      let firstPrompt: string | undefined;

      for (const line of lines) {
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        const type = obj.type as string;
        const timestamp = obj.timestamp as string | undefined;
        const tsMs = timestamp ? new Date(timestamp).getTime() : Date.now();
        const payload = obj.payload as Record<string, unknown> | undefined;

        if (type === "session_meta" && payload) {
          meta = {
            sessionId: payload.id as string,
            cwd: payload.cwd as string | undefined,
            cliVersion: payload.cli_version as string | undefined,
            startedAtMs: payload.timestamp
              ? new Date(payload.timestamp as string).getTime()
              : tsMs,
          };
        }

        if (type === "turn_context" && payload) {
          currentModel = payload.model as string | undefined;
          if (meta && currentModel && !meta.model) meta.model = currentModel;
        }

        const sid = meta?.sessionId ?? "";

        if (type === "event_msg" && payload) {
          const eventType = payload.type as string;

          if (eventType === "user_message") {
            const message = payload.message as string | undefined;
            if (!firstPrompt && message) firstPrompt = message.slice(0, 200);
            turns.push({
              sessionId: sid,
              turnIndex: turnIndex++,
              timestampMs: tsMs,
              model: currentModel,
              role: "user",
              contentPreview: message?.slice(0, 200),
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              reasoningTokens: 0,
            });
          }

          if (eventType === "token_count") {
            const info = payload.info as Record<string, unknown> | null;
            if (!info) continue;
            const lastUsage = info.last_token_usage as
              | Record<string, unknown>
              | undefined;
            if (!lastUsage) continue;

            turns.push({
              sessionId: sid,
              turnIndex: turnIndex++,
              timestampMs: tsMs,
              model: currentModel,
              role: "assistant",
              inputTokens: (lastUsage.input_tokens as number) ?? 0,
              outputTokens: (lastUsage.output_tokens as number) ?? 0,
              cacheReadTokens: (lastUsage.cached_input_tokens as number) ?? 0,
              cacheCreationTokens: 0,
              reasoningTokens:
                (lastUsage.reasoning_output_tokens as number) ?? 0,
            });
          }

          if (eventType === "agent_message") {
            events.push({
              sessionId: sid,
              eventType: "agent_message",
              timestampMs: tsMs,
              content: (payload.message as string)?.slice(0, 500),
              metadata: { phase: payload.phase },
            });
          }
        }

        // Tool calls from response_item
        if (type === "response_item") {
          const p = obj.payload as Record<string, unknown> | undefined;
          const itemType = p?.type as string | undefined;

          if (itemType === "function_call") {
            events.push({
              sessionId: sid,
              eventType: "tool_call",
              timestampMs: tsMs,
              toolName: p?.name as string | undefined,
              toolInput:
                typeof p?.arguments === "string"
                  ? p.arguments.slice(0, 1000)
                  : JSON.stringify(p?.arguments)?.slice(0, 1000),
              metadata: { call_id: p?.call_id },
            });
          }

          if (itemType === "function_call_output") {
            events.push({
              sessionId: sid,
              eventType: "tool_result",
              timestampMs: tsMs,
              toolOutput:
                typeof p?.output === "string"
                  ? p.output.slice(0, 1000)
                  : undefined,
              metadata: { call_id: p?.call_id },
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

registerTarget(codex);
