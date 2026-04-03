/**
 * Public query API for external consumers.
 *
 * Re-exports query functions that return unified types, suitable for
 * use by fml-plugin and other consumers that need to query panopticon data.
 */

export {
  activitySummary,
  costBreakdown,
  dbStats,
  listPlans,
  listSessions,
  print,
  rawQuery,
  search,
  sessionTimeline,
  toolStats,
} from "./db/query.js";
