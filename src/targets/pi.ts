/**
 * Pi coding agent target adapter.
 *
 * Panopticon observes Pi sessions via a TypeScript extension that emits
 * hook events over HTTP to the local panopticon server. The extension
 * is bundled separately and installed to ~/.pi/agent/extensions/.
 *
 * Install:
 *   panopticon install --target pi
 */

import fs from "node:fs";
import path from "node:path";
import { defaultToolCategory } from "../scanner/categories.js";
import { readNewLines } from "../scanner/reader.js";
import { piDir } from "./pi/paths.js";
import { registerTarget } from "./registry.js";
import type { ParsedToolCall, ParseResult, TargetAdapter } from "./types.js";

function extensionDest(): string {
  return path.join(piDir(), "agent", "extensions", "panopticon.js");
}

function sessionsDir(): string {
  return path.join(piDir(), "agent", "sessions");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function textFromContent(content: unknown): {
  text: string;
  hasThinking: boolean;
} {
  if (typeof content === "string") return { text: content, hasThinking: false };
  if (!Array.isArray(content)) return { text: "", hasThinking: false };
  const parts: string[] = [];
  let hasThinking = false;
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    if (b.type === "thinking") {
      hasThinking = true;
      if (typeof b.thinking === "string") {
        parts.push(`[Thinking]\n${b.thinking}\n[/Thinking]`);
      }
    }
  }
  return { text: parts.join("\n"), hasThinking };
}

function resultContentLength(content: unknown): number {
  return textFromContent(content).text.length;
}

function extractInjectedSkillName(text: string): string | undefined {
  const match = /<skill\s+[^>]*name=(['"])([^'"]+)\1/i.exec(text);
  return match?.[2];
}

function readNonNegativeNumber(
  record: Record<string, unknown> | undefined,
  keys: string[],
): number {
  if (!record) return 0;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return 0;
}

function readSessionHeader(filePath: string): ParseResult["meta"] | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const chunks: Buffer[] = [];
      const buffer = Buffer.alloc(1024);
      let total = 0;
      for (;;) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        if (Buffer.concat(chunks).includes(0x0a)) break;
      }
      const firstLine = Buffer.concat(chunks).toString("utf8").split("\n")[0];
      if (!firstLine) return undefined;
      const obj = JSON.parse(firstLine) as Record<string, unknown>;
      if (obj.type !== "session") return undefined;
      const sid =
        typeof obj.id === "string" ? obj.id : path.basename(filePath, ".jsonl");
      return {
        sessionId: sid,
        cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
        startedAtMs: timestampMs(obj.timestamp),
        parentSessionId:
          typeof obj.parentSession === "string" ? obj.parentSession : undefined,
        relationshipType:
          typeof obj.parentSession === "string" ? "fork" : undefined,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function piToolCategory(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower.includes("read")) return "Read";
  if (lower.includes("edit") || lower.includes("patch")) return "Edit";
  if (lower.includes("write") || lower.includes("create")) return "Write";
  if (lower.includes("bash") || lower.includes("shell")) return "Bash";
  if (lower.includes("grep") || lower.includes("search")) return "Grep";
  if (lower.includes("glob") || lower.includes("list")) return "Glob";
  if (lower.includes("web") || lower.includes("fetch")) return "Web";
  return defaultToolCategory(toolName);
}

/**
 * Read the bundled extension source produced by scripts/bundle-pi-extension.js.
 * The file lives at <pluginRoot>/dist/targets/pi/extension.js.
 *
 * We resolve it from `pluginRoot` (passed in at install time) rather than
 * `__dirname`, because tsup's ESM `__dirname` shim is exported from a shared
 * chunk — at runtime it resolves to the shim's own location (dist/), not to
 * wherever this file's code got hoisted. Using pluginRoot is deterministic.
 */
function getExtensionSource(pluginRoot: string): string | null {
  const extensionPath = path.join(
    pluginRoot,
    "dist",
    "targets",
    "pi",
    "extension.js",
  );
  try {
    return fs.readFileSync(extensionPath, "utf-8");
  } catch (err) {
    // Only swallow "not found" — re-raise EACCES/EISDIR/etc. so real I/O
    // problems surface instead of masquerading as "run pnpm build first".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const pi: TargetAdapter = {
  id: "pi",

  config: {
    get dir() {
      return piDir();
    },
    get configPath() {
      return path.join(piDir(), "agent", "settings.json");
    },
    configFormat: "json",
  },

  hooks: {
    events: [
      "session_start",
      "input",
      "turn_start",
      "turn_end",
      "tool_call",
      "tool_result",
      "session_before_compact",
      "session_compact",
      "model_select",
      "thinking_level_select",
      "user_bash",
      "session_shutdown",
    ],

    applyInstallConfig(existing, opts) {
      const extension = getExtensionSource(opts.pluginRoot);
      if (!extension) {
        throw new Error(
          `panopticon: Pi extension bundle not found at ${path.join(opts.pluginRoot, "dist", "targets", "pi", "extension.js")}. ` +
            "Run 'pnpm build' first.",
        );
      }

      // Copy the bundled extension into Pi's global extensions dir. Pi
      // auto-discovers files here — no settings.json entry is required
      // (see @mariozechner/pi-coding-agent loader.js).
      const dest = extensionDest();
      const extDir = path.dirname(dest);
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(dest, extension);

      return existing;
    },

    removeInstallConfig(existing) {
      const dest = extensionDest();
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      return existing;
    },
  },

  shellEnv: {
    // Emit the extension's connection vars unconditionally so that setup.ts's
    // .bashrc cleanup pass recognizes them as ours. Container deployments
    // override via subprocess env (e.g. docker-compose); shell rc edits
    // inside the panopticon block don't survive `panopticon install --force`.
    envVars(port) {
      return [
        ["PANOPTICON_HOST", "127.0.0.1"],
        ["PANOPTICON_PORT", String(port)],
      ];
    },
  },

  skills: {
    installDirs() {
      return [path.join(piDir(), "agent", "skills")];
    },
  },

  commands: {
    installDirs() {
      return [path.join(piDir(), "agent", "prompts")];
    },
  },

  events: {
    // Empty: the extension emits canonical event names directly
    // (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
    // PostToolUseFailure, SessionEnd). ingest.ts falls through when
    // eventMap lacks a key, so no translation is needed.
    eventMap: {},

    formatPermissionResponse(_eventName, { allow, reason }) {
      // Pi extensions cannot block tool calls — return structure is
      // informational only. Pi's philosophy is no permission popups.
      return { decision: allow ? "allow" : "deny", reason };
    },
  },

  detect: {
    displayName: "Pi",
    isInstalled: () => fs.existsSync(piDir()),

    isConfigured() {
      // Check if the extension file exists
      return fs.existsSync(extensionDest());
    },
  },

  // No proxy spec: Pi routes API calls through its own provider configuration
  // No otel spec: Pi doesn't emit OTel natively

  scanner: {
    normalizeToolCategory: piToolCategory,

    discover() {
      const root = sessionsDir();
      const files: { filePath: string }[] = [];
      const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(entryPath);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            files.push({ filePath: entryPath });
          }
        }
      };
      walk(root);
      return files;
    },

    parseFile(filePath: string, fromByteOffset: number): ParseResult | null {
      const { lines, newByteOffset } = readNewLines(filePath, fromByteOffset);
      if (lines.length === 0) return null;

      let meta: ParseResult["meta"] =
        fromByteOffset > 0 ? readSessionHeader(filePath) : undefined;
      const turns: ParseResult["turns"] = [];
      const events: ParseResult["events"] = [];
      const messages: ParseResult["messages"] = [];
      const orphanedToolResults = new Map<
        string,
        { contentLength: number; contentRaw: string; timestampMs?: number }
      >();
      // Match the Claude/Codex scanner contract: parsers emit chunk-relative
      // indices and scanner/loop.ts reindexes incrementals from DB state.
      let ordinal = 0;
      let turnIndex = 0;
      let firstPrompt: string | undefined;

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(lines[lineIndex]);
        } catch {
          continue;
        }

        if (obj.type === "session") {
          const sid =
            typeof obj.id === "string"
              ? obj.id
              : path.basename(filePath, ".jsonl");
          meta = {
            sessionId: sid,
            cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
            startedAtMs: timestampMs(obj.timestamp),
            parentSessionId:
              typeof obj.parentSession === "string"
                ? obj.parentSession
                : undefined,
            relationshipType:
              typeof obj.parentSession === "string" ? "fork" : undefined,
          };
          continue;
        }

        const msg = asRecord(obj.message);
        if (obj.type !== "message" || !msg) continue;
        const sid = meta?.sessionId ?? path.basename(filePath, ".jsonl");
        const role = msg.role;
        const tsMs =
          timestampMs(msg.timestamp) ??
          timestampMs(obj.timestamp) ??
          meta?.startedAtMs ??
          lineIndex;
        const uuid = typeof obj.id === "string" ? obj.id : undefined;
        const parentUuid =
          typeof obj.parentId === "string" ? obj.parentId : undefined;

        if (role === "user") {
          const { text } = textFromContent(msg.content);
          const skillName = extractInjectedSkillName(text);
          const toolCalls: ParsedToolCall[] = skillName
            ? [
                {
                  toolUseId: `${sid}:${ordinal}:skill:${skillName}`,
                  toolName: "Skill",
                  category: "Tool",
                  inputJson: JSON.stringify({ skill: skillName }),
                  skillName,
                  timestampMs: tsMs,
                },
              ]
            : [];
          if (!firstPrompt && text) firstPrompt = text.slice(0, 200);
          if (text.length > 0) {
            messages.push({
              sessionId: sid,
              ordinal: ordinal++,
              role: "user",
              content: text,
              timestampMs: tsMs,
              hasThinking: false,
              hasToolUse: toolCalls.length > 0,
              isSystem: false,
              contentLength: text.length,
              hasContextTokens: false,
              hasOutputTokens: false,
              uuid,
              parentUuid,
              toolCalls,
              toolResults: new Map(),
            });
          }
          turns.push({
            sessionId: sid,
            turnIndex: turnIndex++,
            timestampMs: tsMs,
            role: "user",
            contentPreview: text.slice(0, 200),
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
          });
        } else if (role === "assistant") {
          const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
          const { text, hasThinking } = textFromContent(msg.content);
          const toolCalls: ParsedToolCall[] = [];
          for (const block of contentBlocks) {
            const b = asRecord(block);
            if (!b || b.type !== "toolCall") continue;
            const toolName = typeof b.name === "string" ? b.name : "";
            const inputJson = b.arguments
              ? JSON.stringify(b.arguments)
              : undefined;
            const toolUseId =
              typeof b.id === "string"
                ? b.id
                : `${sid}:${ordinal}:${toolCalls.length}`;
            toolCalls.push({
              toolUseId,
              toolName,
              category: piToolCategory(toolName),
              inputJson,
              timestampMs: tsMs,
            });
            events.push({
              sessionId: sid,
              eventType: "tool_call",
              timestampMs: tsMs,
              eventIndex: lineIndex,
              toolName,
              toolInput: inputJson,
              metadata: { tool_call_id: toolUseId },
            });
          }
          const usage = asRecord(msg.usage);
          const inputTokens = readNonNegativeNumber(usage, [
            "input",
            "input_tokens",
          ]);
          const outputTokens = readNonNegativeNumber(usage, [
            "output",
            "output_tokens",
          ]);
          const cacheReadTokens = readNonNegativeNumber(usage, [
            "cacheRead",
            "cache_read_input_tokens",
          ]);
          const cacheCreationTokens = readNonNegativeNumber(usage, [
            "cacheWrite",
            "cache_creation_input_tokens",
          ]);
          const contextTokens =
            inputTokens + cacheReadTokens + cacheCreationTokens;
          const model = typeof msg.model === "string" ? msg.model : undefined;
          if (meta && model && !meta.model) meta.model = model;
          messages.push({
            sessionId: sid,
            ordinal: ordinal++,
            role: "assistant",
            content: text,
            timestampMs: tsMs,
            hasThinking,
            hasToolUse: toolCalls.length > 0,
            isSystem: false,
            contentLength: text.length,
            model,
            tokenUsage: usage ? JSON.stringify(usage) : undefined,
            contextTokens: contextTokens > 0 ? contextTokens : undefined,
            outputTokens: outputTokens > 0 ? outputTokens : undefined,
            hasContextTokens: contextTokens > 0,
            hasOutputTokens: outputTokens > 0,
            uuid,
            parentUuid,
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
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            reasoningTokens: 0,
          });
        } else if (role === "toolResult") {
          const toolCallId =
            typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
          const { text } = textFromContent(msg.content);
          if (toolCallId) {
            orphanedToolResults.set(toolCallId, {
              contentLength: resultContentLength(msg.content),
              contentRaw: text,
              timestampMs: tsMs,
            });
          }
          events.push({
            sessionId: sid,
            eventType: "tool_result",
            timestampMs: tsMs,
            eventIndex: lineIndex,
            toolName:
              typeof msg.toolName === "string" ? msg.toolName : undefined,
            toolOutput: text,
            metadata: {
              tool_call_id: toolCallId,
              is_error: msg.isError === true,
            },
          });
        }
      }

      if (meta && firstPrompt && !meta.firstPrompt)
        meta.firstPrompt = firstPrompt;
      if (
        !meta &&
        turns.length === 0 &&
        events.length === 0 &&
        messages.length === 0
      )
        return null;

      return {
        meta,
        turns,
        events,
        messages,
        newByteOffset,
        orphanedToolResults:
          orphanedToolResults.size > 0 ? orphanedToolResults : undefined,
      };
    },
  },

  // No ident spec: Pi doesn't emit model names in events we capture
};

registerTarget(pi);
