import { getAuthenticatedClient } from "../fml-client.js";

const APP_BASE_URL = "https://app.fml.app";

export async function handleOpen(opts: { json?: boolean }): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login` first.");
    process.exit(1);
  }

  let slug: string;
  try {
    const orgs = await api.queryOrgs();
    if (orgs.length === 0) {
      console.error("No organizations found.");
      process.exit(1);
    }
    slug = orgs[0].slug ?? orgs[0].name;
  } catch {
    console.error("Could not fetch organizations. Opening base URL.");
    slug = "";
  }

  const url = slug ? `${APP_BASE_URL}/${slug}` : APP_BASE_URL;

  if (opts.json) {
    console.log(JSON.stringify({ url }));
  } else {
    const openBrowser = (await import("open")).default;
    await openBrowser(url);
  }
}
