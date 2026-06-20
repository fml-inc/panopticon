import {
  getSelectedOrg,
  getValidToken,
  setSelectedOrg,
} from "../auth/token-store.js";
import { createFmlClient } from "../fml-client.js";

export async function handleOrg(slug?: string): Promise<void> {
  const token = await getValidToken();
  if (!token) {
    console.error("Not logged in. Run `fml login` first.");
    process.exit(1);
  }

  const api = createFmlClient(token);
  const orgs = await api.queryOrgs();

  if (orgs.length === 0) {
    console.error("No organizations found.");
    process.exit(1);
  }

  const current = getSelectedOrg();

  // No slug provided — show current selection and available orgs
  if (!slug) {
    console.log("Organizations:\n");
    for (const org of orgs) {
      const orgSlug = org.slug ?? org.name;
      const marker = orgSlug === current ? " (selected)" : "";
      console.log(`  ${orgSlug}${marker}`);
    }
    if (!current) {
      console.log("\nNo org selected. Run `fml org <slug>` to select one.");
    }
    return;
  }

  // Slug provided — select it
  const match = orgs.find(
    (o) => (o.slug ?? o.name) === slug || o.name === slug,
  );
  if (!match) {
    console.error(
      `Organization "${slug}" not found. Available: ${orgs.map((o) => o.slug ?? o.name).join(", ")}`,
    );
    process.exit(1);
  }

  const matchSlug = match.slug ?? match.name;
  setSelectedOrg(matchSlug);
  console.log(`Selected org: ${match.name} (${matchSlug})`);
}
