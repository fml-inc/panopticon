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

// ── System message detection & command envelope handling ────────────────────

/** Patterns for system-injected user messages that should be marked isSystem. */
const SYSTEM_MESSAGE_PREFIXES = [
  "This session is being continued",
  "[Request interrupted",
  "<task-notification>",
  "<local-command-",
  "Stop hook feedback:",
];

/** Check if content matches a known system-injected pattern. */
function isSystemMessage(content: string): boolean {
  const trimmed = content.trimStart();
  return SYSTEM_MESSAGE_PREFIXES.some((p) => trimmed.startsWith(p));
}

const CMD_NAME_RE = /<command-name>([^<]+)<\/command-name>/;
const CMD_ARGS_RE = /<command-args>([^<]*)<\/command-args>/;
const CMD_MSG_RE = /<command-message>([^<]+)<\/command-message>/;
const CMD_STRIP_RE =
  /<\/?(?:command-name|command-message|command-args)>[^<]*<\/(?:command-name|command-message|command-args)>|<\/?(?:command-name|command-message|command-args)>/g;

/**
 * Detect command/skill XML envelopes and convert to readable form.
 * Returns [convertedText, true] if it was a command envelope,
 * or [originalText, false] if not.
 */
function extractCommandText(content: string): [string, boolean] {
  // Strip BOM and leading whitespace for matching
  const trimmed = content.replace(/^\uFEFF/, "").trimStart();
  if (
    !trimmed.startsWith("<command-message>") &&
    !trimmed.startsWith("<command-name>")
  ) {
    return [content, false];
  }
  // Verify it's purely command XML (no trailing prose)
  const stripped = trimmed.replace(CMD_STRIP_RE, "");
  if (stripped.trim() !== "") {
    return [content, false];
  }

  const nameMatch = CMD_NAME_RE.exec(content);
  if (!nameMatch) {
    // Bare <command-message> without <command-name>
    const msgMatch = CMD_MSG_RE.exec(content);
    if (msgMatch) return [`/${msgMatch[1]}`, true];
    return [content, false];
  }

  let name = nameMatch[1];
  if (!name.startsWith("/")) name = `/${name}`;
  const argsMatch = CMD_ARGS_RE.exec(content);
  const args = argsMatch?.[1]?.trim();
  return [args ? `${name} ${args}` : name, true];
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

// ── DAG fork detection ─────────────────────────────────────────────────────
// Adapted from agentsview's parseDAG/walkBranch (internal/parser/claude.go).
// Detects uuid/parentUuid branching in JSONL files and separates large-gap
// forks (>FORK_THRESHOLD user turns on first child) into separate sessions.

interface DagEntry {
  uuid: string;
  parentUuid: string;
  type: "user" | "assistant";
  lineIndex: number;
  timestampMs: number;
}

const FORK_THRESHOLD = 3;

/** True if entries don't form a simple linear chain. */
function hasDAGFork(entries: DagEntry[]): boolean {
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].parentUuid !== entries[i - 1].uuid) return true;
  }
  return false;
}

interface ForkBranch {
  parentId: string;
  dagIndices: number[];
}

/**
 * Walk the DAG from root, detecting large-gap forks.
 * Returns which dag entry indices belong to the main path vs fork branches.
 */
function detectForks(
  entries: DagEntry[],
  sessionId: string,
): { mainDagIndices: number[]; forkBranches: ForkBranch[] } {
  const children = new Map<string, number[]>();
  const roots: number[] = [];
  const uuidSet = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    uuidSet.add(e.uuid);
    if (!e.parentUuid) {
      roots.push(i);
    } else {
      const kids = children.get(e.parentUuid) ?? [];
      kids.push(i);
      children.set(e.parentUuid, kids);
    }
  }

  // Need exactly one root; all parentUuids must reference known uuids
  if (roots.length !== 1) {
    return { mainDagIndices: entries.map((_, i) => i), forkBranches: [] };
  }
  for (const e of entries) {
    if (e.parentUuid && !uuidSet.has(e.parentUuid)) {
      return { mainDagIndices: entries.map((_, i) => i), forkBranches: [] };
    }
  }

  const forkBranches: ForkBranch[] = [];

  /** Count ALL user entries reachable from startIdx (full subtree DFS). */
  function countUserTurns(startIdx: number): number {
    const stack = [startIdx];
    let count = 0;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (entries[idx].type === "user") count++;
      for (const k of children.get(entries[idx].uuid) ?? []) stack.push(k);
    }
    return count;
  }

  function walkBranch(startIdx: number, ownerId: string): number[] {
    const pathIndices: number[] = [];
    let current: number | null = startIdx;

    while (current !== null) {
      pathIndices.push(current);
      const kids: number[] = children.get(entries[current].uuid) ?? [];

      if (kids.length === 0) {
        current = null;
      } else if (kids.length === 1) {
        current = kids[0];
      } else {
        // Fork point — check first child's subtree user turn count
        const firstChildTurns = countUserTurns(kids[0]);
        if (firstChildTurns <= FORK_THRESHOLD) {
          // Small-gap retry: follow latest child (last), skip earlier
          current = kids[kids.length - 1];
        } else {
          // Large-gap fork: follow first child on main path,
          // collect other children as separate fork branches
          for (let k = 1; k < kids.length; k++) {
            const branchIndices = walkBranch(kids[k], ownerId);
            forkBranches.push({
              parentId: ownerId,
              dagIndices: branchIndices,
            });
          }
          current = kids[0];
        }
      }
    }
    return pathIndices;
  }

  const mainDagIndices = walkBranch(roots[0], sessionId);
  return { mainDagIndices, forkBranches };
}

/** Claude Code session files use standard UUIDs as filenames. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

      // For continuation detection: extract UUID from file path
      // File pattern: ~/.claude/projects/{slug}/{uuid}.jsonl
      const fileUuid = path.basename(filePath, ".jsonl");
      const isSubagentPath = filePath.includes("/subagents/");

      let meta: ParseResult["meta"];
      const turns: ParseResult["turns"] = [];
      const events: ParseResult["events"] = [];
      const messages: ParseResult["messages"] = [];
      let turnIndex = 0;
      let ordinal = 0;
      let firstPrompt: string | undefined;
      // Map tool_use_id → subagent session ID (e.g. "agent-abc123")
      const subagentMap = new Map<string, string>();
      // Tool results from filtered-out messages (tool-result-only user entries)
      const orphanedToolResults = new Map<
        string,
        { contentLength: number; contentRaw: string }
      >();

      // DAG tracking: collect uuid/parentUuid entries and map them to
      // message/turn indices for fork partitioning
      const dagEntries: DagEntry[] = [];
      // Per-message and per-turn: which line index produced it (-1 = no DAG)
      const msgLineIdx: number[] = [];
      const turnLineIdx: number[] = [];

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        const type = obj.type as string;
        const sessionId = obj.sessionId as string | undefined;
        const agentId = obj.agentId as string | undefined;
        const tsMs = obj.timestamp
          ? new Date(obj.timestamp as string).getTime()
          : Date.now();

        // Track uuid/parentUuid for DAG fork detection
        const uuid = obj.uuid as string | undefined;
        const parentUuid = obj.parentUuid as string | undefined;
        if (uuid && (type === "user" || type === "assistant")) {
          dagEntries.push({
            uuid,
            parentUuid: parentUuid ?? "",
            type,
            lineIndex: lineIdx,
            timestampMs: tsMs,
          });
        }

        if (!meta && sessionId) {
          const common = {
            cliVersion: obj.version as string | undefined,
            cwd: obj.cwd as string | undefined,
            startedAtMs: tsMs,
          };
          if (agentId) {
            // Subagent files have agentId set and sessionId is the parent's ID.
            // Use "agent-{agentId}" as the session ID (matches file naming).
            meta = {
              sessionId: `agent-${agentId}`,
              parentSessionId: sessionId,
              relationshipType: "subagent",
              ...common,
            };
          } else if (
            !isSubagentPath &&
            UUID_RE.test(fileUuid) &&
            sessionId !== fileUuid
          ) {
            // Continuation: file UUID differs from JSONL sessionId.
            // This file continues the original session under a new file
            // (e.g. claude --continue / --resume).
            meta = {
              sessionId: fileUuid,
              parentSessionId: sessionId,
              relationshipType: "continuation",
              ...common,
            };
          } else {
            meta = { sessionId, ...common };
          }
        }

        const sid = meta?.sessionId ?? sessionId ?? "";

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
                const textLen = extractToolResultTextLength(b.content);
                // Store raw content as-is: string stays string, arrays/objects get serialized
                const raw =
                  typeof b.content === "string"
                    ? b.content
                    : JSON.stringify(b.content ?? "");
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

          let fullContent = textParts.join("\n");

          // Skip meta/compact messages
          const isMeta = obj.isMeta === true;
          const isCompact = obj.isCompactSummary === true;
          if (isMeta || isCompact) {
            // still push turn below, but skip message
          } else if (fullContent.length === 0 && toolResults.size > 0) {
            // Tool-result-only user message (no text content).
            // Don't create a message — collect results for backfill.
            for (const [id, result] of toolResults) {
              orphanedToolResults.set(id, result);
            }
          } else if (fullContent.length > 0) {
            // Convert command envelopes to readable form
            const [converted, wasCommand] = extractCommandText(fullContent);
            if (wasCommand) {
              fullContent = converted;
            }

            // Detect system-injected messages
            const isSystem = isSystemMessage(fullContent);

            messages.push({
              sessionId: sid,
              ordinal: ordinal++,
              role: "user",
              content: fullContent,
              timestampMs: tsMs,
              hasThinking: false,
              hasToolUse: false,
              isSystem,
              contentLength: fullContent.length,
              hasContextTokens: false,
              hasOutputTokens: false,
              toolCalls: [],
              toolResults,
            });
            msgLineIdx.push(lineIdx);
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
          turnLineIdx.push(lineIdx);
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
          msgLineIdx.push(lineIdx);

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
          turnLineIdx.push(lineIdx);
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

      // DAG fork detection on incremental reads: if new lines contain a fork,
      // signal the caller to reset the watermark and reparse from byte 0.
      if (
        fromByteOffset > 0 &&
        dagEntries.length > 1 &&
        hasDAGFork(dagEntries)
      ) {
        return {
          meta,
          turns: [],
          events: [],
          messages: [],
          newByteOffset: fromByteOffset, // don't advance watermark
          needsFullReparse: true,
        };
      }

      // DAG fork detection on full file reads
      if (
        fromByteOffset === 0 &&
        meta &&
        dagEntries.length > 1 &&
        hasDAGFork(dagEntries)
      ) {
        const { mainDagIndices, forkBranches } = detectForks(
          dagEntries,
          meta.sessionId,
        );

        if (forkBranches.length > 0) {
          // Build line index sets for main path and each fork branch
          const mainLineSet = new Set(
            mainDagIndices.map((i) => dagEntries[i].lineIndex),
          );

          // Partition messages and turns by line index membership
          const mainMessages = messages.filter((_, i) =>
            mainLineSet.has(msgLineIdx[i]),
          );
          const mainTurns = turns.filter((_, i) =>
            mainLineSet.has(turnLineIdx[i]),
          );

          // Re-index ordinals and turn indices for main path
          for (let i = 0; i < mainMessages.length; i++) {
            mainMessages[i] = { ...mainMessages[i], ordinal: i };
          }
          for (let i = 0; i < mainTurns.length; i++) {
            mainTurns[i] = { ...mainTurns[i], turnIndex: i };
          }

          // Build fork ParseResults
          const forks: ParseResult[] = [];
          for (const branch of forkBranches) {
            const branchLineSet = new Set(
              branch.dagIndices.map((i) => dagEntries[i].lineIndex),
            );
            const forkUuid = dagEntries[branch.dagIndices[0]].uuid;
            const forkSessionId = `${meta.sessionId}-${forkUuid}`;
            const forkStartMs = dagEntries[branch.dagIndices[0]].timestampMs;

            const forkMessages = messages
              .filter((_, i) => branchLineSet.has(msgLineIdx[i]))
              .map((m, i) => ({
                ...m,
                sessionId: forkSessionId,
                ordinal: i,
              }));
            const forkTurns = turns
              .filter((_, i) => branchLineSet.has(turnLineIdx[i]))
              .map((t, i) => ({
                ...t,
                sessionId: forkSessionId,
                turnIndex: i,
              }));

            forks.push({
              meta: {
                sessionId: forkSessionId,
                parentSessionId: branch.parentId,
                relationshipType: "fork",
                model: meta.model,
                cwd: meta.cwd,
                cliVersion: meta.cliVersion,
                startedAtMs: forkStartMs,
              },
              turns: forkTurns,
              events: [], // events stay in main result
              messages: forkMessages,
              newByteOffset,
            });
          }

          return {
            meta,
            turns: mainTurns,
            events, // all events stay in main
            messages: mainMessages,
            newByteOffset,
            forks,
            orphanedToolResults:
              orphanedToolResults.size > 0 ? orphanedToolResults : undefined,
          };
        }
      }

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
};

registerTarget(claude);
