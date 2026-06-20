import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepoFromCwd } from "../../repo.js";
import {
  getSelectedOrg,
  getValidToken,
  readTokens,
} from "../auth/token-store.js";
import {
  createFmlClient,
  getAuthenticatedClient,
  type ToolResult,
} from "../fml-client.js";
import { Sentry } from "../sentry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

const PANOPTICON_HINT =
  "\n\nFor local data, use the panopticon MCP tools instead (e.g. panopticon__sessions, panopticon__costs, panopticon__search, panopticon__timeline).";

async function toolHandler(toolName: string, args: Record<string, unknown>) {
  try {
    const api = await getAuthenticatedClient();
    if (!api) {
      return errorResult(
        "Not authenticated. Run `fml login` to sign in, then restart Claude Code." +
          PANOPTICON_HINT,
      );
    }
    const result = await api.callBackend(toolName, args);
    if (!result.ok) {
      return errorResult(
        `${result.error ?? "Unknown error"}${PANOPTICON_HINT}`,
      );
    }
    return textResult(result.result);
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`Unexpected error: ${msg}${PANOPTICON_HINT}`);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerTools(server: McpServer): void {
  server.tool(
    "whoami",
    "Show current authenticated user and available organizations",
    {},
    async () => {
      const tokens = readTokens();
      const token = tokens ? await getValidToken() : null;
      let orgs = null;
      if (token) {
        try {
          orgs = await createFmlClient(token).queryOrgs();
        } catch {}
      }
      return textResult({
        authenticated: !!tokens,
        user: tokens?.user ?? null,
        orgs,
      });
    },
  );

  // ── Messages ───────────────────────────────────────────────────────────────

  server.tool(
    "fml_list_messages",
    "List messages from a conversation within a time range. Requires a conversationId from the FML web app.",
    {
      startTime: z
        .number()
        .optional()
        .describe(
          "Start time in milliseconds (inclusive). Omit to start from beginning.",
        ),
      endTime: z
        .number()
        .optional()
        .describe(
          "End time in milliseconds (inclusive). Omit to include up to most recent.",
        ),
      limit: z
        .number()
        .optional()
        .describe(
          "Maximum number of messages to return per page (default: 20)",
        ),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous result to get next page"),
    },
    async (args) => toolHandler("list-messages", args),
  );

  server.tool(
    "fml_list_messages_with_context",
    "Get messages around a specific message to see the context. Takes a message ID and returns messages before and after it.",
    {
      messageId: z
        .string()
        .describe("The ID of the target message to get context around"),
      before: z
        .number()
        .optional()
        .describe(
          "Number of messages to retrieve before the target (default: 5)",
        ),
      after: z
        .number()
        .optional()
        .describe(
          "Number of messages to retrieve after the target (default: 5)",
        ),
    },
    async (args) => toolHandler("list-messages-with-context", args),
  );

  // ── Slack ──────────────────────────────────────────────────────────────────

  server.tool(
    "fml_get_slack_channel_history",
    "Fetch recent message history from a Slack channel. Requires Slack integration to be connected.",
    {
      channelId: z
        .string()
        .optional()
        .describe(
          "Slack channel ID (e.g. C0123ABC). If omitted, uses the channel from the current Slack-sourced conversation.",
        ),
      limit: z
        .number()
        .optional()
        .describe("Number of messages to fetch (default 20, max 50)"),
    },
    async (args) => toolHandler("get-slack-channel-history", args),
  );

  server.tool(
    "fml_get_slack_message",
    "Fetch a specific Slack message by timestamp or permalink. Requires Slack integration to be connected.",
    {
      permalink: z
        .string()
        .optional()
        .describe(
          "Slack message permalink. If provided, channelId and messageTs are ignored.",
        ),
      channelId: z
        .string()
        .optional()
        .describe(
          "Slack channel ID (e.g. C0123ABC). Required if permalink not provided.",
        ),
      messageTs: z
        .string()
        .optional()
        .describe(
          "Message timestamp (e.g. 1234567890.123456). Required if permalink not provided.",
        ),
      includeThreadContext: z
        .boolean()
        .optional()
        .describe(
          "If true, fetches thread replies along with the message (default false)",
        ),
    },
    async (args) => toolHandler("get-slack-message", args),
  );

  // ── Skills ─────────────────────────────────────────────────────────────────

  server.tool(
    "fml_list_skills",
    "List all available FML skills. Skills provide detailed knowledge about FML features.",
    {},
    async () => toolHandler("list-skills", {}),
  );

  server.tool(
    "fml_load_skill",
    "Load a skill prompt by ID. Skills provide detailed knowledge about FML features.",
    {
      skillId: z
        .string()
        .describe("The skill ID to load (e.g., 'fml-help', 'fml-navigation')"),
    },
    async (args) => toolHandler("load-skill", args),
  );

  // ── Analysis ───────────────────────────────────────────────────────────────

  server.tool(
    "fml_search_analysis",
    "Search analysis results produced by `fml_run_analysis_workflow`. USE FOR: finding analyses by topic, type, or status across a repo (or all repos in the org). FILTERS: query (text search), promptKey (exact type like 'deep_security_auditor'), status (complete, running, failed). Pass `repositoryId` to limit the search, or omit to fan out across every repo in the org.",
    {
      query: z
        .string()
        .optional()
        .describe("Text search across analysis type and content"),
      promptKey: z
        .string()
        .optional()
        .describe(
          "Exact filter by analysis type (e.g., 'deep_security_auditor')",
        ),
      status: z
        .enum(["complete", "running", "created", "failed"])
        .optional()
        .describe("Filter by status"),
      limit: z
        .number()
        .optional()
        .describe(
          "Maximum number of results to return total across all matched repos (default 20)",
        ),
      repositoryId: z
        .string()
        .optional()
        .describe(
          "Limit to one repository. Omit to search every repo in the caller's organization.",
        ),
    },
    async (args) => toolHandler("search-analysis", args),
  );

  server.tool(
    "fml_run_analysis_workflow",
    "Run comprehensive codebase analysis workflows on a repository. Available prompts: deep_security_auditor, deep_architecture_auditor, deep_code_quality_auditor, deep_performance_auditor, deep_ux_auditor, deep_dependencies_auditor, deep_cost_auditor, deep_ai_architecture_integration, deep_ai_security. The backend auto-picks the repo for single-repo orgs; pass `repositoryId` explicitly when the org has multiple repos (the tool will otherwise return a clarifying error listing them).",
    {
      selectedPromptKeys: z
        .array(
          z.enum([
            "deep_security_auditor",
            "deep_architecture_auditor",
            "deep_code_quality_auditor",
            "deep_performance_auditor",
            "deep_ux_auditor",
            "deep_dependencies_auditor",
            "deep_cost_auditor",
            "deep_ai_architecture_integration",
            "deep_ai_security",
          ]),
        )
        .optional()
        .describe(
          "Array of specific analysis prompts to run. If not provided, runs default set.",
        ),
      repositoryId: z
        .string()
        .optional()
        .describe(
          "Target repository ID. Omit for single-repo orgs (auto-pick). Required when the org has multiple repos — the tool will list them in its error if not provided.",
        ),
    },
    async (args) => toolHandler("run-analysis-workflow", args),
  );

  server.tool(
    "fml_run_team_analysis",
    "Run a team-wide AI coding practice analysis for the caller's organization. Produces a structured report with per-person narratives covering tool usage, collaboration patterns, configuration, and notable changes. Use for prompts like 'run team analysis for the last 14 days' or 'how is the team doing?'. Kicks a durable Convex workflow and returns immediately with a reportId; when called inside a conversation, a completion message is posted back to that conversation when the workflow finishes — wait for that follow-up turn, do not poll. Idempotent: if a run is already in flight, returns the existing reportId with started=false. Requires org-owner access and at least one running dev environment.",
    {
      windowDays: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe(
          "Size of the analysis window in days. Defaults to 30. Clamped to [1, 90]. Match the user's phrasing: 'last 14 days' → 14, 'last month' → 30, 'this week' → 7.",
        ),
    },
    async (args) => toolHandler("run-team-analysis", args),
  );

  // ── Integrations ───────────────────────────────────────────────────────────

  server.tool(
    "fml_list_integrations",
    "List integrations for this project — both connected and available. Use to check what integrations are active.",
    {},
    async () => toolHandler("list-integrations", {}),
  );

  // Integration query tools
  const integrationTools: Array<{
    name: string;
    mastraId: string;
    description: string;
    endpointHelp: string;
  }> = [
    {
      name: "fml_query_sentry",
      mastraId: "integration-sentry",
      description:
        "Look up production errors, exceptions, and crash data from Sentry. Common endpoints: 'organizations/{orgSlug}/issues/' (GET), 'issues/{issue_id}/' (GET). {orgSlug} is auto-substituted.",
      endpointHelp:
        "Sentry REST API endpoint. {orgSlug} is auto-substituted. e.g. 'organizations/{orgSlug}/issues/'",
    },
    {
      name: "fml_query_slack",
      mastraId: "integration-slack",
      description:
        "Send messages and read channel/user info from Slack. Use channel IDs not names. Common endpoints: 'conversations.list' (GET), 'chat.postMessage' (POST).",
      endpointHelp:
        "Slack API method, e.g. 'conversations.list', 'chat.postMessage'",
    },
    {
      name: "fml_query_github",
      mastraId: "integration-github",
      description:
        "Query repository activity from GitHub — PRs, commits, issues, code. {owner} and {repo} are auto-substituted. Common endpoints: 'repos/{owner}/{repo}/pulls' (GET).",
      endpointHelp: "GitHub REST API path. e.g. 'repos/{owner}/{repo}/pulls'",
    },
    {
      name: "fml_query_linear",
      mastraId: "integration-linear",
      description:
        "Query and manage Linear issues and projects via GraphQL. Endpoint is always 'graphql', method POST.",
      endpointHelp:
        "Linear GraphQL endpoint — always use 'graphql' with method POST and {query, variables} in body",
    },
    {
      name: "fml_query_notion",
      mastraId: "integration-notion",
      description:
        "Search pages, query databases, read and write content in Notion. Common endpoints: 'search' (POST), 'databases/{id}/query' (POST).",
      endpointHelp:
        "Notion REST API endpoint, e.g. 'search', 'databases/{database_id}/query'",
    },
    {
      name: "fml_query_freshdesk",
      mastraId: "integration-freshdesk",
      description:
        "Query and manage customer support tickets in Freshdesk. Common endpoints: 'tickets' (GET), 'tickets/{id}' (GET).",
      endpointHelp:
        "Freshdesk REST API v2 endpoint, e.g. 'tickets', 'tickets/{id}'",
    },
    {
      name: "fml_query_stripe",
      mastraId: "integration-stripe",
      description:
        "Query Stripe API for customers, subscriptions, charges, invoices, and revenue. Common endpoints: 'customers' (GET), 'subscriptions?status=active' (GET), 'charges' (GET), 'invoices' (GET), 'balance' (GET).",
      endpointHelp:
        "Stripe REST API v1 endpoint, e.g. 'customers', 'subscriptions?status=active', 'charges', 'balance'",
    },
  ];

  for (const tool of integrationTools) {
    server.tool(
      tool.name,
      tool.description,
      {
        endpoint: z.string().describe(tool.endpointHelp),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .optional()
          .describe("HTTP method. Defaults to GET."),
        body: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Request body as a JSON object (for POST/PUT/PATCH)"),
        projectId: z
          .string()
          .optional()
          .describe(
            "Optional project ID to scope this query. Required for GitHub (needs repo context).",
          ),
      },
      async (args) => toolHandler(tool.mastraId, args),
    );
  }

  // ── Engineering Activity ───────────────────────────────────────────────────

  server.tool(
    "get_engineering_activity",
    "Get agent activity summary (Claude Code, Codex, Gemini CLI, Mastra). SCOPES: 'org' (default), 'project', or 'user' (by githubUsername).",
    {
      timeRange: z
        .enum(["1h", "6h", "24h", "7d", "30d"])
        .optional()
        .describe("Preset time range. Default '7d'."),
      since: z
        .string()
        .optional()
        .describe("ISO 8601 start timestamp. Overrides timeRange."),
      until: z.string().optional().describe("ISO 8601 end timestamp."),
      target: z
        .enum(["claude", "codex", "gemini", "mastra"])
        .optional()
        .describe("Filter by agent type. Omit for all."),
      scope: z
        .enum(["org", "project", "user"])
        .optional()
        .describe("Query scope. 'org' (default), 'project', or 'user'."),
      githubUsername: z
        .string()
        .optional()
        .describe("Required when scope is 'user'. GitHub username."),
    },
    async (args) => toolHandler("get-engineering-activity", args),
  );

  server.tool(
    "list_engineering_sessions",
    "List agent sessions (Claude Code, Codex, Gemini CLI, Mastra). Each session includes first prompt preview and event counts.",
    {
      scope: z
        .enum(["org", "project"])
        .optional()
        .describe("Query scope. Default 'org'."),
      target: z
        .enum(["claude", "codex", "gemini", "mastra"])
        .optional()
        .describe("Filter by agent type. Omit for all."),
      githubUsername: z
        .string()
        .optional()
        .describe("Filter to sessions by this GitHub username."),
      timeRange: z.enum(["1h", "6h", "24h", "7d", "30d"]).optional(),
      since: z.string().optional().describe("ISO 8601 start timestamp."),
      until: z.string().optional().describe("ISO 8601 end timestamp."),
      limit: z
        .number()
        .optional()
        .describe("Max sessions to return (default 20, max 50)."),
    },
    async (args) => toolHandler("list-engineering-sessions", args),
  );

  server.tool(
    "get_session_timeline",
    'Get chronological timeline for a coding agent session. Returns messages and/or hook events interleaved by timestamp. Use source="hooks" to see permission requests, tool approvals, etc. REQUIRES: sessionId from list_engineering_sessions.',
    {
      sessionId: z.string().describe("The session ID to get details for."),
      includeSystemMessages: z
        .boolean()
        .optional()
        .describe("Include system messages (default false)."),
      source: z
        .enum(["messages", "hooks", "all"])
        .optional()
        .describe(
          'Filter by source: "messages" (scanner messages only), "hooks" (hook events only), "all" (both interleaved). Default "all".',
        ),
      eventType: z
        .string()
        .optional()
        .describe(
          'Filter hook events by type (e.g. "PermissionRequest", "PreToolUse", "Stop"). Only applies when source includes hooks.',
        ),
      limit: z
        .number()
        .optional()
        .describe("Max entries to return (default 50, max 200)."),
      offset: z
        .number()
        .optional()
        .describe("Skip first N entries for pagination."),
    },
    async (args) => toolHandler("get-session-timeline", args),
  );

  server.tool(
    "get_session_turns",
    "Get per-turn token accounting for a coding agent session. USE FOR: understanding cost per turn, model used at each step, cache hit analysis. REQUIRES: sessionId from list_engineering_sessions.",
    {
      sessionId: z.string().describe("The session ID to get turns for."),
      limit: z
        .number()
        .optional()
        .describe("Max turns to return (default 50, max 200)."),
      offset: z
        .number()
        .optional()
        .describe("Skip first N turns for pagination."),
    },
    async (args) => toolHandler("get-session-turns", args),
  );

  server.tool(
    "get_ai_spending",
    "Get AI spending and token usage data. Groups by 'session' (default), 'model', or 'day'.",
    {
      timeRange: z
        .enum(["1h", "6h", "24h", "7d", "30d"])
        .optional()
        .describe("Default '7d'."),
      since: z.string().optional().describe("ISO 8601 start timestamp."),
      until: z.string().optional().describe("ISO 8601 end timestamp."),
      groupBy: z
        .enum(["session", "model", "day"])
        .optional()
        .describe("How to group results."),
      target: z
        .enum(["claude", "codex", "gemini", "mastra"])
        .optional()
        .describe("Filter by agent type. Omit for all."),
    },
    async (args) => toolHandler("get-ai-spending", args),
  );

  server.tool(
    "search_engineering_sessions",
    "Search across agent sessions by text. Searches prompts, tool names, and event payloads.",
    {
      query: z.string().describe("Text to search for. Case-insensitive."),
      timeRange: z.enum(["1h", "6h", "24h", "7d", "30d"]).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      target: z
        .enum(["claude", "codex", "gemini", "mastra"])
        .optional()
        .describe("Filter by agent type. Omit for all."),
      limit: z.number().optional().describe("Max results (default 20)."),
    },
    async (args) => toolHandler("search-engineering-sessions", args),
  );

  // ── Config Snapshots ────────────────────────────────────────────────────

  server.tool(
    "list_user_configs",
    "List user-level configuration snapshots (CLAUDE.md, settings, etc.) across the org. Shows who has configs and when they were last updated.",
    {},
    async () => {
      try {
        const orgSlug = getSelectedOrg();
        if (!orgSlug) return errorResult("No org selected. Run `fml login`.");
        const api = await getAuthenticatedClient();
        if (!api) return errorResult("Not authenticated. Run `fml login`.");
        const result = await api.listUserConfigSnapshots(orgSlug);
        return textResult(result);
      } catch (err) {
        Sentry.captureException(err);
        return errorResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.tool(
    "get_user_config",
    "Get detailed user configuration for a specific GitHub user — their CLAUDE.md, settings.json, MCP servers, etc.",
    {
      githubUsername: z.string().describe("GitHub username to look up."),
    },
    async (args) => {
      try {
        const orgSlug = getSelectedOrg();
        if (!orgSlug) return errorResult("No org selected. Run `fml login`.");
        const api = await getAuthenticatedClient();
        if (!api) return errorResult("Not authenticated. Run `fml login`.");
        const result = await api.getUserConfigDetail(
          orgSlug,
          args.githubUsername,
        );
        if (!result)
          return errorResult(`No config found for ${args.githubUsername}.`);
        return textResult(result);
      } catch (err) {
        Sentry.captureException(err);
        return errorResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.tool(
    "list_repo_configs",
    "List repository-level configuration snapshots (CLAUDE.md, .mcp.json, etc.) across the org. Optionally filter by repository.",
    {
      repository: z
        .string()
        .optional()
        .describe("Filter by repository full name (e.g. 'org/repo')."),
    },
    async (args) => {
      try {
        const orgSlug = getSelectedOrg();
        if (!orgSlug) return errorResult("No org selected. Run `fml login`.");
        const api = await getAuthenticatedClient();
        if (!api) return errorResult("Not authenticated. Run `fml login`.");
        const result = await api.listRepoConfigSnapshots(
          orgSlug,
          args.repository,
        );
        return textResult(result);
      } catch (err) {
        Sentry.captureException(err);
        return errorResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.tool(
    "get_repo_config",
    "Get detailed repository configuration — CLAUDE.md files, .mcp.json, and other agent config found in a specific repo.",
    {
      repository: z
        .string()
        .describe("Repository full name (e.g. 'org/repo')."),
    },
    async (args) => {
      try {
        const orgSlug = getSelectedOrg();
        if (!orgSlug) return errorResult("No org selected. Run `fml login`.");
        const api = await getAuthenticatedClient();
        if (!api) return errorResult("Not authenticated. Run `fml login`.");
        const result = await api.getRepoConfigDetail(orgSlug, args.repository);
        if (!result)
          return errorResult(`No config found for ${args.repository}.`);
        return textResult(result);
      } catch (err) {
        Sentry.captureException(err);
        return errorResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ── Anamnesis ground-truth context ──────────────────────────────────────
  // Factual git/GitHub history for the current repo (which PRs touched a file,
  // what a commit/PR did, etc.), served from the anamnesis corpus.

  const resolveRepoArg = (repo?: string): string | null => {
    if (repo) return repo;
    try {
      return resolveRepoFromCwd(process.cwd())?.repo ?? null;
    } catch {
      return null;
    }
  };

  const anamnesisResult = (result: ToolResult) =>
    result.ok
      ? textResult(result.result)
      : errorResult(result.error ?? "Unknown error");

  server.tool(
    "fml_path_history",
    "Ground-truth history for a file path: PRs that touched it and review comments on it (newest first). USE FOR: understanding why a file looks the way it does, who changed it, related PRs.",
    {
      path: z.string().describe("Repo-relative file path, e.g. 'src/app.ts'."),
      repo: z
        .string()
        .optional()
        .describe("owner/repo. Defaults to the current working repo."),
      limit: z.number().optional().describe("Max items per list (default 25)."),
    },
    async (args) => {
      const repo = resolveRepoArg(args.repo);
      if (!repo)
        return errorResult(
          "Could not determine repo — pass `repo` (owner/repo).",
        );
      const api = await getAuthenticatedClient();
      if (!api) return errorResult("Not authenticated. Run `fml login`.");
      return anamnesisResult(
        await api.anamnesisContext("path", {
          repo,
          path: args.path,
          limit: args.limit,
        }),
      );
    },
  );

  server.tool(
    "fml_commit_context",
    "Ground-truth context for a commit sha: the PR(s) that contain or merged it, and any revert relationships. Accepts abbreviated shas.",
    {
      sha: z.string().describe("Commit sha (full or abbreviated)."),
      repo: z
        .string()
        .optional()
        .describe("owner/repo. Defaults to the current working repo."),
    },
    async (args) => {
      const repo = resolveRepoArg(args.repo);
      if (!repo)
        return errorResult(
          "Could not determine repo — pass `repo` (owner/repo).",
        );
      const api = await getAuthenticatedClient();
      if (!api) return errorResult("Not authenticated. Run `fml login`.");
      return anamnesisResult(
        await api.anamnesisContext("commit", { repo, sha: args.sha }),
      );
    },
  );

  server.tool(
    "fml_pr_context",
    "Full ground-truth view of a pull request: metadata, commits, changed files, review comments, and derived facts.",
    {
      number: z.number().describe("PR number."),
      repo: z
        .string()
        .optional()
        .describe("owner/repo. Defaults to the current working repo."),
      limit: z.number().optional().describe("Max items per list (default 25)."),
    },
    async (args) => {
      const repo = resolveRepoArg(args.repo);
      if (!repo)
        return errorResult(
          "Could not determine repo — pass `repo` (owner/repo).",
        );
      const api = await getAuthenticatedClient();
      if (!api) return errorResult("Not authenticated. Run `fml login`.");
      return anamnesisResult(
        await api.anamnesisContext("pr", {
          repo,
          number: args.number,
          limit: args.limit,
        }),
      );
    },
  );

  server.tool(
    "fml_anamnesis_query",
    "Generic query over the anamnesis fact corpus. Filter by predicate (pr_touches_path, pr_contains_commit, pr_merged_as_commit, review_comment_on_path, commit_reverts_commit, pr_reverts_pr) and/or subject/object.",
    {
      predicate: z.string().optional().describe("Fact predicate to filter by."),
      subjectKind: z.string().optional(),
      subjectValue: z.string().optional(),
      objectKind: z.string().optional(),
      objectValue: z.string().optional(),
      repo: z
        .string()
        .optional()
        .describe("owner/repo. Defaults to the current working repo."),
      limit: z.number().optional().describe("Max facts (default 25)."),
    },
    async (args) => {
      const repo = resolveRepoArg(args.repo);
      if (!repo)
        return errorResult(
          "Could not determine repo — pass `repo` (owner/repo).",
        );
      const api = await getAuthenticatedClient();
      if (!api) return errorResult("Not authenticated. Run `fml login`.");
      return anamnesisResult(await api.anamnesisQuery({ ...args, repo }));
    },
  );
}
