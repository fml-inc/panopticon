/**
 * HTTP client for the panopticon server API.
 *
 * Provides typed wrappers around POST /api/tool and POST /api/exec
 * so that CLI and MCP can query the server instead of opening the
 * database directly.
 */
import http from "node:http";
import { config } from "../config.js";
import type {
  ActivitySummaryResult,
  SearchResult,
  SessionListResult,
  SessionTimelineResult,
  SpendingResult,
} from "../types.js";

// ── Core transport ───────────────────────────────────────────────────────────

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

// ── Tool calls (read-only) ──────────────────────────────────────────────────

const TOOL_TIMEOUT = 30_000;

export function callTool(
  name: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return post("/api/tool", { name, params }, TOOL_TIMEOUT);
}

export function listSessions(opts?: {
  limit?: number;
  since?: string;
}): Promise<SessionListResult> {
  return callTool(
    "sessions",
    opts as Record<string, unknown>,
  ) as Promise<SessionListResult>;
}

export function sessionTimeline(opts: {
  sessionId: string;
  limit?: number;
  offset?: number;
  fullPayloads?: boolean;
}): Promise<SessionTimelineResult> {
  return callTool(
    "timeline",
    opts as Record<string, unknown>,
  ) as Promise<SessionTimelineResult>;
}

export function costBreakdown(opts?: {
  since?: string;
  groupBy?: "session" | "model" | "day";
}): Promise<SpendingResult> {
  return callTool(
    "costs",
    opts as Record<string, unknown>,
  ) as Promise<SpendingResult>;
}

export function activitySummary(opts?: {
  since?: string;
}): Promise<ActivitySummaryResult> {
  return callTool(
    "summary",
    opts as Record<string, unknown>,
  ) as Promise<ActivitySummaryResult>;
}

export function listPlans(opts?: {
  session_id?: string;
  since?: string;
  limit?: number;
}): Promise<unknown> {
  return callTool("plans", opts as Record<string, unknown>);
}

export function search(opts: {
  query: string;
  eventTypes?: string[];
  since?: string;
  limit?: number;
  offset?: number;
  fullPayloads?: boolean;
}): Promise<SearchResult> {
  return callTool(
    "search",
    opts as Record<string, unknown>,
  ) as Promise<SearchResult>;
}

export function print(opts: {
  source: "hook" | "otel" | "message";
  id: number;
}): Promise<unknown> {
  return callTool("get", opts as Record<string, unknown>);
}

export function rawQuery(sql: string): Promise<unknown> {
  return callTool("query", { sql });
}

export function dbStats(): Promise<unknown> {
  return callTool("status");
}

export function intentForCode(opts: {
  file_path: string;
  limit?: number;
}): Promise<unknown> {
  return callTool("intent_for_code", opts as Record<string, unknown>);
}

export function searchIntent(opts: {
  query: string;
  only_landed?: boolean;
  repository?: string;
  limit?: number;
  offset?: number;
}): Promise<unknown> {
  return callTool("search_intent", opts as Record<string, unknown>);
}

export function outcomesForIntent(opts: {
  intent_unit_id: number;
}): Promise<unknown> {
  return callTool("outcomes_for_intent", opts as Record<string, unknown>);
}

export function diffIntentProjectionV1VsV2(opts?: {
  session_id?: string;
  limit?: number;
  shared_sessions_only?: boolean;
}): Promise<unknown> {
  return callTool(
    "diff_intent_projection_v1_vs_v2",
    opts as Record<string, unknown>,
  );
}

// ── Exec calls (write operations, CLI only) ─────────────────────────────────

const EXEC_TIMEOUT = 60_000;

export function callExec(
  command: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return post("/api/exec", { command, params }, EXEC_TIMEOUT);
}

export function pruneEstimate(cutoffMs: number): Promise<unknown> {
  return callExec("prune", { cutoffMs, dryRun: true });
}

export function pruneExecute(
  cutoffMs: number,
  opts?: { vacuum?: boolean },
): Promise<unknown> {
  return callExec("prune", { cutoffMs, ...opts });
}

export function refreshPricing(): Promise<unknown> {
  return callExec("refresh-pricing");
}

export interface ScanResult {
  filesScanned: number;
  newTurns: number;
  summariesUpdated: number;
}

export function scan(opts?: { summaries?: boolean }): Promise<ScanResult> {
  return callExec("scan", opts ?? {}) as Promise<ScanResult>;
}

export function syncReset(target?: string): Promise<unknown> {
  return callExec("sync-reset", target ? { target } : {});
}

export function rebuildClaimsFromRaw(opts?: {
  sessionId?: string;
}): Promise<unknown> {
  return callExec("rebuild-claims-from-raw", opts ?? {});
}

export function rebuildIntentProjectionFromClaims(opts?: {
  sessionId?: string;
}): Promise<unknown> {
  return callExec("rebuild-intent-projection-from-claims", opts ?? {});
}

export function reconcileLandedStatusFromDisk(opts?: {
  sessionId?: string;
}): Promise<unknown> {
  return callExec("reconcile-landed-status-from-disk", opts ?? {});
}

export function claimEvidenceIntegrity(): Promise<unknown> {
  return callExec("claim-evidence-integrity");
}

export function syncWatermarkGet(
  target: string,
  table?: string,
): Promise<unknown> {
  return callExec("sync-watermark-get", { target, table });
}

export function syncWatermarkSet(
  target: string,
  table: string,
  value: number,
): Promise<unknown> {
  return callExec("sync-watermark-set", { target, table, value });
}

export function syncPending(target: string): Promise<{
  target: string;
  totalPending: number;
  tables: Record<string, { total: number; synced: number; pending: number }>;
}> {
  return callExec("sync-pending", { target }) as Promise<{
    target: string;
    totalPending: number;
    tables: Record<string, { total: number; synced: number; pending: number }>;
  }>;
}

export function syncTargetList(): Promise<unknown> {
  return callExec("sync-target-list");
}

export function syncTargetAdd(target: {
  name: string;
  url: string;
  token?: string;
  tokenCommand?: string;
}): Promise<unknown> {
  return callExec("sync-target-add", target as Record<string, unknown>);
}

export function syncTargetRemove(name: string): Promise<unknown> {
  return callExec("sync-target-remove", { name });
}
