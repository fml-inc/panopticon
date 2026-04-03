#!/usr/bin/env node

import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  activitySummary,
  costBreakdown,
  dbStats,
  listPlans,
  listSessions,
  print,
  rawQuery,
  search,
  sessionTimeline,
} from "../db/query.js";
import { logPaths } from "../log.js";

const server = new McpServer({
  name: "panopticon",
  version: "0.1.0",
});

server.tool(
  "panopticon_sessions",
  "List recent Claude Code & Gemini CLI sessions with stats (event count, tools used, cost)",
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
    const results = listSessions({ limit, since });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "panopticon_session_timeline",
  "Get chronological events for a specific session (hook events + OTel logs merged). Payloads are truncated to 500 chars by default — use fullPayloads: true for complete data.",
  {
    sessionId: z.string().describe("The session ID to query"),
    eventTypes: z
      .array(z.string())
      .optional()
      .describe("Filter to specific event types"),
    limit: z.number().optional().describe("Max events to return (default 20)"),
    offset: z
      .number()
      .optional()
      .describe("Number of events to skip (for pagination)"),
    fullPayloads: z
      .boolean()
      .optional()
      .describe("Return full payloads instead of truncated (default false)"),
  },
  async ({ sessionId, eventTypes, limit, offset, fullPayloads }) => {
    const result = sessionTimeline({
      sessionId,
      eventTypes,
      limit,
      offset,
      fullPayloads,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "panopticon_costs",
  "Token usage and cost breakdowns, grouped by session, model, or day",
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
    const results = costBreakdown({ since, groupBy });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "panopticon_summary",
  "Generate a summary of recent Claude Code & Gemini CLI activity — sessions, prompts, tools used, files changed, and costs. Ideal for standup updates, daily reports, and progress reviews.",
  {
    since: z
      .string()
      .optional()
      .describe(
        'Time window (default "24h"). ISO date or relative like "24h", "7d"',
      ),
  },
  async ({ since }) => {
    const summary = activitySummary({ since });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "panopticon_plans",
  "List plans created by Claude Code (from ExitPlanMode events). Returns the full plan markdown, allowed prompts, session ID, and timestamp.",
  {
    session_id: z.string().optional().describe("Filter to a specific session"),
    since: z
      .string()
      .optional()
      .describe('Time filter: ISO date or relative like "24h", "7d"'),
    limit: z.number().optional().describe("Max plans to return (default 20)"),
  },
  async ({ session_id, since, limit }) => {
    const plans = listPlans({ session_id, since, limit });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(plans, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "panopticon_search",
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
    const result = search({
      query,
      eventTypes,
      since,
      limit,
      offset,
      fullPayloads,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "panopticon_get",
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
    const result = print({ source, id });
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
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "panopticon_query",
  `Execute a read-only SQL query against the panopticon database.

Schema:
  sessions(session_id PK, target, started_at_ms, ended_at_ms, first_prompt, permission_mode, agent_version, model, cli_version, scanner_file_path, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens, total_reasoning_tokens, turn_count, otel_input_tokens, otel_output_tokens, otel_cache_read_tokens, otel_cache_creation_tokens, models, has_hooks, has_otel, has_scanner, summary, summary_version, message_count, user_message_count, parent_session_id, relationship_type, is_automated, created_at, project, machine)
  session_repositories(session_id, repository, first_seen_ms, git_user_name, git_user_email, branch)
  session_cwds(session_id, cwd, first_seen_ms)
  messages(id, session_id, ordinal, role, content, timestamp_ms, has_thinking, has_tool_use, content_length, is_system, model, token_usage, context_tokens, output_tokens, has_context_tokens, has_output_tokens, uuid, parent_uuid)
  tool_calls(id, message_id, session_id, tool_name, category, tool_use_id, input_json, skill_name, result_content_length, result_content, subagent_session_id, duration_ms)
  scanner_turns(id, session_id, source, turn_index, timestamp_ms, model, role, content_preview, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, summary)
  scanner_events(id, session_id, source, event_type, timestamp_ms, tool_name, tool_input, tool_output, content, metadata JSON)
  session_summary_deltas(id, session_id, delta_index, created_at_ms, from_turn, to_turn, content, method)
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
      const results = rawQuery(sql);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
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
  "panopticon_status",
  "Show panopticon database stats: row counts for each table",
  {},
  async () => {
    const stats = dbStats();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  },
);

async function main() {
  // Redirect stderr to log file (stdout is reserved for MCP JSON-RPC protocol)
  const logFd = fs.openSync(logPaths.mcp, "a");
  const logStream = fs.createWriteStream("", { fd: logFd });
  process.stderr.write = logStream.write.bind(
    logStream,
  ) as typeof process.stderr.write;

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
