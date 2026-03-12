#!/usr/bin/env node

/**
 * Lightweight MCP server for widget CRUD operations.
 * Spawned by the analyze endpoint and passed to `claude -p` via --mcp-config.
 * Separate from the main panopticon MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createWidget,
  deleteWidget,
  listWidgets,
  updateWidget,
} from "../db/widgets.js";

const server = new McpServer({
  name: "panopticon-widgets",
  version: "0.1.0",
});

server.tool(
  "panopticon_ui_add_widget",
  "Create a dashboard widget. Types: chart (bar/line/area), table, kpi (single number), markdown.",
  {
    type: z.enum(["chart", "table", "kpi", "markdown"]).describe("Widget type"),
    title: z.string().describe("Widget title shown in the dashboard"),
    query: z
      .string()
      .describe("SQL query (SELECT/WITH only) that produces the widget data"),
    config: z
      .object({
        chartType: z.enum(["bar", "line", "area"]).optional(),
        xKey: z.string().optional(),
        yKeys: z.array(z.string()).optional(),
        colors: z
          .array(z.string())
          .optional()
          .describe("Hex colors for chart series, e.g. ['#3b82f6','#10b981']"),
        valueKey: z.string().optional(),
        format: z.enum(["number", "currency", "percent"]).optional(),
        prefix: z.string().optional().describe("KPI prefix, e.g. '$'"),
        suffix: z.string().optional().describe("KPI suffix, e.g. ' sessions'"),
        pageSize: z.number().optional(),
        template: z.string().optional(),
      })
      .optional()
      .describe(
        "Widget-specific config (chartType/xKey/yKeys/colors for chart, valueKey/format/prefix/suffix for kpi, pageSize for table)",
      ),
    position: z.number().optional().describe("Display order (lower = first)"),
    group_name: z
      .string()
      .optional()
      .describe("Dashboard group name for organizing widgets"),
    status: z
      .enum(["active", "pending"])
      .default("pending")
      .describe(
        "Widget status — pending widgets appear as inline previews in chat",
      ),
    chat_id: z.string().optional().describe("Chat ID that created this widget"),
  },
  async ({
    type,
    title,
    query,
    config,
    position,
    group_name,
    status,
    chat_id,
  }) => {
    const widget = createWidget({
      type,
      title,
      query,
      config,
      position,
      group_name,
      status,
      chat_id,
    });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(widget, null, 2) },
      ],
    };
  },
);

server.tool(
  "panopticon_ui_list_widgets",
  "List all dashboard widgets.",
  {},
  async () => {
    const widgets = listWidgets();
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(widgets, null, 2) },
      ],
    };
  },
);

server.tool(
  "panopticon_ui_update_widget",
  "Update an existing dashboard widget. Pass only the fields you want to change.",
  {
    id: z.string().describe("Widget ID to update"),
    title: z.string().optional().describe("New title"),
    query: z.string().optional().describe("New SQL query (SELECT/WITH only)"),
    config: z
      .object({
        chartType: z.enum(["bar", "line", "area"]).optional(),
        xKey: z.string().optional(),
        yKeys: z.array(z.string()).optional(),
        colors: z.array(z.string()).optional(),
        valueKey: z.string().optional(),
        format: z.enum(["number", "currency", "percent"]).optional(),
        prefix: z.string().optional(),
        suffix: z.string().optional(),
        pageSize: z.number().optional(),
        template: z.string().optional(),
      })
      .optional()
      .describe("New config (replaces existing config entirely)"),
    position: z.number().optional().describe("New display order"),
  },
  async ({ id, title, query, config, position }) => {
    const updated = updateWidget(id, { title, query, config, position });
    if (!updated) {
      return {
        content: [{ type: "text" as const, text: `Widget ${id} not found.` }],
      };
    }
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(updated, null, 2) },
      ],
    };
  },
);

server.tool(
  "panopticon_ui_remove_widget",
  "Remove a widget from the dashboard by ID.",
  {
    id: z.string().describe("Widget ID to remove"),
  },
  async ({ id }) => {
    const removed = deleteWidget(id);
    return {
      content: [
        {
          type: "text" as const,
          text: removed ? `Widget ${id} removed.` : `Widget ${id} not found.`,
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
  console.error("Widget MCP server error:", err);
  process.exit(1);
});
