import type {
  ActivitySummaryResult,
  SearchResult,
  SessionListResult,
  SessionTimelineResult,
  SpendingResult,
} from "../types.js";

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

export interface ListWorkstreamsInput {
  repository?: string;
  cwd?: string;
  status?: "active" | "landed" | "mixed" | "abandoned";
  path?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface WorkstreamDetailInput {
  workstream_id: number;
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

export interface SyncPendingResult {
  target: string;
  totalPending: number;
  tables: Record<string, { total: number; synced: number; pending: number }>;
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
  listWorkstreams(opts?: ListWorkstreamsInput): Promise<unknown>;
  workstreamDetail(opts: WorkstreamDetailInput): Promise<unknown>;
  whyCode(opts: WhyCodeInput): Promise<unknown>;
  recentWorkOnPath(opts: RecentWorkOnPathInput): Promise<unknown>;
  pruneEstimate(cutoffMs: number): Promise<unknown>;
  pruneExecute(cutoffMs: number, opts?: PruneExecuteInput): Promise<unknown>;
  refreshPricing(): Promise<unknown>;
  scan(opts?: ScanInput): Promise<ScanResult>;
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
