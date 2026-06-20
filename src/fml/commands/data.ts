/**
 * CLI wrappers for remote FML backend data queries.
 * Each command queries the FML backend via the authenticated API client.
 */

import { getAuthenticatedClient } from "../fml-client.js";

async function queryBackend(
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login` to sign in.");
    process.exit(1);
  }
  const result = await api.callBackend(toolName, args);
  if (!result.ok) {
    console.error(result.error ?? "Unknown error");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleActivity(opts: { since?: string }): Promise<void> {
  await queryBackend("get-engineering-activity", {
    timeRange: opts.since ?? "24h",
  });
}

export async function handleSessions(opts: {
  since?: string;
  limit?: string;
}): Promise<void> {
  await queryBackend("list-engineering-sessions", {
    timeRange: opts.since ?? "24h",
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
  });
}

export async function handleTimeline(
  sessionId: string,
  opts: { limit?: string; offset?: string },
): Promise<void> {
  await queryBackend("get-session-timeline", {
    sessionId,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
  });
}

export async function handleSpending(opts: {
  since?: string;
  groupBy?: string;
}): Promise<void> {
  await queryBackend("get-ai-spending", {
    timeRange: opts.since ?? "7d",
    groupBy: opts.groupBy,
  });
}

export async function handleSearch(
  query: string,
  opts: { since?: string; limit?: string },
): Promise<void> {
  await queryBackend("search-engineering-sessions", {
    query,
    timeRange: opts.since ?? "7d",
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
  });
}
