#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  activitySummary,
  costBreakdown,
  dbStats,
  getEvent,
  listPlans,
  listSessions,
  rawQuery,
  searchEvents,
  sessionTimeline,
  toolStats,
} from "../db/query.js";

const server = new McpServer({
  name: "panopticon",
  version: "0.1.0",
});

server.tool(
  "panopticon_sessions",
  "List recent Claude Code sessions with stats (event count, tools used, cost)",
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
  "Get chronological events for a specific session (hook events + OTel logs merged). Payloads are truncated to 500 chars by default — use full_payloads: true for complete data.",
  {
    session_id: z.string().describe("The session ID to query"),
    event_types: z
      .array(z.string())
      .optional()
      .describe("Filter to specific event types"),
    limit: z.number().optional().describe("Max events to return (default 20)"),
    offset: z
      .number()
      .optional()
      .describe("Number of events to skip (for pagination)"),
    full_payloads: z
      .boolean()
      .optional()
      .describe("Return full payloads instead of truncated (default false)"),
  },
  async ({ session_id, event_types, limit, offset, full_payloads }) => {
    const { total, rows } = sessionTimeline({
      session_id,
      event_types,
      limit,
      offset,
      full_payloads,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ total, events: rows }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "panopticon_tool_stats",
  "Get per-tool usage aggregates: call count, success/failure count",
  {
    since: z
      .string()
      .optional()
      .describe('Time filter: ISO date or relative like "24h", "7d"'),
    session_id: z.string().optional().describe("Filter to a specific session"),
  },
  async ({ since, session_id }) => {
    const results = toolStats({ since, session_id });
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
  "panopticon_costs",
  "Token usage and cost breakdowns, grouped by session, model, or day",
  {
    since: z
      .string()
      .optional()
      .describe('Time filter: ISO date or relative like "24h", "7d"'),
    group_by: z
      .enum(["session", "model", "day"])
      .optional()
      .describe("Group results by session, model, or day (default: session)"),
  },
  async ({ since, group_by }) => {
    const results = costBreakdown({ since, group_by });
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
  "Generate a summary of recent Claude Code activity — sessions, prompts, tools used, files changed, and costs. Ideal for standup updates, daily reports, and progress reviews.",
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
  "List plans created by Claude Code (from ExitPlanMode events). Returns the full plan markdown, allowed prompts, session ID, and timestamp. Use for understanding intent behind sessions — what was planned vs what was executed.",
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
  "Search across all events (hook payloads, OTel log bodies/attributes) by text query. Payloads are truncated to 500 chars by default — use full_payloads: true for complete data.",
  {
    query: z.string().describe("Text to search for"),
    event_types: z
      .array(z.string())
      .optional()
      .describe("Filter to specific event types"),
    since: z
      .string()
      .optional()
      .describe('Time filter: ISO date or relative like "24h", "7d"'),
    limit: z.number().optional().describe("Max results (default 20)"),
    offset: z
      .number()
      .optional()
      .describe("Number of results to skip (for pagination)"),
    full_payloads: z
      .boolean()
      .optional()
      .describe("Return full payloads instead of truncated (default false)"),
  },
  async ({ query, event_types, since, limit, offset, full_payloads }) => {
    const { total, rows } = searchEvents({
      query,
      event_types,
      since,
      limit,
      offset,
      full_payloads,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ total, results: rows }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "panopticon_get_event",
  "Get full details for a specific event by source and ID (from search/timeline results). Returns the complete payload without truncation.",
  {
    source: z
      .enum(["hook", "otel"])
      .describe("Event source: 'hook' for hook events, 'otel' for OTel logs"),
    id: z.number().describe("Event ID from search/timeline results"),
  },
  async ({ source, id }) => {
    const result = getEvent({ source, id });
    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No ${source} event found with id ${id}`,
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
  hook_events(id, session_id, event_type, timestamp_ms, cwd, repository, tool_name, payload JSON)
  otel_logs(id, timestamp_ns, observed_timestamp_ns, severity_number, severity_text, body, attributes JSON, resource_attributes JSON, session_id, prompt_id, trace_id, span_id)
  otel_metrics(id, timestamp_ns, name, value, metric_type, unit, attributes JSON, resource_attributes JSON, session_id)
  sync_state(key, value)`,
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
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err.message}`,
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
