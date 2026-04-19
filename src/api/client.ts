/**
 * HTTP client for the panopticon server API.
 *
 * Re-exports the default HTTP-backed panopticon service so existing
 * consumers keep the same entrypoint while the transport-neutral
 * service layer lives under src/service.
 */

export {
  activitySummary,
  callExec,
  callTool,
  claimEvidenceIntegrity,
  costBreakdown,
  dbStats,
  httpPanopticonService,
  intentForCode,
  listPlans,
  listSessions,
  outcomesForIntent,
  print,
  pruneEstimate,
  pruneExecute,
  rawQuery,
  rebuildClaimsFromRaw,
  rebuildIntentProjectionFromClaims,
  reconcileLandedStatusFromDisk,
  refreshPricing,
  scan,
  search,
  searchIntent,
  sessionTimeline,
  syncPending,
  syncReset,
  syncTargetAdd,
  syncTargetList,
  syncTargetRemove,
  syncWatermarkGet,
  syncWatermarkSet,
} from "../service/http.js";
export type { ScanResult } from "../service/types.js";
