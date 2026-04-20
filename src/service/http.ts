import http from "node:http";
import { config } from "../config.js";
import type {
  ActivitySummaryResult,
  SearchResult,
  SessionListResult,
  SessionTimelineResult,
  SpendingResult,
} from "../types.js";
import type { ExecName, ToolName } from "./transport.js";
import type {
  PanopticonService,
  ScanResult,
  SyncPendingResult,
} from "./types.js";

function toParams(value: unknown): Record<string, unknown> | undefined {
  return value as Record<string, unknown> | undefined;
}

function post(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request(
      {
        hostname: config.host,
        port: config.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(json),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            reject(
              new Error(
                `Invalid JSON response from server: ${text.slice(0, 200)}`,
              ),
            );
            return;
          }
          if (
            res.statusCode &&
            res.statusCode >= 400 &&
            typeof parsed === "object" &&
            parsed !== null &&
            "error" in parsed
          ) {
            reject(new Error((parsed as { error: string }).error));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") {
        reject(
          new Error(
            "Panopticon server is not running. Start with: panopticon start",
          ),
        );
        return;
      }
      reject(err);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request to panopticon server timed out"));
    });
    req.write(json);
    req.end();
  });
}

const TOOL_TIMEOUT = 30_000;
const EXEC_TIMEOUT = 60_000;

export function callTool(
  name: ToolName,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return post("/api/tool", { name, params }, TOOL_TIMEOUT);
}

export function callExec(
  command: ExecName,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return post("/api/exec", { command, params }, EXEC_TIMEOUT);
}

export const httpPanopticonService: PanopticonService = {
  listSessions: (opts) =>
    callTool("sessions", toParams(opts)) as Promise<SessionListResult>,
  sessionTimeline: (opts) =>
    callTool("timeline", toParams(opts)) as Promise<SessionTimelineResult>,
  costBreakdown: (opts) =>
    callTool("costs", toParams(opts)) as Promise<SpendingResult>,
  activitySummary: (opts) =>
    callTool("summary", toParams(opts)) as Promise<ActivitySummaryResult>,
  listPlans: (opts) => callTool("plans", toParams(opts)),
  search: (opts) => callTool("search", toParams(opts)) as Promise<SearchResult>,
  print: (opts) => callTool("get", toParams(opts)),
  rawQuery: (sql) => callTool("query", { sql }),
  dbStats: () => callTool("status"),
  intentForCode: (opts) => callTool("intent_for_code", toParams(opts)),
  searchIntent: (opts) => callTool("search_intent", toParams(opts)),
  outcomesForIntent: (opts) => callTool("outcomes_for_intent", toParams(opts)),
  listSessionSummaries: (opts) => callTool("session_summaries", toParams(opts)),
  sessionSummaryDetail: (opts) =>
    callTool("session_summary_detail", toParams(opts)),
  whyCode: (opts) => callTool("why_code", toParams(opts)),
  recentWorkOnPath: (opts) => callTool("recent_work_on_path", toParams(opts)),
  pruneEstimate: (cutoffMs) => callExec("prune", { cutoffMs, dryRun: true }),
  pruneExecute: (cutoffMs, opts) => callExec("prune", { cutoffMs, ...opts }),
  refreshPricing: () => callExec("refresh-pricing"),
  scan: (opts) => callExec("scan", toParams(opts) ?? {}) as Promise<ScanResult>,
  syncReset: (target) => callExec("sync-reset", target ? { target } : {}),
  syncWatermarkGet: (target, table) =>
    callExec("sync-watermark-get", { target, table }),
  syncWatermarkSet: (target, table, value) =>
    callExec("sync-watermark-set", { target, table, value }),
  rebuildClaimsFromRaw: (opts) =>
    callExec("rebuild-claims-from-raw", toParams(opts) ?? {}),
  rebuildIntentProjectionFromClaims: (opts) =>
    callExec("rebuild-intent-projection-from-claims", toParams(opts) ?? {}),
  reconcileLandedStatusFromDisk: (opts) =>
    callExec("reconcile-landed-status-from-disk", toParams(opts) ?? {}),
  claimEvidenceIntegrity: () => callExec("claim-evidence-integrity"),
  syncPending: (target) =>
    callExec("sync-pending", { target }) as Promise<SyncPendingResult>,
  syncTargetList: () => callExec("sync-target-list"),
  syncTargetAdd: (target) => callExec("sync-target-add", toParams(target)),
  syncTargetRemove: (name) => callExec("sync-target-remove", { name }),
};

export const listSessions = httpPanopticonService.listSessions;
export const sessionTimeline = httpPanopticonService.sessionTimeline;
export const costBreakdown = httpPanopticonService.costBreakdown;
export const activitySummary = httpPanopticonService.activitySummary;
export const listPlans = httpPanopticonService.listPlans;
export const search = httpPanopticonService.search;
export const print = httpPanopticonService.print;
export const rawQuery = httpPanopticonService.rawQuery;
export const dbStats = httpPanopticonService.dbStats;
export const intentForCode = httpPanopticonService.intentForCode;
export const searchIntent = httpPanopticonService.searchIntent;
export const outcomesForIntent = httpPanopticonService.outcomesForIntent;
export const listSessionSummaries = httpPanopticonService.listSessionSummaries;
export const sessionSummaryDetail = httpPanopticonService.sessionSummaryDetail;
export const whyCode = httpPanopticonService.whyCode;
export const recentWorkOnPath = httpPanopticonService.recentWorkOnPath;
export const pruneEstimate = httpPanopticonService.pruneEstimate;
export const pruneExecute = httpPanopticonService.pruneExecute;
export const refreshPricing = httpPanopticonService.refreshPricing;
export const scan = httpPanopticonService.scan;
export const syncReset = httpPanopticonService.syncReset;
export const syncWatermarkGet = httpPanopticonService.syncWatermarkGet;
export const syncWatermarkSet = httpPanopticonService.syncWatermarkSet;
export const rebuildClaimsFromRaw = httpPanopticonService.rebuildClaimsFromRaw;
export const rebuildIntentProjectionFromClaims =
  httpPanopticonService.rebuildIntentProjectionFromClaims;
export const reconcileLandedStatusFromDisk =
  httpPanopticonService.reconcileLandedStatusFromDisk;
export const claimEvidenceIntegrity =
  httpPanopticonService.claimEvidenceIntegrity;
export const syncPending = httpPanopticonService.syncPending;
export const syncTargetList = httpPanopticonService.syncTargetList;
export const syncTargetAdd = httpPanopticonService.syncTargetAdd;
export const syncTargetRemove = httpPanopticonService.syncTargetRemove;
