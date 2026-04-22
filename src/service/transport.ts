import { config } from "../config.js";
import type {
  ActivitySummaryInput,
  CostBreakdownInput,
  FileOverviewInput,
  IntentForCodeInput,
  ListPlansInput,
  ListSessionSummariesInput,
  ListSessionsInput,
  OutcomesForIntentInput,
  PanopticonService,
  PrintInput,
  RecentWorkOnPathInput,
  SearchInput,
  SearchIntentInput,
  SessionSummaryDetailInput,
  SessionTimelineInput,
  SyncTargetAddInput,
  WhyCodeInput,
} from "./types.js";

type TransportHandler = (
  service: PanopticonService,
  params: Record<string, unknown>,
) => Promise<unknown>;

function asType<T>(params: Record<string, unknown>): T {
  return params as unknown as T;
}

const BASE_TOOL_HANDLERS = {
  sessions: (service, params) =>
    service.listSessions(asType<ListSessionsInput>(params)),
  timeline: (service, params) =>
    service.sessionTimeline(asType<SessionTimelineInput>(params)),
  costs: (service, params) =>
    service.costBreakdown(asType<CostBreakdownInput>(params)),
  summary: (service, params) =>
    service.activitySummary(asType<ActivitySummaryInput>(params)),
  plans: (service, params) => service.listPlans(asType<ListPlansInput>(params)),
  search: (service, params) => service.search(asType<SearchInput>(params)),
  get: (service, params) => service.print(asType<PrintInput>(params)),
  query: (service, params) => service.rawQuery((params as { sql: string }).sql),
  status: (service) => service.dbStats(),
  intent_for_code: (service, params) =>
    service.intentForCode(asType<IntentForCodeInput>(params)),
  search_intent: (service, params) =>
    service.searchIntent(asType<SearchIntentInput>(params)),
  outcomes_for_intent: (service, params) =>
    service.outcomesForIntent(asType<OutcomesForIntentInput>(params)),
  why_code: (service, params) => service.whyCode(asType<WhyCodeInput>(params)),
  recent_work_on_path: (service, params) =>
    service.recentWorkOnPath(asType<RecentWorkOnPathInput>(params)),
  file_overview: (service, params) =>
    service.fileOverview(asType<FileOverviewInput>(params)),
} satisfies Record<string, TransportHandler>;

const SESSION_SUMMARY_TOOL_HANDLERS = {
  session_summaries: (service, params) =>
    service.listSessionSummaries(asType<ListSessionSummariesInput>(params)),
  session_summary_detail: (service, params) =>
    service.sessionSummaryDetail(asType<SessionSummaryDetailInput>(params)),
} satisfies Record<string, TransportHandler>;

export const TOOL_HANDLERS = {
  ...BASE_TOOL_HANDLERS,
  ...(config.enableSessionSummaryProjections
    ? SESSION_SUMMARY_TOOL_HANDLERS
    : {}),
} satisfies Record<string, TransportHandler>;

export type ToolName = keyof typeof TOOL_HANDLERS;

export const EXEC_HANDLERS = {
  prune: async (service, params) => {
    const cutoffMs = params.cutoffMs;
    if (typeof cutoffMs !== "number") {
      throw new Error("cutoffMs is required and must be a number");
    }
    if (params.dryRun) {
      return service.pruneEstimate(cutoffMs);
    }
    return service.pruneExecute(cutoffMs, {
      vacuum: params.vacuum === true,
    });
  },
  "refresh-pricing": (service) => service.refreshPricing(),
  scan: (service, params) => service.scan(params as { summaries?: boolean }),
  "sync-reset": (service, params) =>
    service.syncReset(
      typeof params.target === "string" ? params.target : undefined,
    ),
  "sync-watermark-get": (service, params) => {
    const target = params.target;
    if (typeof target !== "string" || target.length === 0) {
      throw new Error("target is required");
    }
    return service.syncWatermarkGet(
      target,
      typeof params.table === "string" ? params.table : undefined,
    );
  },
  "sync-watermark-set": (service, params) => {
    const target = params.target;
    const table = params.table;
    const value = params.value;
    if (typeof target !== "string" || target.length === 0) {
      throw new Error("target is required");
    }
    if (typeof table !== "string" || table.length === 0) {
      throw new Error("table is required");
    }
    if (typeof value !== "number") {
      throw new Error("value must be a number");
    }
    return service.syncWatermarkSet(target, table, value);
  },
  "rebuild-claims-from-raw": (service, params) =>
    service.rebuildClaimsFromRaw({
      sessionId:
        typeof params.sessionId === "string" && params.sessionId.length > 0
          ? params.sessionId
          : undefined,
    }),
  "rebuild-intent-projection-from-claims": (service, params) =>
    service.rebuildIntentProjectionFromClaims({
      sessionId:
        typeof params.sessionId === "string" && params.sessionId.length > 0
          ? params.sessionId
          : undefined,
    }),
  "reconcile-landed-status-from-disk": (service, params) =>
    service.reconcileLandedStatusFromDisk({
      sessionId:
        typeof params.sessionId === "string" && params.sessionId.length > 0
          ? params.sessionId
          : undefined,
    }),
  "claim-evidence-integrity": (service) => service.claimEvidenceIntegrity(),
  "sync-pending": (service, params) => {
    const target = params.target;
    if (typeof target !== "string" || target.length === 0) {
      throw new Error("target is required");
    }
    return service.syncPending(target);
  },
  "sync-target-list": (service) => service.syncTargetList(),
  "sync-target-add": (service, params) =>
    service.syncTargetAdd(asType<SyncTargetAddInput>(params)),
  "sync-target-remove": (service, params) => {
    const name = params.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("name is required");
    }
    return service.syncTargetRemove(name);
  },
} satisfies Record<string, TransportHandler>;

export type ExecName = keyof typeof EXEC_HANDLERS;

export const TOOL_NAMES = Object.keys(TOOL_HANDLERS) as ToolName[];
export const EXEC_NAMES = Object.keys(EXEC_HANDLERS) as ExecName[];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_HANDLERS, name);
}

export function isExecName(name: string): name is ExecName {
  return Object.hasOwn(EXEC_HANDLERS, name);
}

export function dispatchTool(
  service: PanopticonService,
  name: ToolName,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(service, params);
}

export function dispatchExec(
  service: PanopticonService,
  name: ExecName,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return EXEC_HANDLERS[name](service, params);
}
