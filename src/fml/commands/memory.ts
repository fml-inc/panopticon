import { getAuthenticatedClient } from "../fml-client.js";

export async function handleMemoryList(opts: {
  scope?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("list-memory-files", {
    scope: opts.scope,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleMemoryRead(fileId: string): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("read-memory-file", { fileId });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleMemoryWrite(opts: {
  title: string;
  content: string;
  scope?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("write-memory-file", {
    title: opts.title,
    content: opts.content,
    scope: opts.scope,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleMemoryDelete(fileId: string): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("delete-memory-file", { fileId });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}
