import type { StorageDiagnostics } from "../db/storage-diagnostics.js";
import type { SyncPendingResult } from "../sync/pending.js";
import type {
  ActivitySummaryResult,
  HookTimelineResult,
  SearchResult,
  SessionListResult,
  SessionTimelineResult,
  SpendingResult,
} from "../types.js";

export type { StorageDiagnostics } from "../db/storage-diagnostics.js";
export type { SyncPendingResult } from "../sync/pending.js";

export interface ListSessionsInput {
  limit?: number;
  since?: string;
}

export interface SessionTimelineInput {
  sessionId: string;
  limit?: number;
  offset?: number;
  fullPayloads?: boolean;
}

export interface HookTimelineInput {
  /** When omitted, returns events across all sessions (audit mode). */
  sessionId?: string;
  since?: string;
  /** Restrict to specific hook event types (e.g. ["UserPromptSubmit", "ExitPlanMode"]). */
  eventTypes?: string[];
  limit?: number;
  offset?: number;
}

export interface CostBreakdownInput {
  since?: string;
  groupBy?: "session" | "model" | "day";
}

export interface ActivitySummaryInput {
  since?: string;
}

export interface ListPlansInput {
  session_id?: string;
  since?: string;
  limit?: number;
}

export interface SearchInput {
  query: string;
  eventTypes?: string[];
  since?: string;
  limit?: number;
  offset?: number;
  fullPayloads?: boolean;
}

export interface PrintInput {
  source: "hook" | "otel" | "message";
  id: number;
}

export interface IntentForCodeInput {
  file_path: string;
  limit?: number;
}

export interface SearchIntentInput {
  query: string;
  only_landed?: boolean;
  repository?: string;
  limit?: number;
  offset?: number;
}

export interface OutcomesForIntentInput {
  intent_unit_id: number;
}

export interface ListSessionSummariesInput {
  repository?: string;
  cwd?: string;
  status?: "active" | "landed" | "mixed" | "read-only" | "unlanded";
  path?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface SessionSummaryDetailInput {
  session_id: string;
}

export interface WhyCodeInput {
  path: string;
  line?: number;
  repository?: string;
}

export interface RecentWorkOnPathInput {
  path: string;
  repository?: string;
  limit?: number;
}

export interface FileOverviewInput {
  path: string;
  repository?: string;
  recent_limit?: number;
  related_limit?: number;
}

export interface PruneExecuteInput {
  vacuum?: boolean;
}

export interface ScanInput {
  summaries?: boolean;
}

export interface ScanResult {
  filesScanned: number;
  newTurns: number;
  summariesUpdated: number;
}

export interface RegenerateSessionSummariesInput {
  sessionId?: string;
  cwd?: string;
  repository?: string;
  since?: string;
  before?: string;
  by?: "activity" | "generated-at" | "projected-at";
  reason?: string;
  all?: boolean;
  staleOnly?: boolean;
  dirtyOnly?: boolean;
  cleanOnly?: boolean;
  dryRun?: boolean;
  limit?: number;
}

export interface SyncTargetAddInput {
  name: string;
  url: string;
  token?: string;
  tokenCommand?: string;
}

export interface RebuildClaimsInput {
  sessionId?: string;
}

export interface RebuildIntentProjectionInput {
  sessionId?: string;
}

export interface ReconcileLandedStatusInput {
  sessionId?: string;
}

export interface PanopticonService {
  listSessions(opts?: ListSessionsInput): Promise<SessionListResult>;
  sessionTimeline(opts: SessionTimelineInput): Promise<SessionTimelineResult>;
  hookTimeline(opts?: HookTimelineInput): Promise<HookTimelineResult>;
  costBreakdown(opts?: CostBreakdownInput): Promise<SpendingResult>;
  activitySummary(opts?: ActivitySummaryInput): Promise<ActivitySummaryResult>;
  listPlans(opts?: ListPlansInput): Promise<unknown>;
  search(opts: SearchInput): Promise<SearchResult>;
  print(opts: PrintInput): Promise<unknown>;
  rawQuery(sql: string): Promise<unknown>;
  dbStats(): Promise<unknown>;
  intentForCode(opts: IntentForCodeInput): Promise<unknown>;
  searchIntent(opts: SearchIntentInput): Promise<unknown>;
  outcomesForIntent(opts: OutcomesForIntentInput): Promise<unknown>;
  listSessionSummaries(opts?: ListSessionSummariesInput): Promise<unknown>;
  sessionSummaryDetail(opts: SessionSummaryDetailInput): Promise<unknown>;
  whyCode(opts: WhyCodeInput): Promise<unknown>;
  recentWorkOnPath(opts: RecentWorkOnPathInput): Promise<unknown>;
  fileOverview(opts: FileOverviewInput): Promise<unknown>;
  storageDiagnostics(): Promise<StorageDiagnostics>;
  pruneEstimate(cutoffMs: number): Promise<unknown>;
  pruneExecute(cutoffMs: number, opts?: PruneExecuteInput): Promise<unknown>;
  refreshPricing(): Promise<unknown>;
  scan(opts?: ScanInput): Promise<ScanResult>;
  regenerateSessionSummaries(
    opts?: RegenerateSessionSummariesInput,
  ): Promise<unknown>;
  syncReset(target?: string): Promise<unknown>;
  syncWatermarkGet(target: string, table?: string): Promise<unknown>;
  syncWatermarkSet(
    target: string,
    table: string,
    value: number,
  ): Promise<unknown>;
  rebuildClaimsFromRaw(opts?: RebuildClaimsInput): Promise<unknown>;
  rebuildIntentProjectionFromClaims(
    opts?: RebuildIntentProjectionInput,
  ): Promise<unknown>;
  reconcileLandedStatusFromDisk(
    opts?: ReconcileLandedStatusInput,
  ): Promise<unknown>;
  claimEvidenceIntegrity(): Promise<unknown>;
  syncPending(target: string): Promise<SyncPendingResult>;
  syncTargetList(): Promise<unknown>;
  syncTargetAdd(target: SyncTargetAddInput): Promise<unknown>;
  syncTargetRemove(name: string): Promise<unknown>;
}
