/**
 * @fml-inc/panopticon — library API
 *
 * Everything the CLI can do is importable here.
 * The CLI is a thin UI layer over these functions.
 */

export { ensureDataDir } from "./config.js";
export { refreshPricing } from "./db/pricing.js";
// ── Maintenance ───────────────────────────────────────────────────────────────
export { autoPrune, pruneEstimate, pruneExecute } from "./db/prune.js";
// ── Queries ───────────────────────────────────────────────────────────────────
export {
  activitySummary,
  costBreakdown,
  dbStats,
  getEvent,
  listPlans,
  listSessions,
  rawQuery,
  searchEvents,
  sessionTimeline,
  toolStats,
} from "./db/query.js";
// ── Database ──────────────────────────────────────────────────────────────────
export { closeDb, getDb } from "./db/schema.js";
export type { HookEventRow, OtelLogRow, OtelMetricRow } from "./db/store.js";
// ── Doctor ────────────────────────────────────────────────────────────────────
export {
  type CheckResult,
  type DoctorResult,
  doctor,
  type RecentError,
  type RecentEvent,
} from "./doctor.js";
// ── Permissions ───────────────────────────────────────────────────────────────
export { permissionsApply, permissionsShow } from "./mcp/permissions.js";
// ── Server ────────────────────────────────────────────────────────────────────
export { createUnifiedServer } from "./server.js";
// ── Setup / Install ───────────────────────────────────────────────────────────
export {
  config,
  configureShellEnv,
  fetchPricing,
  initDb,
  type ShellEnvOptions,
} from "./setup.js";
// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  ActivitySessionDetail,
  ActivitySummaryResult,
  SearchMatch,
  SearchResult,
  Session,
  SessionListResult,
  SessionTimelineResult,
  SpendingGroup,
  SpendingResult,
  TimelineEvent,
} from "./types.js";
