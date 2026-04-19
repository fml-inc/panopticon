import { rebuildActiveClaims } from "../claims/canonicalize.js";
import { runIntegrityCheck } from "../claims/integrity.js";
import { refreshPricing as refreshPricingDirect } from "../db/pricing.js";
import { pruneEstimate, pruneExecute } from "../db/prune.js";
import {
  activitySummary,
  costBreakdown,
  dbStats,
  listPlans,
  listSessions,
  print,
  rawQuery,
  search,
  sessionTimeline,
} from "../db/query.js";
import { getDb } from "../db/schema.js";
import { rebuildIntentClaimsFromHooks } from "../intent/asserters/from_hooks.js";
import { rebuildIntentClaimsFromScanner } from "../intent/asserters/from_scanner.js";
import { reconcileLandedClaimsFromDisk } from "../intent/asserters/landed_from_disk.js";
import { rebuildIntentProjection } from "../intent/project.js";
import {
  intentForCode,
  outcomesForIntent,
  searchIntent,
} from "../intent/query.js";
import { log } from "../log.js";
import { scanOnce } from "../scanner/index.js";
import { generateSummariesOnce } from "../summary/index.js";
import { addTarget, listTargets, removeTarget } from "../sync/config.js";
import { TABLE_SYNC_REGISTRY } from "../sync/registry.js";
import type { SyncTarget } from "../sync/types.js";
import {
  readWatermark,
  resetWatermarks,
  watermarkKey,
  writeWatermark,
} from "../sync/watermark.js";
import {
  listWorkstreams,
  recentWorkOnPath,
  whyCode,
  workstreamDetail,
} from "../workstreams/query.js";
import type {
  PanopticonService,
  PruneExecuteInput,
  RebuildClaimsInput,
  RebuildIntentProjectionInput,
  ReconcileLandedStatusInput,
  ScanInput,
  ScanResult,
  SyncPendingResult,
  SyncTargetAddInput,
} from "./types.js";

export function createDirectPanopticonService(): PanopticonService {
  return {
    async listSessions(opts) {
      return listSessions(opts);
    },
    async sessionTimeline(opts) {
      return sessionTimeline(opts);
    },
    async costBreakdown(opts) {
      return costBreakdown(opts);
    },
    async activitySummary(opts) {
      return activitySummary(opts);
    },
    async listPlans(opts) {
      return listPlans(opts);
    },
    async search(opts) {
      return search(opts);
    },
    async print(opts) {
      return print(opts);
    },
    async rawQuery(sql) {
      return rawQuery(sql);
    },
    async dbStats() {
      return dbStats();
    },
    async intentForCode(opts) {
      return intentForCode(opts);
    },
    async searchIntent(opts) {
      return searchIntent(opts);
    },
    async outcomesForIntent(opts) {
      return outcomesForIntent(opts);
    },
    async listWorkstreams(opts) {
      return listWorkstreams(opts);
    },
    async workstreamDetail(opts) {
      return workstreamDetail(opts);
    },
    async whyCode(opts) {
      return whyCode(opts);
    },
    async recentWorkOnPath(opts) {
      return recentWorkOnPath(opts);
    },
    async pruneEstimate(cutoffMs) {
      return pruneEstimate(cutoffMs);
    },
    async pruneExecute(cutoffMs, opts?: PruneExecuteInput) {
      const result = pruneExecute(cutoffMs);
      if (opts?.vacuum) {
        const db = getDb();
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.exec("VACUUM");
      }
      return result;
    },
    async refreshPricing() {
      return refreshPricingDirect();
    },
    async scan(opts?: ScanInput): Promise<ScanResult> {
      const result = scanOnce();
      let summariesUpdated = 0;
      if (opts?.summaries !== false) {
        try {
          summariesUpdated = generateSummariesOnce((msg) =>
            log.scanner.info(msg),
          ).updated;
        } catch (err) {
          log.scanner.error(
            `scan exec: summary generation failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      return {
        filesScanned: result.filesScanned,
        newTurns: result.newTurns,
        summariesUpdated,
      };
    },
    async syncReset(target?: string) {
      resetWatermarks(target);
      return { ok: true, target: target ?? "all" };
    },
    async syncWatermarkGet(target: string, table?: string) {
      if (table) {
        return {
          key: watermarkKey(table, target),
          value: readWatermark(watermarkKey(table, target)),
        };
      }
      const watermarks: Record<string, number> = {};
      for (const desc of TABLE_SYNC_REGISTRY) {
        const key = watermarkKey(desc.table, target);
        watermarks[desc.table] = readWatermark(key);
      }
      return { target, watermarks };
    },
    async syncWatermarkSet(target: string, table: string, value: number) {
      const key = watermarkKey(table, target);
      writeWatermark(key, value);
      return { key, value };
    },
    async rebuildClaimsFromRaw(opts?: RebuildClaimsInput) {
      const scanner = rebuildIntentClaimsFromScanner({
        sessionId: opts?.sessionId,
      });
      const hooks = rebuildIntentClaimsFromHooks({
        sessionId: opts?.sessionId,
      });
      const activeHeads = rebuildActiveClaims();
      return { scanner, hooks, activeHeads };
    },
    async rebuildIntentProjectionFromClaims(
      opts?: RebuildIntentProjectionInput,
    ) {
      return rebuildIntentProjection({ sessionId: opts?.sessionId });
    },
    async reconcileLandedStatusFromDisk(opts?: ReconcileLandedStatusInput) {
      const landed = reconcileLandedClaimsFromDisk({
        sessionId: opts?.sessionId,
      });
      const activeHeads = rebuildActiveClaims();
      return { landed, activeHeads };
    },
    async claimEvidenceIntegrity() {
      return runIntegrityCheck();
    },
    async syncPending(target: string): Promise<SyncPendingResult> {
      const db = getDb();

      const wmColumns: Record<string, string> = {
        messages: "wm_messages",
        tool_calls: "wm_tool_calls",
        scanner_turns: "wm_scanner_turns",
        scanner_events: "wm_scanner_events",
        hook_events: "wm_hook_events",
        otel_logs: "wm_otel_logs",
        otel_metrics: "wm_otel_metrics",
        otel_spans: "wm_otel_spans",
      };

      const pending: Record<
        string,
        { total: number; synced: number; pending: number }
      > = {};
      for (const desc of TABLE_SYNC_REGISTRY) {
        const wmCol = wmColumns[desc.table];
        if (desc.sessionLinked && wmCol) {
          const total =
            (
              db
                .prepare(
                  `SELECT COUNT(*) as c FROM ${desc.table} t
                   INNER JOIN target_session_sync tss
                     ON tss.session_id = t.session_id AND tss.target = ?
                   WHERE tss.confirmed = 1`,
                )
                .get(target) as { c: number }
            )?.c ?? 0;
          const pendingCount =
            (
              db
                .prepare(
                  `SELECT COUNT(*) as c FROM ${desc.table} t
                   INNER JOIN target_session_sync tss
                     ON tss.session_id = t.session_id AND tss.target = ?
                   WHERE tss.confirmed = 1 AND t.id > tss.${wmCol}`,
                )
                .get(target) as { c: number }
            )?.c ?? 0;
          if (pendingCount > 0) {
            pending[desc.table] = {
              total,
              synced: total - pendingCount,
              pending: pendingCount,
            };
          }
          continue;
        }

        const key = watermarkKey(desc.table, target);
        const wm = readWatermark(key);
        const maxId =
          (
            db
              .prepare(
                `SELECT MAX(${desc.table === "sessions" ? "sync_seq" : "id"}) as m FROM ${desc.table}`,
              )
              .get() as { m: number | null }
          )?.m ?? 0;
        const count = Math.max(0, maxId - wm);
        if (count > 0) {
          pending[desc.table] = { total: maxId, synced: wm, pending: count };
        }
      }

      return {
        target,
        totalPending: Object.values(pending).reduce(
          (sum, value) => sum + value.pending,
          0,
        ),
        tables: pending,
      };
    },
    async syncTargetList() {
      return { targets: listTargets() };
    },
    async syncTargetAdd(target: SyncTargetAddInput) {
      const syncTarget = target as SyncTarget;
      if (!syncTarget.name) throw new Error("name is required");
      if (!syncTarget.url) throw new Error("url is required");
      addTarget(syncTarget);
      return { ok: true, name: syncTarget.name, url: syncTarget.url };
    },
    async syncTargetRemove(name: string) {
      const removed = removeTarget(name);
      return { ok: removed, name };
    },
  };
}

export const directPanopticonService = createDirectPanopticonService();
