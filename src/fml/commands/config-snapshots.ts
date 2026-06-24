import { getAuthenticatedClient } from "../fml-client.js";

export async function handleConfigList(opts: {
  org: string;
  repo?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  try {
    const result = opts.repo
      ? await api.listRepoConfigSnapshots(opts.org, opts.repo)
      : await api.listUserConfigSnapshots(opts.org);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export async function handleConfigDetail(opts: {
  org: string;
  user?: string;
  repo?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  try {
    const result = opts.repo
      ? await api.getRepoConfigDetail(opts.org, opts.repo)
      : opts.user
        ? await api.getUserConfigDetail(opts.org, opts.user)
        : null;
    if (!result) {
      console.error("Provide --user or --repo");
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
