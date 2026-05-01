/**
 * @fml-inc/panopticon — library API
 *
 * Everything the CLI can do is importable here.
 * The CLI is a thin UI layer over these functions.
 */

export { ensureDataDir } from "./config.js";
export { captureUserConfigSnapshot } from "./config-capture.js";
export { refreshPricing } from "./db/pricing.js";
// ── Maintenance ───────────────────────────────────────────────────────────────
export { autoPrune, pruneEstimate, pruneExecute } from "./db/prune.js";
// ── Queries ───────────────────────────────────────────────────────────────────
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
} from "./db/query.js";
// ── Database ──────────────────────────────────────────────────────────────────
export { closeDb, getDb } from "./db/schema.js";
export type { HookEventRow, OtelLogRow, OtelMetricRow } from "./db/store.js";
export { syncAwarePrune } from "./db/sync-prune.js";
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
// ── Repo ──────────────────────────────────────────────────────────────────────
export { type RepoInfo, resolveRepoFromCwd } from "./repo.js";
// ── Scanner ──────────────────────────────────────────────────────────────────
export {
  type ClaudeCodeConfig,
  type ConfigLayer,
  type PluginHooksSummary,
  readConfig,
  writeFile,
  writeSettings,
} from "./scanner.js";
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
  ChildSession,
  SearchMatch,
  SearchResult,
  Session,
  SessionListResult,
  SessionTimelineResult,
  SpendingGroup,
  SpendingResult,
  TimelineMessage,
  TimelineToolCall,
} from "./types.js";
// ── Config ───────────────────────────────────────────────────────────────────
export {
  loadRetentionConfig,
  loadUnifiedConfig,
  type RetentionConfig,
  saveUnifiedConfig,
  type UnifiedConfig,
} from "./unified-config.js";
