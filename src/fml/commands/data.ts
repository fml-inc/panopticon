/**
 * CLI wrappers for remote FML backend data queries.
 * Each command queries the FML backend via the authenticated API client.
 */

import { panopticonExec } from "../daemon-utils.js";
import { getAuthenticatedClient } from "../fml-client.js";

type LocalOpts = { local?: boolean };

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

function addOptionalArg(args: string[], flag: string, value?: string): void {
  if (value) args.push(flag, value);
}

export function runLocalPanopticon(args: string[]): void {
  const result = panopticonExec(...args, { timeout: 120_000 });
  if (!result.ok) {
    console.error(result.stdout.trim() || "panopticon command failed");
    process.exit(1);
  }
  process.stdout.write(
    result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`,
  );
}

export async function handleActivity(
  opts: { since?: string } & LocalOpts,
): Promise<void> {
  if (opts.local) {
    const args = ["summary"];
    addOptionalArg(args, "--since", opts.since ?? "24h");
    runLocalPanopticon(args);
    return;
  }
  await queryBackend("get-engineering-activity", {
    timeRange: opts.since ?? "24h",
  });
}

export async function handleSessions(
  opts: {
    since?: string;
    limit?: string;
  } & LocalOpts,
): Promise<void> {
  if (opts.local) {
    const args = ["sessions"];
    addOptionalArg(args, "--since", opts.since ?? "24h");
    addOptionalArg(args, "--limit", opts.limit);
    runLocalPanopticon(args);
    return;
  }
  await queryBackend("list-engineering-sessions", {
    timeRange: opts.since ?? "24h",
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
  });
}

export async function handleTimeline(
  sessionId: string,
  opts: { limit?: string; offset?: string; full?: boolean } & LocalOpts,
): Promise<void> {
  if (opts.local) {
    const args = ["timeline", sessionId];
    addOptionalArg(args, "--limit", opts.limit);
    addOptionalArg(args, "--offset", opts.offset);
    if (opts.full) args.push("--full");
    runLocalPanopticon(args);
    return;
  }
  await queryBackend("get-session-timeline", {
    sessionId,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
  });
}

export async function handleSpending(
  opts: {
    since?: string;
    groupBy?: string;
  } & LocalOpts,
): Promise<void> {
  if (opts.local) {
    const args = ["costs"];
    addOptionalArg(args, "--since", opts.since ?? "7d");
    addOptionalArg(args, "--group-by", opts.groupBy);
    runLocalPanopticon(args);
    return;
  }
  await queryBackend("get-ai-spending", {
    timeRange: opts.since ?? "7d",
    groupBy: opts.groupBy,
  });
}

export async function handleSearch(
  query: string,
  opts: {
    since?: string;
    limit?: string;
    offset?: string;
    full?: boolean;
  } & LocalOpts,
): Promise<void> {
  if (opts.local) {
    const args = ["search", query];
    addOptionalArg(args, "--since", opts.since ?? "7d");
    addOptionalArg(args, "--limit", opts.limit);
    addOptionalArg(args, "--offset", opts.offset);
    if (opts.full) args.push("--full");
    runLocalPanopticon(args);
    return;
  }
  await queryBackend("search-engineering-sessions", {
    query,
    timeRange: opts.since ?? "7d",
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
  });
}
