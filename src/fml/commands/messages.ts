import { getAuthenticatedClient } from "../fml-client.js";

export async function handleMessagesList(opts: {
  start?: string;
  end?: string;
  limit?: string;
  cursor?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("list-messages", {
    startTime: opts.start ? parseInt(opts.start, 10) : undefined,
    endTime: opts.end ? parseInt(opts.end, 10) : undefined,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    cursor: opts.cursor,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleMessagesContext(
  messageId: string,
  opts: { before?: string; after?: string },
): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("list-messages-with-context", {
    messageId,
    before: opts.before ? parseInt(opts.before, 10) : undefined,
    after: opts.after ? parseInt(opts.after, 10) : undefined,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}
