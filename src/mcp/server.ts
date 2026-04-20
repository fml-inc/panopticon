#!/usr/bin/env node

import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "../config.js";
import { log, openLogFd } from "../log.js";
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
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(results, null, 2) },
      ],
    };
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
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
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
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(summary, null, 2) },
      ],
    };
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
  sessions(session_id PK, target, started_at_ms, ended_at_ms, first_prompt, permission_mode, agent_version, model, cli_version, scanner_file_path, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens, total_reasoning_tokens, turn_count, otel_input_tokens, otel_output_tokens, otel_cache_read_tokens, otel_cache_creation_tokens, models, has_hooks, has_otel, has_scanner, summary, summary_version, message_count, user_message_count, parent_session_id, relationship_type, is_automated, created_at, project, machine)
  session_repositories(session_id, repository, first_seen_ms, git_user_name, git_user_email, branch)
  session_cwds(session_id, cwd, first_seen_ms)
  messages(id, session_id, ordinal, role, content, timestamp_ms, has_thinking, has_tool_use, content_length, is_system, model, token_usage, context_tokens, output_tokens, has_context_tokens, has_output_tokens, uuid, parent_uuid)
  tool_calls(id, message_id, session_id, tool_name, category, tool_use_id, input_json, skill_name, result_content_length, result_content, subagent_session_id, duration_ms)
  scanner_turns(id, session_id, source, turn_index, timestamp_ms, model, role, content_preview, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens)
  scanner_events(id, session_id, source, event_type, timestamp_ms, tool_name, tool_input, tool_output, content, metadata JSON)
  hook_events(id, session_id, event_type, timestamp_ms, cwd, repository, tool_name, target, user_prompt, file_path, command, tool_result, plan, allowed_prompts, payload BLOB)
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
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
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
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
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
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

if (config.enableSessionSummaryProjections) {
  server.tool(
    "session_summaries",
    "List session-derived summaries with provenance metadata. This is the explicit replacement for the old weak session summary text and is intentionally one row per session.",
    {
      repository: z
        .string()
        .optional()
        .describe("Filter to a repository path or identifier"),
      cwd: z.string().optional().describe("Filter to a working directory"),
      status: z
        .enum(["active", "landed", "mixed", "abandoned"])
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
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "session_summary_detail",
    "Get the explicit session-derived summary for a single session, including member intents and touched files.",
    {
      session_id: z.string().describe("ID of the session"),
    },
    async ({ session_id }) => {
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
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
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
}

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
  const logFd = openLogFd("mcp");
  const logStream = fs.createWriteStream("", { fd: logFd });
  process.stderr.write = logStream.write.bind(
    logStream,
  ) as typeof process.stderr.write;

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log.mcp.error("MCP server error:", err);
  process.exit(1);
});
