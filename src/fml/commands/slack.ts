import { getAuthenticatedClient } from "../fml-client.js";

export async function handleSlackHistory(opts: {
  channel?: string;
  limit?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("get-slack-channel-history", {
    channelId: opts.channel,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleSlackMessage(opts: {
  permalink?: string;
  channel?: string;
  ts?: string;
  includeThread?: boolean;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("get-slack-message", {
    permalink: opts.permalink,
    channelId: opts.channel,
    messageTs: opts.ts,
    includeThreadContext: opts.includeThread,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}
