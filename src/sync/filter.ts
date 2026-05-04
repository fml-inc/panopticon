import { getDb } from "../db/schema.js";
import type { SyncFilter } from "./types.js";

function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === "*/*") return true;
  if (pattern.endsWith("/*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

/** Returns true if the repository passes the include/exclude filter. */
export function repoMatchesFilter(
  repository: string,
  filter?: SyncFilter,
): boolean {
  if (!filter) return true;
  if (filter.excludeRepos?.some((p) => matchesGlob(repository, p))) {
    return false;
  }
  if (filter.includeRepos?.length) {
    if (!filter.includeRepos.some((p) => matchesGlob(repository, p))) {
      return false;
    }
  }
  return true;
}

/** Set of session IDs that have repo attribution matching the filter. */
export function buildSyncableSessionIds(
  filter?: SyncFilter,
): Set<string> | null {
  const requireRepo = filter?.requireRepo ?? true;
  if (!requireRepo && !filter?.includeRepos?.length) return null;

  const db = getDb();
  const rows = db
    .prepare(
      "SELECT DISTINCT sr.session_id, sr.repository FROM session_repositories sr",
    )
    .all() as Array<{ session_id: string; repository: string }>;

  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (!repoMatchesFilter(row.repository, filter)) continue;
    sessionIds.add(row.session_id);
  }

  return sessionIds;
}
