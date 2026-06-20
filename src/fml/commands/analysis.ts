import { getAuthenticatedClient } from "../fml-client.js";

export async function handleSearchAnalysis(
  query: string,
  opts: {
    status?: string;
    limit?: string;
    repoId?: string;
    promptKey?: string;
  },
): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("search-analysis", {
    query,
    status: opts.status,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    promptKey: opts.promptKey,
    ...(opts.repoId ? { repositoryId: opts.repoId } : {}),
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleRunAnalysis(opts: {
  prompts?: string;
  repoId?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("run-analysis-workflow", {
    selectedPromptKeys: opts.prompts?.split(","),
    // Only include repositoryId when the user actually passed --repo-id,
    // so the payload matches the MCP-side schema shape (undefined key is
    // technically equivalent but makes log diffs noisier).
    ...(opts.repoId ? { repositoryId: opts.repoId } : {}),
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleRunTeamAnalysis(opts: {
  windowDays?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("run-team-analysis", {
    windowDays: opts.windowDays ? parseInt(opts.windowDays, 10) : undefined,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}
