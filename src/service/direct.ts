import { rebuildActiveClaims } from "../claims/canonicalize.js";
import { runIntegrityCheck } from "../claims/integrity.js";
import { config } from "../config.js";
import {
  CLAIMS_ACTIVE_COMPONENT,
  CLAIMS_PROJECTION_COMPONENT,
  type DataComponent,
  INTENT_FROM_HOOKS_COMPONENT,
  INTENT_FROM_SCANNER_COMPONENT,
  LANDED_FROM_DISK_COMPONENT,
} from "../db/data-versions.js";
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
import {
  getDb,
  markDataComponentsCurrent,
  needsClaimsRebuild,
  needsRawDataResync,
  needsResync,
  staleDataComponents,
} from "../db/schema.js";
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
import {
  rebuildClaimsDerivedState,
  reparseAll,
  scanOnce,
} from "../scanner/index.js";
import { readScannerStatus } from "../scanner/status.js";
import { runSessionSummaryPass } from "../session_summaries/pass.js";
import {
  fileOverview,
  listSessionSummaries,
  recentWorkOnPath,
  sessionSummaryDetail,
  whyCode,
} from "../session_summaries/query.js";
import { addTarget, listTargets, removeTarget } from "../sync/config.js";
import { TABLE_SYNC_REGISTRY } from "../sync/registry.js";
import type { SyncTarget } from "../sync/types.js";
import {
  readWatermark,
  resetWatermarks,
  watermarkKey,
  writeWatermark,
} from "../sync/watermark.js";
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

const ACTIVE_DERIVED_REBUILD_PHASES = new Set([
  "claims_rebuild_init",
  "claims_rebuild_claims",
  "claims_rebuild_projection",
  "claims_rebuild_finalize",
  "reparse_init",
  "reparse_scan",
  "reparse_process",
  "reparse_copy",
  "reparse_derive",
  "reparse_finalize",
]);

function isDerivedRebuildInProgress(): boolean {
  const phase = readScannerStatus()?.phase;
  return phase ? ACTIVE_DERIVED_REBUILD_PHASES.has(phase) : false;
}

function runSummaryGeneration(): number {
  return runSessionSummaryPass({
    log: (msg) => log.scanner.debug(msg),
    enrichmentLog: (msg) => log.scanner.info(msg),
    enrichmentLimit: config.sessionSummaryEnrichLimit ?? 5,
    onEnrichmentError: (err) => {
      log.scanner.error(
        `scan exec: session summary enrichment failed: ${err instanceof Error ? err.message : err}`,
      );
    },
  }).updated;
}

function markComponentsCurrentIfFull(
  sessionId: string | undefined,
  components: readonly DataComponent[],
): void {
  if (sessionId) return;
  markDataComponentsCurrent(components);
}

function maybeMarkClaimsActiveCurrent(sessionId: string | undefined): void {
  if (sessionId) return;
  const stale = new Set(staleDataComponents());
  if (
    !stale.has(INTENT_FROM_SCANNER_COMPONENT) &&
    !stale.has(INTENT_FROM_HOOKS_COMPONENT) &&
    !stale.has(LANDED_FROM_DISK_COMPONENT)
  ) {
    markDataComponentsCurrent([CLAIMS_ACTIVE_COMPONENT]);
  }
}

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
    async listSessionSummaries(opts) {
      return listSessionSummaries(opts);
    },
    async sessionSummaryDetail(opts) {
      return sessionSummaryDetail(opts);
    },
    async whyCode(opts) {
      return whyCode(opts);
    },
    async recentWorkOnPath(opts) {
      return recentWorkOnPath(opts);
    },
    async fileOverview(opts) {
      return fileOverview(opts);
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
      if (needsResync()) {
        if (isDerivedRebuildInProgress()) {
          throw new Error("Derived-state rebuild already in progress");
        }
        if (needsRawDataResync()) {
          const result = reparseAll((msg) => log.scanner.debug(msg));
          if (!result.success) {
            throw new Error(result.error ?? "Atomic reparse failed");
          }
          return {
            filesScanned: result.filesScanned,
            newTurns: result.newTurns,
            summariesUpdated:
              opts?.summaries === false ? 0 : runSummaryGeneration(),
          };
        }
        if (needsClaimsRebuild()) {
          rebuildClaimsDerivedState((msg) => log.scanner.debug(msg));
          return {
            filesScanned: 0,
            newTurns: 0,
            summariesUpdated:
              opts?.summaries === false ? 0 : runSummaryGeneration(),
          };
        }
        return {
          filesScanned: 0,
          newTurns: 0,
          summariesUpdated:
            opts?.summaries === false ? 0 : runSummaryGeneration(),
        };
      }

      const result = scanOnce({
        profileLabel: "manual scan",
        logDetails: true,
      });
      return {
        filesScanned: result.filesScanned,
        newTurns: result.newTurns,
        summariesUpdated:
          opts?.summaries === false ? 0 : runSummaryGeneration(),
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
      const projection = rebuildIntentProjection({
        sessionId: opts?.sessionId,
      });
      markComponentsCurrentIfFull(opts?.sessionId, [
        INTENT_FROM_SCANNER_COMPONENT,
        INTENT_FROM_HOOKS_COMPONENT,
        CLAIMS_PROJECTION_COMPONENT,
      ]);
      maybeMarkClaimsActiveCurrent(opts?.sessionId);
      return { scanner, hooks, activeHeads, projection };
    },
    async rebuildIntentProjectionFromClaims(
      opts?: RebuildIntentProjectionInput,
    ) {
      const projection = rebuildIntentProjection({
        sessionId: opts?.sessionId,
      });
      markComponentsCurrentIfFull(opts?.sessionId, [
        CLAIMS_PROJECTION_COMPONENT,
      ]);
      return projection;
    },
    async reconcileLandedStatusFromDisk(opts?: ReconcileLandedStatusInput) {
      const landed = reconcileLandedClaimsFromDisk({
        sessionId: opts?.sessionId,
      });
      const activeHeads = rebuildActiveClaims();
      const projection = rebuildIntentProjection({
        sessionId: opts?.sessionId,
      });
      markComponentsCurrentIfFull(opts?.sessionId, [
        LANDED_FROM_DISK_COMPONENT,
        CLAIMS_PROJECTION_COMPONENT,
      ]);
      maybeMarkClaimsActiveCurrent(opts?.sessionId);
      return { landed, activeHeads, projection };
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
