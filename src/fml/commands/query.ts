/**
 * Unified provider query command.
 * Routes requests to the appropriate backend tool based on provider and endpoint.
 */

import { getAuthenticatedClient } from "../fml-client.js";

const GENERIC_PROVIDERS = [
  "sentry",
  "slack",
  "github",
  "linear",
  "notion",
  "freshdesk",
  "stripe",
];

const POSTHOG_ENDPOINTS: Record<string, string> = {
  insights: "query-posthog-insights",
  events: "query-posthog-events",
  recordings: "query-posthog-recordings",
  "feature-flags": "query-posthog-feature-flags",
  experiments: "query-posthog-experiments",
  surveys: "query-posthog-surveys",
  hogql: "run-posthog-hogql",
  cohorts: "query-posthog-cohorts",
};

const AMPLITUDE_ENDPOINTS: Record<string, string> = {
  events: "query-amplitude-events",
  funnel: "query-amplitude-funnel",
  retention: "query-amplitude-retention",
  chart: "get-amplitude-chart",
  "list-events": "list-amplitude-events",
};

const META_ADS_ENDPOINTS: Record<string, string> = {
  accounts: "list-meta-ad-accounts",
  campaigns: "list-meta-campaigns",
  insights: "get-meta-ad-insights",
  "ad-sets": "list-meta-ad-sets",
};

function parseBody(body?: string): Record<string, unknown> {
  if (!body) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    console.error("Invalid JSON in --body argument.");
    process.exit(1);
  }
}

export async function handleQuery(
  provider: string,
  endpoint: string,
  opts: { method?: string; body?: string; projectId?: string },
): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }

  const parsedBody = parseBody(opts.body);
  let toolName: string;
  let args: Record<string, unknown>;

  if (GENERIC_PROVIDERS.includes(provider)) {
    toolName = `integration-${provider}`;
    args = {
      endpoint,
      method: opts.method || "GET",
      body: parsedBody,
      projectId: opts.projectId,
    };
  } else if (provider === "posthog") {
    toolName = POSTHOG_ENDPOINTS[endpoint];
    if (!toolName) {
      console.error(
        `Unknown posthog endpoint: ${endpoint}. Valid: ${Object.keys(POSTHOG_ENDPOINTS).join(", ")}`,
      );
      process.exit(1);
    }
    args = { ...parsedBody };
  } else if (provider === "amplitude") {
    toolName = AMPLITUDE_ENDPOINTS[endpoint];
    if (!toolName) {
      console.error(
        `Unknown amplitude endpoint: ${endpoint}. Valid: ${Object.keys(AMPLITUDE_ENDPOINTS).join(", ")}`,
      );
      process.exit(1);
    }
    // list-events takes no args — --body is ignored for this endpoint
    args = endpoint === "list-events" ? {} : { ...parsedBody };
  } else if (provider === "meta-ads") {
    toolName = META_ADS_ENDPOINTS[endpoint];
    if (!toolName) {
      console.error(
        `Unknown meta-ads endpoint: ${endpoint}. Valid: ${Object.keys(META_ADS_ENDPOINTS).join(", ")}`,
      );
      process.exit(1);
    }
    // accounts takes no args — --body is ignored for this endpoint
    args = endpoint === "accounts" ? {} : { ...parsedBody };
  } else {
    console.error(
      `Unknown provider: ${provider}. Valid: ${[...GENERIC_PROVIDERS, "posthog", "amplitude", "meta-ads"].join(", ")}`,
    );
    process.exit(1);
  }

  const result = await api.callBackend(toolName, args);
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }

  console.log(JSON.stringify(result.result, null, 2));
}
