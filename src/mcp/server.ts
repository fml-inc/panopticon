#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  listSessions,
  sessionTimeline,
  toolStats,
  costBreakdown,
  searchEvents,
  rawQuery,
  dbStats,
} from "../db/query.js";

const server = new McpServer({
  name: "panopticon",
  version: "0.1.0",
});

server.tool(
  "panopticon_sessions",
  "List recent Claude Code sessions with stats (event count, tools used, cost)",
  {
    limit: z.number().optional().describe("Max sessions to return (default 20)"),
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
  }
);

server.tool(
  "panopticon_session_timeline",
  "Get chronological events for a specific session (hook events + OTel logs merged)",
  {
    session_id: z.string().describe("The session ID to query"),
    event_types: z
      .array(z.string())
      .optional()
      .describe("Filter to specific event types"),
  },
  async ({ session_id, event_types }) => {
    const results = sessionTimeline({ session_id, event_types });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }
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
  }
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
  }
);

server.tool(
  "panopticon_search",
  "Search across all events (hook payloads, OTel log bodies/attributes) by text query",
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
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ query, event_types, since, limit }) => {
    const results = searchEvents({ query, event_types, since, limit });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "panopticon_query",
  "Execute a read-only SQL query against the panopticon database. Tables: otel_logs, otel_metrics, hook_events",
  {
    sql: z
      .string()
      .describe(
        "SQL query (SELECT/WITH/PRAGMA only). Tables: otel_logs, otel_metrics, hook_events"
      ),
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
  }
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
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
