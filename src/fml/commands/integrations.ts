import { getAuthenticatedClient } from "../fml-client.js";

export async function handleIntegrations(): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("list-integrations", {});
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleEvents(opts: {
  source?: string;
  eventType?: string;
  projectId?: string;
  since?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("get-integration-events", {
    source: opts.source,
    eventType: opts.eventType,
    projectId: opts.projectId,
    timeRange: opts.since,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleResolveIdentity(opts: {
  provider?: string;
  username?: string;
  email?: string;
  externalId?: string;
  externalUserId?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("resolve-identities", {
    provider: opts.provider,
    externalUsername: opts.username,
    normalizedEmail: opts.email,
    externalId: opts.externalId,
    externalUserId: opts.externalUserId,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}
