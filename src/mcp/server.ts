#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "../config.js";
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
import { logPaths } from "../log.js";

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
  hook_events(id, session_id, event_type, timestamp_ms, cwd, repository, tool_name, user_prompt, file_path, command, plan, allowed_prompts, payload BLOB)
  otel_logs(id, timestamp_ns, observed_timestamp_ns, severity_number, severity_text, body, attributes JSON, resource_attributes JSON, session_id, prompt_id, trace_id, span_id)
  otel_metrics(id, timestamp_ns, name, value, metric_type, unit, attributes JSON, resource_attributes JSON, session_id)`,
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

// ---------------------------------------------------------------------------
// Optimize: permission management tools
// ---------------------------------------------------------------------------

const PERMISSIONS_DIR = path.join(config.dataDir, "permissions");
const APPROVALS_PATH = path.join(PERMISSIONS_DIR, "approvals.json");
const BACKUPS_DIR = path.join(PERMISSIONS_DIR, "backups");

const DEFAULT_APPROVALS = {
  approved_categories: ["safe"],
  denied_categories: [] as string[],
  custom_overrides: {} as Record<string, string>,
  last_run: null as string | null,
};

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

server.tool(
  "panopticon_optimize_state",
  "Load the current panopticon-optimize approvals state and the project's existing settings.local.json permissions. Returns both so the skill can determine what needs prompting vs auto-applying.",
  {
    project_path: z
      .string()
      .describe("Absolute path to the project root (where .claude/ lives)"),
  },
  async ({ project_path }) => {
    const approvals = readJson(APPROVALS_PATH) ?? DEFAULT_APPROVALS;
    const settingsPath = path.join(
      project_path,
      ".claude",
      "settings.local.json",
    );
    const settings = readJson(settingsPath) ?? { permissions: { allow: [] } };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              approvals,
              approvals_path: APPROVALS_PATH,
              current_permissions: settings.permissions?.allow ?? [],
              settings_path: settingsPath,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const categorySchema = z.object({
  status: z.enum(["approved", "denied", "skipped"]),
  patterns: z.array(z.string()),
  observed_commands: z.array(z.string()),
  call_count: z.number(),
});

server.tool(
  "panopticon_optimize_apply",
  `Apply the results of a panopticon-optimize run: write permissions to the project's settings.local.json (using managed section markers), save approvals state, and create a timestamped backup. Call this after the user has approved/denied categories.`,
  {
    project_path: z
      .string()
      .describe("Absolute path to the project root (where .claude/ lives)"),
    repository: z
      .string()
      .optional()
      .describe("Repository slug for backup metadata (e.g. org/repo)"),
    approved_categories: z
      .array(z.string())
      .describe("Category names the user approved"),
    denied_categories: z
      .array(z.string())
      .describe("Category names the user denied"),
    custom_overrides: z
      .record(z.string(), z.string())
      .optional()
      .describe("Per-pattern overrides: pattern -> 'allow' | 'deny'"),
    permissions: z
      .array(z.string())
      .describe("The final list of permission patterns to write"),
    categories: z
      .record(z.string(), categorySchema)
      .describe("Full category breakdown for the backup"),
  },
  async ({
    project_path,
    repository,
    approved_categories,
    denied_categories,
    custom_overrides,
    permissions,
    categories,
  }) => {
    const now = new Date().toISOString();
    const results: string[] = [];

    // Split permissions: Bash patterns → hook enforcement, non-Bash → settings.local.json
    const bashPattern = /^Bash\((.+?)[\s:]\*\)$/;
    const bashCommands: string[] = [];
    const settingsPermissions: string[] = [];

    for (const p of permissions) {
      const match = p.match(bashPattern);
      if (match) {
        bashCommands.push(match[1]);
      } else {
        settingsPermissions.push(p);
      }
    }

    // 1. Write settings.local.json with non-Bash patterns only
    const settingsPath = path.join(
      project_path,
      ".claude",
      "settings.local.json",
    );
    fs.mkdirSync(path.join(project_path, ".claude"), { recursive: true });
    const settings = readJson(settingsPath) ?? {};
    settings.permissions = settings.permissions ?? {};

    const existing: string[] = settings.permissions.allow ?? [];
    const START_MARKER = "// managed-by:panopticon-optimize";
    const END_MARKER = "// end:panopticon-optimize";

    // Find managed section boundaries
    const startIdx = existing.indexOf(START_MARKER);
    const endIdx = existing.indexOf(END_MARKER);

    const managed = [START_MARKER, ...settingsPermissions, END_MARKER];

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      // Replace managed section, keep everything outside it
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + 1);
      settings.permissions.allow = [...before, ...managed, ...after];
    } else {
      // No existing markers — filter out any stale markers and prepend managed section
      const cleaned = existing.filter(
        (e: string) => e !== START_MARKER && e !== END_MARKER,
      );
      settings.permissions.allow = [...managed, ...cleaned];
    }

    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    results.push(
      `Settings written to ${settingsPath} (${settingsPermissions.length} non-Bash patterns)`,
    );

    // 2. Write allowed_commands.json for hook-based chain-aware enforcement
    const allowedCommandsPath = path.join(
      PERMISSIONS_DIR,
      "allowed_commands.json",
    );
    fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });
    fs.writeFileSync(
      allowedCommandsPath,
      `${JSON.stringify({ bash_commands: bashCommands, updated: now }, null, 2)}\n`,
    );
    results.push(
      `Hook enforcement written to ${allowedCommandsPath} (${bashCommands.length} Bash commands)`,
    );

    // 3. Save approvals state
    const approvals = {
      approved_categories: [...new Set(["safe", ...approved_categories])],
      denied_categories: [...new Set(denied_categories)],
      custom_overrides: custom_overrides ?? {},
      last_run: now,
    };
    fs.writeFileSync(APPROVALS_PATH, `${JSON.stringify(approvals, null, 2)}\n`);
    results.push(`Approvals saved to ${APPROVALS_PATH}`);

    // 4. Create backup
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const dateStr = now.slice(0, 10);
    const timeStr = now.slice(11, 19).replace(/:/g, "");
    const backupPath = path.join(BACKUPS_DIR, `${dateStr}_${timeStr}.json`);
    const backup = {
      timestamp: now,
      repository,
      project_path,
      skill_version: "3",
      categories,
      generated_permissions: permissions,
      approvals_state: approvals,
    };
    fs.writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`);
    results.push(`Backup saved to ${backupPath}`);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: true, details: results }, null, 2),
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
