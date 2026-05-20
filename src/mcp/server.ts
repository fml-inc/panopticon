#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log, openLogFd } from "../log.js";
import { readScannerStatus } from "../scanner/status.js";
import { httpPanopticonService } from "../service/http.js";
import {
  categorySchema,
  permissionsApply,
  permissionsPreview,
  permissionsShow,
} from "./permissions.js";

const service = httpPanopticonService;

const server = new McpServer({
  name: "panopticon",
  version: "0.1.0",
});

const MCP_TEXT_FIELD_MAX_CHARS = 360;
const MCP_PROMPT_MAX_CHARS = 240;
const MCP_ACTIVITY_SESSION_LIMIT = 20;
const MCP_ACTIVITY_PROMPT_LIMIT = 5;
const MCP_ACTIVITY_TOOL_LIMIT = 10;
const MCP_ACTIVITY_FILE_LIMIT = 12;
const MCP_INTENT_PROMPT_MAX_CHARS = 600;
const MCP_INTENT_FILE_LIMIT = 12;
const MCP_OUTCOME_FILE_LIMIT = 25;
const MCP_TIMELINE_CONTENT_MAX_CHARS = 360;
const MCP_TIMELINE_JSON_MAX_CHARS = 260;
const MCP_DETAIL_INTENT_LIMIT = 20;
const MCP_DETAIL_FILE_LIMIT = 20;

type JsonRecord = Record<string, unknown>;

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(record: JsonRecord | null, ...names: string[]): unknown {
  if (!record) return null;
  for (const name of names) {
    if (Object.hasOwn(record, name)) return record[name];
  }
  return null;
}

function compactText(value: unknown, maxChars = MCP_TEXT_FIELD_MAX_CHARS) {
  if (typeof value !== "string") return value ?? null;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 24).trimEnd()}... [truncated]`;
}

function compactTextArray(
  value: unknown,
  limit: number,
  maxChars: number,
): unknown[] {
  return asArray(value)
    .slice(0, limit)
    .map((item) => compactText(item, maxChars));
}

function compactTopFiles(value: unknown): unknown[] {
  return asArray(value)
    .slice(0, 3)
    .map((item) => {
      const file = asRecord(item);
      if (!file) return item;
      return {
        file_path: field(file, "file_path"),
        edit_count: field(file, "edit_count"),
        landed_count: field(file, "landed_count"),
        current_edit_count: field(file, "current_edit_count"),
      };
    });
}

function compactSessionSummary(value: unknown) {
  const row = asRecord(value);
  const preview = asRecord(field(row, "preview"));
  const counts = asRecord(field(preview, "counts"));
  const enrichment = asRecord(field(row, "enrichment"));
  const summary =
    field(preview, "summary") ??
    field(enrichment, "summaryText") ??
    field(row, "enriched_summary_text", "summaryText", "summary_text");

  return {
    session_id:
      field(row, "session_id", "sessionId") ?? field(preview, "session_id"),
    target: field(row, "target") ?? field(preview, "target"),
    title: field(row, "title") ?? field(preview, "title"),
    status: field(row, "status") ?? field(preview, "status"),
    repository: field(row, "repository") ?? field(preview, "repository"),
    cwd: field(row, "cwd") ?? field(preview, "cwd"),
    branch: field(row, "branch") ?? field(preview, "branch"),
    last_activity_ms:
      field(preview, "last_activity_ms") ??
      field(row, "last_intent_ts_ms", "lastIntentAt", "sourceLastSeenAt"),
    counts: counts
      ? {
          intents: field(counts, "intents"),
          edits: field(counts, "edits"),
          landed_edits: field(counts, "landed_edits"),
          open_edits: field(counts, "open_edits"),
        }
      : {
          intents: field(row, "intent_count", "intentCount"),
          edits: field(row, "edit_count", "editCount"),
          landed_edits: field(row, "landed_edit_count", "landedEditCount"),
          open_edits: field(row, "open_edit_count", "openEditCount"),
        },
    summary: compactText(summary),
    summary_source:
      field(preview, "summary_source") ??
      field(enrichment, "source") ??
      field(row, "summary_source", "summarySource"),
    summary_stale:
      field(preview, "summary_stale") ??
      field(enrichment, "stale") ??
      field(row, "enrichment_stale"),
    top_files: compactTopFiles(
      field(preview, "top_files") ?? field(row, "topFiles"),
    ),
  };
}

function compactSession(value: unknown) {
  const row = asRecord(value);
  return {
    sessionId: field(row, "sessionId"),
    target: field(row, "target"),
    model: field(row, "model"),
    project: field(row, "project"),
    startedAt: field(row, "startedAt"),
    endedAt: field(row, "endedAt"),
    firstPrompt: compactText(field(row, "firstPrompt"), MCP_PROMPT_MAX_CHARS),
    turnCount: field(row, "turnCount"),
    messageCount: field(row, "messageCount"),
    totalInputTokens: field(row, "totalInputTokens"),
    totalOutputTokens: field(row, "totalOutputTokens"),
    totalCost: field(row, "totalCost"),
    repositories: field(row, "repositories"),
    parentSessionId: field(row, "parentSessionId"),
    relationshipType: field(row, "relationshipType"),
    summary: compactText(field(row, "summary")),
    sessionSummary: field(row, "sessionSummary")
      ? compactSessionSummary(field(row, "sessionSummary"))
      : null,
  };
}

function compactSessionListResult(value: unknown) {
  const result = asRecord(value);
  return {
    sessions: asArray(field(result, "sessions")).map(compactSession),
    totalCount: field(result, "totalCount"),
    source: field(result, "source"),
  };
}

function compactActivitySummary(value: unknown) {
  const result = asRecord(value);
  const sessions = asArray(field(result, "sessions"));
  return {
    period: field(result, "period"),
    totalSessions: field(result, "totalSessions"),
    totalTokens: field(result, "totalTokens"),
    totalCost: field(result, "totalCost"),
    topTools: field(result, "topTools"),
    sessionsReturned: Math.min(sessions.length, MCP_ACTIVITY_SESSION_LIMIT),
    sessions: sessions.slice(0, MCP_ACTIVITY_SESSION_LIMIT).map((item) => {
      const row = asRecord(item);
      return {
        sessionId: field(row, "sessionId"),
        startedAt: field(row, "startedAt"),
        durationMinutes: field(row, "durationMinutes"),
        model: field(row, "model"),
        project: field(row, "project"),
        repositories: field(row, "repositories"),
        userPrompts: compactTextArray(
          field(row, "userPrompts"),
          MCP_ACTIVITY_PROMPT_LIMIT,
          MCP_PROMPT_MAX_CHARS,
        ),
        toolsUsed: asArray(field(row, "toolsUsed")).slice(
          0,
          MCP_ACTIVITY_TOOL_LIMIT,
        ),
        filesModified: compactTextArray(
          field(row, "filesModified"),
          MCP_ACTIVITY_FILE_LIMIT,
          MCP_PROMPT_MAX_CHARS,
        ),
        totalCost: field(row, "totalCost"),
      };
    }),
    source: field(result, "source"),
  };
}

function compactTimelineToolCall(value: unknown) {
  const call = asRecord(value);
  if (!call) return value;
  return {
    toolName: field(call, "toolName", "tool_name"),
    category: field(call, "category"),
    toolUseId: field(call, "toolUseId", "tool_use_id"),
    durationMs: field(call, "durationMs", "duration_ms"),
    resultContentLength: field(
      call,
      "resultContentLength",
      "result_content_length",
    ),
    inputJson: compactText(
      field(call, "inputJson", "input_json"),
      MCP_TIMELINE_JSON_MAX_CHARS,
    ),
    resultContent: compactText(
      field(call, "resultContent", "result_content"),
      MCP_TIMELINE_JSON_MAX_CHARS,
    ),
    subagentSessionId: field(call, "subagentSessionId", "subagent_session_id"),
  };
}

function compactTimelineMessage(value: unknown) {
  const message = asRecord(value);
  if (!message) return value;
  return {
    id: field(message, "id"),
    ordinal: field(message, "ordinal"),
    role: field(message, "role"),
    timestampMs: field(message, "timestampMs", "timestamp_ms"),
    model: field(message, "model"),
    content: compactText(
      field(message, "content"),
      MCP_TIMELINE_CONTENT_MAX_CHARS,
    ),
    contentLength: field(message, "contentLength", "content_length"),
    isSystem: field(message, "isSystem", "is_system"),
    hasThinking: field(message, "hasThinking", "has_thinking"),
    hasToolUse: field(message, "hasToolUse", "has_tool_use"),
    contextTokens: field(message, "contextTokens", "context_tokens"),
    outputTokens: field(message, "outputTokens", "output_tokens"),
    uuid: field(message, "uuid"),
    parentUuid: field(message, "parentUuid", "parent_uuid"),
    toolCalls: asArray(field(message, "toolCalls", "tool_calls")).map(
      compactTimelineToolCall,
    ),
  };
}

function compactTimelineSession(value: unknown) {
  const session = asRecord(value);
  if (!session) return value;
  return {
    sessionId: field(session, "sessionId", "session_id"),
    target: field(session, "target"),
    model: field(session, "model"),
    project: field(session, "project"),
    parentSessionId: field(session, "parentSessionId", "parent_session_id"),
    relationshipType: field(session, "relationshipType", "relationship_type"),
    repositories: asArray(field(session, "repositories")).map((repo) => {
      const row = asRecord(repo);
      if (!row) return repo;
      return {
        name: field(row, "name", "repository"),
        branch: field(row, "branch"),
      };
    }),
    childSessions: asArray(field(session, "childSessions")).map((child) => {
      const row = asRecord(child);
      if (!row) return child;
      return {
        sessionId: field(row, "sessionId", "session_id"),
        relationshipType: field(row, "relationshipType", "relationship_type"),
        model: field(row, "model"),
        turnCount: field(row, "turnCount", "turn_count"),
        firstPrompt: compactText(
          field(row, "firstPrompt", "first_prompt"),
          MCP_PROMPT_MAX_CHARS,
        ),
        startedAtMs: field(row, "startedAtMs", "started_at_ms"),
      };
    }),
  };
}

function compactTimelineResult(value: unknown) {
  const result = asRecord(value);
  return {
    session: compactTimelineSession(field(result, "session")),
    messages: asArray(field(result, "messages")).map(compactTimelineMessage),
    totalMessages: field(result, "totalMessages", "total_messages"),
    hasMore: field(result, "hasMore", "has_more"),
    source: field(result, "source"),
  };
}

function compactIntentFile(value: unknown) {
  const file = asRecord(value);
  if (!file) return value;
  return {
    file_path: field(file, "file_path", "filePath"),
    landed: field(file, "landed"),
    landed_reason: compactText(field(file, "landed_reason", "reason"), 160),
    tool_name: field(file, "tool_name", "toolName"),
    intent_edit_id: field(file, "intent_edit_id", "intentEditId"),
  };
}

function compactIntentFiles(value: unknown, limit: number) {
  const files = asArray(value);
  return {
    total: files.length,
    returned: Math.min(files.length, limit),
    omitted: Math.max(0, files.length - limit),
    items: files.slice(0, limit).map(compactIntentFile),
  };
}

function compactSearchIntentRow(value: unknown) {
  const row = asRecord(value);
  return {
    intent_unit_id: field(row, "intent_unit_id", "intentUnitId"),
    prompt_text: compactText(
      field(row, "prompt_text", "promptText"),
      MCP_INTENT_PROMPT_MAX_CHARS,
    ),
    prompt_ts_ms: field(row, "prompt_ts_ms", "promptTsMs"),
    session_id: field(row, "session_id", "sessionId"),
    repository: field(row, "repository"),
    edit_count: field(row, "edit_count", "editCount"),
    landed_count: field(row, "landed_count", "landedCount"),
    landed_ratio: field(row, "landed_ratio", "landedRatio"),
    files: compactIntentFiles(field(row, "files"), MCP_INTENT_FILE_LIMIT),
  };
}

function compactIntentForCodeRow(value: unknown) {
  const row = asRecord(value);
  const edit = asRecord(field(row, "edit"));
  return {
    intent_unit_id: field(row, "intent_unit_id", "intentUnitId"),
    prompt_text: compactText(
      field(row, "prompt_text", "promptText"),
      MCP_INTENT_PROMPT_MAX_CHARS,
    ),
    prompt_ts_ms: field(row, "prompt_ts_ms", "promptTsMs"),
    session_id: field(row, "session_id", "sessionId"),
    repository: field(row, "repository"),
    status: field(row, "status"),
    edit: edit
      ? {
          intent_edit_id: field(edit, "intent_edit_id", "intentEditId"),
          edit_count: field(edit, "edit_count", "editCount"),
          current_edit_count: field(
            edit,
            "current_edit_count",
            "currentEditCount",
          ),
          superseded_edit_count: field(
            edit,
            "superseded_edit_count",
            "supersededEditCount",
          ),
          reverted_edit_count: field(
            edit,
            "reverted_edit_count",
            "revertedEditCount",
          ),
          unknown_edit_count: field(
            edit,
            "unknown_edit_count",
            "unknownEditCount",
          ),
          tool_name: field(edit, "tool_name", "toolName"),
          timestamp_ms: field(edit, "timestamp_ms", "timestampMs"),
          landed: field(edit, "landed"),
          landed_reason: compactText(field(edit, "landed_reason"), 160),
          new_string_snippet: compactText(
            field(edit, "new_string_snippet", "newStringSnippet"),
          ),
        }
      : null,
  };
}

function compactOutcomesForIntent(value: unknown) {
  const row = asRecord(value);
  if (!row) return value;
  const t0 = asRecord(field(row, "t0_session_end", "t0SessionEnd"));
  const survived = asArray(field(t0, "edits_survived", "editsSurvived"));
  const churned = asArray(field(t0, "edits_churned", "editsChurned"));
  const unknown = asArray(field(t0, "edits_unknown", "editsUnknown"));
  return {
    intent_unit_id: field(row, "intent_unit_id", "intentUnitId"),
    prompt_text: compactText(
      field(row, "prompt_text", "promptText"),
      MCP_INTENT_PROMPT_MAX_CHARS,
    ),
    session_id: field(row, "session_id", "sessionId"),
    prompt_ts_ms: field(row, "prompt_ts_ms", "promptTsMs"),
    next_prompt_ts_ms: field(row, "next_prompt_ts_ms", "nextPromptTsMs"),
    reconciled_at_ms: field(row, "reconciled_at_ms", "reconciledAtMs"),
    edit_count: field(row, "edit_count", "editCount"),
    landed_count: field(row, "landed_count", "landedCount"),
    t0_session_end: {
      edits_survived: compactIntentFiles(survived, MCP_OUTCOME_FILE_LIMIT),
      edits_churned: compactIntentFiles(churned, MCP_OUTCOME_FILE_LIMIT),
      edits_unknown: compactIntentFiles(unknown, MCP_OUTCOME_FILE_LIMIT),
    },
  };
}

function compactSessionSummaryIntent(value: unknown) {
  const row = asRecord(value);
  if (!row) return value;
  return {
    intent_unit_id: field(row, "intent_unit_id", "intentUnitId"),
    prompt_text: compactText(
      field(row, "prompt_text", "promptText"),
      MCP_INTENT_PROMPT_MAX_CHARS,
    ),
    prompt_ts_ms: field(row, "prompt_ts_ms", "promptTsMs"),
    session_id: field(row, "session_id", "sessionId"),
    membership_kind: field(row, "membership_kind", "membershipKind"),
    score: field(row, "score"),
  };
}

function compactSessionSummaryFile(value: unknown) {
  const row = asRecord(value);
  if (!row) return value;
  return {
    file_path: field(row, "file_path", "filePath"),
    edit_count: field(row, "edit_count", "editCount"),
    landed_count: field(row, "landed_count", "landedCount"),
    current_edit_count: field(row, "current_edit_count", "currentEditCount"),
    superseded_edit_count: field(
      row,
      "superseded_edit_count",
      "supersededEditCount",
    ),
    reverted_edit_count: field(row, "reverted_edit_count", "revertedEditCount"),
    unknown_edit_count: field(row, "unknown_edit_count", "unknownEditCount"),
    intent_count: field(row, "intent_count", "intentCount"),
    last_touched_ms: field(row, "last_touched_ms", "lastTouchedMs"),
  };
}

function compactSessionSummaryDetail(value: unknown) {
  const row = asRecord(value);
  if (!row) return value;
  const intents = asArray(field(row, "intents"));
  const files = asArray(field(row, "files"));
  return {
    session_summary: compactSessionSummary(field(row, "session_summary")),
    preview: field(row, "preview")
      ? compactSessionSummary({ preview: field(row, "preview") })
      : null,
    intents: {
      total: intents.length,
      returned: Math.min(intents.length, MCP_DETAIL_INTENT_LIMIT),
      omitted: Math.max(0, intents.length - MCP_DETAIL_INTENT_LIMIT),
      items: intents
        .slice(0, MCP_DETAIL_INTENT_LIMIT)
        .map(compactSessionSummaryIntent),
    },
    files: {
      total: files.length,
      returned: Math.min(files.length, MCP_DETAIL_FILE_LIMIT),
      omitted: Math.max(0, files.length - MCP_DETAIL_FILE_LIMIT),
      items: files
        .slice(0, MCP_DETAIL_FILE_LIMIT)
        .map(compactSessionSummaryFile),
    },
  };
}

function compactScannerStatusForMcp() {
  const status = readScannerStatus();
  if (!status) return null;
  if (Date.now() - status.updatedAtMs > 120_000) return null;
  return {
    phase: status.phase,
    message: status.message,
    updated_at_ms: status.updatedAtMs,
    started_at_ms: status.startedAtMs,
    processed_files: status.processedFiles,
    discovered_files: status.discoveredFiles,
    files_scanned: status.filesScanned,
    new_turns: status.newTurns,
    touched_sessions: status.touchedSessions,
    processed_sessions: status.processedSessions,
    total_sessions: status.totalSessions,
    current_session_id: status.currentSessionId,
  };
}

server.tool(
  "sessions",
  "List recent sessions with stats (tokens, cost, model, project)",
  {
    limit: z
      .number()
      .optional()
      .describe("Max sessions to return (default 20)"),
    since: z
      .string()
      .optional()
      .describe('Time filter: ISO date or relative like "24h", "7d", "30m"'),
  },
  async ({ limit, since }) => {
    const results = await service.listSessions({ limit, since });
    return jsonContent(compactSessionListResult(results));
  },
);

server.tool(
  "timeline",
  "Get messages and tool calls for a session. Includes child sessions (forks, subagents) and DAG metadata (uuid/parentUuid). Content truncated to 500 chars by default.",
  {
    sessionId: z.string().describe("The session ID to query"),
    limit: z
      .number()
      .optional()
      .describe("Max messages to return (default 50)"),
    offset: z
      .number()
      .optional()
      .describe("Number of messages to skip (for pagination)"),
    fullPayloads: z
      .boolean()
      .optional()
      .describe("Return full content instead of truncated (default false)"),
  },
  async ({ sessionId, limit, offset, fullPayloads }) => {
    const result = await service.sessionTimeline({
      sessionId,
      limit,
      offset,
      fullPayloads,
    });
    return jsonContent(fullPayloads ? result : compactTimelineResult(result));
  },
);

server.tool(
  "costs",
  "Token usage and cost breakdowns from scanner data, grouped by session, model, or day",
  {
    since: z
      .string()
      .optional()
      .describe('Time filter: ISO date or relative like "24h", "7d"'),
    groupBy: z
      .enum(["session", "model", "day"])
      .optional()
      .describe("Group results by session, model, or day (default: session)"),
  },
  async ({ since, groupBy }) => {
    const results = await service.costBreakdown({ since, groupBy });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(results, null, 2) },
      ],
    };
  },
);

server.tool(
  "summary",
  "Activity summary — sessions, prompts, tools used, files changed, and costs. Ideal for standup updates and daily reports.",
  {
    since: z
      .string()
      .optional()
      .describe(
        'Time window (default "24h"). ISO date or relative like "24h", "7d"',
      ),
  },
  async ({ since }) => {
    const summary = await service.activitySummary({ since });
    return jsonContent(compactActivitySummary(summary));
  },
);

server.tool(
  "plans",
  "List plans created by Claude Code (from ExitPlanMode events). Returns plan markdown, allowed prompts, session ID, and timestamp.",
  {
    session_id: z.string().optional().describe("Filter to a specific session"),
    since: z
      .string()
      .optional()
      .describe('Time filter: ISO date or relative like "24h", "7d"'),
    limit: z.number().optional().describe("Max plans to return (default 20)"),
  },
  async ({ session_id, since, limit }) => {
    const plans = await service.listPlans({ session_id, since, limit });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(plans, null, 2) },
      ],
    };
  },
);

server.tool(
  "search",
  "Full-text search across events and messages (FTS5). Returns matching hook events, OTel logs, and message content. Payloads truncated to 500 chars by default.",
  {
    query: z.string().describe("Text to search for"),
    eventTypes: z
      .array(z.string())
      .optional()
      .describe("Filter to specific event types (applies to hook events only)"),
    since: z
      .string()
      .optional()
      .describe('Time filter: ISO date or relative like "24h", "7d"'),
    limit: z.number().optional().describe("Max results (default 20)"),
    offset: z
      .number()
      .optional()
      .describe("Number of results to skip (for pagination)"),
    fullPayloads: z
      .boolean()
      .optional()
      .describe("Return full payloads instead of truncated (default false)"),
  },
  async ({ query, eventTypes, since, limit, offset, fullPayloads }) => {
    const result = await service.search({
      query,
      eventTypes,
      since,
      limit,
      offset,
      fullPayloads,
    });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

server.tool(
  "get",
  "Get full details for a record by source and ID. Returns complete content without truncation.",
  {
    source: z
      .enum(["hook", "otel", "message"])
      .describe(
        "Record source: 'hook' for hook events, 'otel' for OTel logs, 'message' for parsed messages",
      ),
    id: z.number().describe("Record ID from search/timeline results"),
  },
  async ({ source, id }) => {
    const result = await service.print({ source, id });
    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No ${source} record found with id ${id}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

server.tool(
  "query",
  `Execute a read-only SQL query against the panopticon database.

Schema:
  sessions(session_id PK, target, started_at_ms, ended_at_ms, first_prompt, permission_mode, agent_version, model, cli_version, scanner_file_path, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens, total_reasoning_tokens, turn_count, otel_input_tokens, otel_output_tokens, otel_cache_read_tokens, otel_cache_creation_tokens, models, has_hooks, has_otel, has_scanner, message_count, user_message_count, parent_session_id, relationship_type, is_automated, created_at, project, machine)
  session_repositories(session_id, repository, first_seen_ms, git_user_name, git_user_email, branch)
  session_cwds(session_id, cwd, first_seen_ms)
  messages(id, session_id, ordinal, role, content, timestamp_ms, has_thinking, has_tool_use, content_length, is_system, model, token_usage, context_tokens, output_tokens, has_context_tokens, has_output_tokens, uuid, parent_uuid, sync_id)
  tool_calls(id, message_id, session_id, call_index, tool_name, category, tool_use_id, input_json, skill_name, result_content_length, result_content, subagent_session_id, duration_ms, sync_id)
  scanner_turns(id, session_id, source, turn_index, timestamp_ms, model, role, content_preview, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, sync_id)
  scanner_events(id, session_id, source, event_index, event_type, timestamp_ms, tool_name, tool_input, tool_output, content, metadata JSON, sync_id)
  hook_events(id, session_id, event_type, timestamp_ms, cwd, repository, tool_name, target, user_prompt, file_path, command, tool_result, plan, allowed_prompts, payload BLOB)
  session_summaries(id, session_summary_key, session_id, repository, cwd, branch, worktree, actor, machine, origin_scope, title, status, first_intent_ts_ms, last_intent_ts_ms, intent_count, edit_count, landed_edit_count, open_edit_count, summary_text, projection_hash, projected_at_ms, source_last_seen_at_ms, reason_json)
  session_summary_enrichments(session_summary_key PK, session_id, summary_text, summary_source, summary_runner, summary_model, summary_version, summary_generated_at_ms, projection_hash, summary_input_hash, summary_policy_hash, enriched_input_hash, enriched_message_count, dirty, dirty_reason_json, last_material_change_at_ms, last_attempted_at_ms, failure_count, last_error)
  session_summary_search_index(session_summary_key, session_id, corpus_key, source, priority, search_text, dirty, projection_hash, enriched_input_hash, updated_at_ms)
  otel_logs(id, timestamp_ns, observed_timestamp_ns, severity_number, severity_text, body, attributes JSON, resource_attributes JSON, session_id, prompt_id, trace_id, span_id)
  otel_metrics(id, timestamp_ns, name, value, metric_type, unit, attributes JSON, resource_attributes JSON, session_id)
  otel_spans(id, trace_id, span_id, parent_span_id, name, kind, start_time_ns, end_time_ns, status_code, status_message, attributes JSON, resource_attributes JSON, session_id)
  model_pricing(id, model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, updated_ms)

Join on session_id across tables. hook_events payload is gzipped — use decompress(payload) to read. messages.uuid/parent_uuid form a DAG for conversation branching. tool_calls.duration_ms is the time between tool invocation and result.`,
  {
    sql: z.string().describe("SQL query (SELECT/WITH/PRAGMA only)"),
  },
  async ({ sql }) => {
    try {
      const results = await service.rawQuery(sql);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(results, null, 2) },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "status",
  "Show panopticon database stats: row counts for each table",
  {},
  async () => {
    const scanner = compactScannerStatusForMcp();
    if (scanner) {
      return jsonContent({
        database_stats_unavailable: true,
        scanner,
      });
    }
    const stats = await service.dbStats();
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(stats, null, 2) },
      ],
    };
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Intent index — maps engineer prompts to the file edits they produced.
// ───────────────────────────────────────────────────────────────────────────

server.tool(
  "intent_for_code",
  "Given a file path, return the chronological intent history at that location: every prompt that produced an edit to this file, most recent first, annotated with whether the inserted content survived (status: 'current' | 'superseded' | 'reverted' | 'unknown'). Use this for 'why does this code exist?' questions.",
  {
    file_path: z.string().describe("Absolute path to the file"),
    limit: z
      .number()
      .optional()
      .describe("Max intent edits to return (default 50)"),
  },
  async ({ file_path, limit }) => {
    const result = await service.intentForCode({ file_path, limit });
    return jsonContent(asArray(result).map(compactIntentForCodeRow));
  },
);

server.tool(
  "search_intent",
  "Search the intent index for prompts whose edits matched the query. Defaults to only_landed=true (excludes intents that produced no surviving edits). Each result includes the prompt, the files touched, and the landed_ratio.",
  {
    query: z.string().describe("Text to search for in prompt text (FTS5)"),
    only_landed: z
      .boolean()
      .optional()
      .describe(
        "If true (default), only return intents with at least one surviving edit",
      ),
    repository: z
      .string()
      .optional()
      .describe("Filter to intents recorded in this repository"),
    limit: z.number().optional().describe("Max results (default 20)"),
    offset: z.number().optional().describe("Skip N results for pagination"),
  },
  async ({ query, only_landed, repository, limit, offset }) => {
    const result = await service.searchIntent({
      query,
      only_landed,
      repository,
      limit,
      offset,
    });
    return jsonContent(asArray(result).map(compactSearchIntentRow));
  },
);

server.tool(
  "outcomes_for_intent",
  "Get the t0 (session-end) outcome view for an intent: which edits survived to session end, which were churned in-session, and which haven't been reconciled yet. Use intent_unit_id from search_intent or intent_for_code results.",
  {
    intent_unit_id: z.number().describe("ID of the intent unit"),
  },
  async ({ intent_unit_id }) => {
    const result = await service.outcomesForIntent({ intent_unit_id });
    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No intent unit found with id ${intent_unit_id}`,
          },
        ],
        isError: true,
      };
    }
    return jsonContent(compactOutcomesForIntent(result));
  },
);

server.tool(
  "session_summaries",
  "List session-derived summaries with provenance metadata and the compact preview shape used for SessionStart context injection. This is the explicit replacement for the old weak session summary text and is intentionally one row per session.",
  {
    repository: z
      .string()
      .optional()
      .describe("Filter to a repository path or identifier"),
    cwd: z.string().optional().describe("Filter to a working directory"),
    status: z
      .enum(["active", "landed", "mixed", "read-only", "unlanded"])
      .optional()
      .describe("Filter by derived session-summary status"),
    path: z
      .string()
      .optional()
      .describe("Only return session summaries touching this file path"),
    since: z
      .string()
      .optional()
      .describe('Time filter: ISO date or relative like "24h", "7d"'),
    limit: z.number().optional().describe("Max results (default 20)"),
    offset: z.number().optional().describe("Skip N results for pagination"),
  },
  async ({ repository, cwd, status, path, since, limit, offset }) => {
    const result = await service.listSessionSummaries({
      repository,
      cwd,
      status,
      path,
      since,
      limit,
      offset,
    });
    return jsonContent(asArray(result).map(compactSessionSummary));
  },
);

server.tool(
  "session_summary_detail",
  "Get the compact preview and explicit session-derived summary for a single session, including member intents and touched files.",
  {
    session_id: z.string().describe("ID of the session"),
    fullPayloads: z
      .boolean()
      .optional()
      .describe("Return full detail instead of compacted output"),
  },
  async ({ session_id, fullPayloads }) => {
    const result = await service.sessionSummaryDetail({ session_id });
    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No session summary found for session ${session_id}`,
          },
        ],
        isError: true,
      };
    }
    return jsonContent(
      fullPayloads ? result : compactSessionSummaryDetail(result),
    );
  },
);

server.tool(
  "why_code",
  "Explain the best current local provenance for a file path and optional line: which intent/session-summary most likely established the code and what evidence supports it.",
  {
    path: z.string().describe("File path to explain"),
    line: z
      .number()
      .optional()
      .describe("Optional 1-based line number for a more specific answer"),
    repository: z
      .string()
      .optional()
      .describe("Optional repository root used to resolve relative paths"),
  },
  async ({ path, line, repository }) => {
    const result = await service.whyCode({ path, line, repository });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

server.tool(
  "recent_work_on_path",
  "Show recent local intents, edits, and session summaries that touched a file path.",
  {
    path: z.string().describe("File path to inspect"),
    repository: z
      .string()
      .optional()
      .describe("Optional repository root used to resolve relative paths"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ path, repository, limit }) => {
    const result = await service.recentWorkOnPath({
      path,
      repository,
      limit,
    });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

server.tool(
  "file_overview",
  "Return a file-centric overview for a path: aggregate edit/session counts, the best current explanation, recent work, and related files that changed with it.",
  {
    path: z.string().describe("File path to inspect"),
    repository: z
      .string()
      .optional()
      .describe("Optional repository root used to resolve relative paths"),
    recent_limit: z
      .number()
      .optional()
      .describe("Max recent history rows to include (default 5)"),
    related_limit: z
      .number()
      .optional()
      .describe("Max related files to include (default 10)"),
  },
  async ({ path, repository, recent_limit, related_limit }) => {
    const result = await service.fileOverview({
      path,
      repository,
      recent_limit,
      related_limit,
    });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Permissions tools — read/preview/apply the panopticon hook allowlist.
// Used by the /optimize-permissions skill.
// ───────────────────────────────────────────────────────────────────────────

const permissionsInputSchema = {
  repository: z
    .string()
    .optional()
    .describe("Optional org/repo slug — stored in backup metadata."),
  approved_categories: z
    .array(z.string())
    .describe("Categories to approve. 'safe' is always included."),
  denied_categories: z
    .array(z.string())
    .describe("Categories to permanently deny (won't re-ask next run)."),
  custom_overrides: z
    .record(z.string(), z.string())
    .optional()
    .describe("Per-pattern overrides, e.g. { 'Bash(rm *)': 'deny' }."),
  permissions: z
    .array(z.string())
    .describe(
      "Permission patterns. 'Bash(<cmd> *)' entries are split into bash_commands; other strings go to tools.",
    ),
  categories: z
    .record(z.string(), categorySchema)
    .describe("Full category breakdown for backup/audit."),
};

server.tool(
  "permissions_show",
  "Read current permissions state: existing approvals + allowed.json. Call first when running /optimize-permissions. Returns { approvals, allowed, paths }.",
  {},
  async () => {
    const result = permissionsShow();
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

server.tool(
  "permissions_preview",
  "Compute the diff between the current allowed.json and the proposed state — added, removed, unchanged. Writes nothing. Use for dry-run / confirmation before permissions_apply.",
  permissionsInputSchema,
  async (params) => {
    const result = permissionsPreview(params);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

server.tool(
  "permissions_apply",
  "Write allowed.json and approvals.json atomically (tmp + rename), record a dedup'd snapshot in user_config_snapshots for sync-based history, and update Codex .rules if installed. Returns the diff that was applied plus file paths.",
  permissionsInputSchema,
  async (params) => {
    try {
      const result = permissionsApply(params);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

async function main() {
  // Redirect stderr to log file (stdout is reserved for MCP JSON-RPC protocol)
  let logStream: fs.WriteStream | null = null;
  try {
    const logFd = openLogFd("mcp");
    logStream = fs.createWriteStream("", { fd: logFd });
  } catch {
    // MCP servers may run inside read-only sandboxes. Logging must not prevent
    // the JSON-RPC server from starting; stdout remains reserved for protocol.
    try {
      logStream = fs.createWriteStream(os.devNull);
    } catch {
      logStream = null;
    }
  }
  if (logStream) {
    process.stderr.write = logStream.write.bind(
      logStream,
    ) as typeof process.stderr.write;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log.mcp.error("MCP server error:", err);
  process.exit(1);
});
