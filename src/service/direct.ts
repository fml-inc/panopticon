import { noteRoomActivity, waitForRoomActivity } from "../bus/activity-wait.js";
import { roomForSession } from "../bus/room.js";
import { rebuildActiveClaims } from "../claims/canonicalize.js";
import { runIntegrityCheck } from "../claims/integrity.js";
import { config } from "../config.js";
import {
  insertAgentMessage,
  markDelivered,
  readAgentMessages,
} from "../db/bus.js";
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
  hookTimeline,
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
  getInstanceFirstSeen,
  readInstancesResult,
} from "../presence/store.js";
import {
  rebuildClaimsDerivedState,
  reparseAll,
  scanOnce,
} from "../scanner/index.js";
import {
  readScannerStatus,
  type ScannerRuntimeStatus,
} from "../scanner/status.js";
import { runSessionSummaryPass } from "../session_summaries/pass.js";
import {
  fileOverview,
  listSessionSummaries,
  recentWorkOnPath,
  sessionSummaryDetail,
  whyCode,
} from "../session_summaries/query.js";
import { regenerateSessionSummaryEnrichments } from "../session_summaries/regenerate.js";
import {
  addTarget,
  listTargets,
  loadSyncConfig,
  removeTarget,
} from "../sync/config.js";
import { readSyncPending } from "../sync/pending.js";
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function activeScannerStatus(): ScannerRuntimeStatus | null {
  const status = readScannerStatus();
  if (!status) return null;
  const staleForMs = Date.now() - status.updatedAtMs;
  if (staleForMs > 120_000 && !isProcessAlive(status.pid)) return null;
  return status;
}

function isDerivedRebuildInProgress(
  status: ScannerRuntimeStatus | null,
): boolean {
  const phase = status?.phase;
  return phase ? ACTIVE_DERIVED_REBUILD_PHASES.has(phase) : false;
}

async function runSummaryGeneration(): Promise<number> {
  return (
    await runSessionSummaryPass({
      log: (msg) => log.scanner.debug(msg),
      enrichmentLog: (msg) => log.scanner.info(msg),
      enrichmentLimit: config.sessionSummaryEnrichLimit ?? 5,
      onEnrichmentError: (err) => {
        log.scanner.error(
          `scan exec: session summary enrichment failed: ${err instanceof Error ? err.message : err}`,
        );
      },
    })
  ).updated;
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

/** Resolve a bus room from an explicit room or the caller's recorded session. */
function resolveBusRoom(input: {
  room?: string;
  session_id?: string;
}): string | null {
  if (input.room) return input.room;
  if (input.session_id) return roomForSession(input.session_id);
  return null;
}

export function createDirectPanopticonService(): PanopticonService {
  return {
    async listSessions(opts) {
      return listSessions(opts);
    },
    async sessionTimeline(opts) {
      return sessionTimeline(opts);
    },
    async hookTimeline(opts) {
      return hookTimeline(opts);
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
    async instances(opts) {
      return readInstancesResult(opts ?? {});
    },
    async busSend(input) {
      const room = resolveBusRoom(input);
      if (!room) {
        throw new Error(
          "bus_send: could not resolve a room (pass room, or a session_id with a recorded room)",
        );
      }
      const id = insertAgentMessage({
        room,
        from_session: input.session_id ?? input.from ?? "external",
        to_session: input.to ?? null,
        kind: input.kind,
        body: input.body,
        subject: input.subject ?? null,
        reply_to: input.reply_to ?? null,
        ref_tool: input.ref_tool ?? null,
        ref_path: input.ref_path ?? null,
        source: input.source ?? null,
        created_at_ms: Date.now(),
      });
      // Wake anyone long-polling the room for a live conversation. Gated to
      // chat so a frenemy challenge/activity post can't wake the frenemy's own
      // long-poll (which would re-trigger a review storm). Hook events already
      // note activity for the frenemy path; this covers messages that aren't
      // hooks — the peer's chat send is what a waiting agent is blocked on.
      if (input.kind === "chat") {
        noteRoomActivity(room, Date.now());
      }
      return { id, room };
    },
    async busRead(input) {
      const room = resolveBusRoom(input);
      if (!room)
        return { room: null, cursor: input.sinceId ?? 0, messages: [] };
      const messages = readAgentMessages({
        room,
        sinceId: input.sinceId,
        kinds: input.kinds,
        // A reader sees broadcasts + messages addressed to it, never its own.
        toSession: input.session_id,
        excludeFrom: input.session_id,
        limit: input.limit,
      });
      // Reading IS the "I've seen this" action: record per-recipient
      // read-receipts so the unread nudge stops pointing at what was just read.
      // Append-only and idempotent (INSERT OR IGNORE per message+session).
      //
      // This shares the delivery table with busRecv (chat wait) ON PURPOSE: a
      // message seen via EITHER path is seen once, no double-delivery. Receipts
      // are per-recipient, so one session's read never affects another's chat
      // wait. (An agent is either chatting — blocked in recv — or working and
      // triaging via bus_read; it doesn't do both for the same turn.)
      if (input.session_id && messages.length > 0) {
        markDelivered(
          messages.map((m) => m.id),
          input.session_id,
          Date.now(),
        );
      }
      const cursor = messages.length
        ? messages[messages.length - 1].id
        : (input.sinceId ?? 0);
      return { room, cursor, messages };
    },
    async busRecv(input) {
      const room = resolveBusRoom(input);
      if (!room)
        return { room: null, cursor: input.sinceId ?? 0, messages: [] };
      const sessionId = input.session_id;
      // Catch up on what this session hasn't seen, NOT the room tip — so a
      // message sent before the caller started reading isn't skipped as history
      // (the opener race). Mirrors the hook drain / unread nudge EXACTLY:
      // per-recipient consume-once via the delivery table, scoped to the
      // session's JOIN time (first_seen), and failing closed to `now` when there
      // is no presence row — identical to `nudgeUnread` (getInstanceFirstSeen ??
      // now). Same gate on both sides ⇒ the reader returns and marks exactly the
      // unread set the nudge counts. Directed mail is always delivered.
      const sinceMs =
        input.sinceMs ??
        (sessionId ? getInstanceFirstSeen(sessionId) : null) ??
        Date.now();
      const messages = readAgentMessages({
        room,
        kinds: input.kinds ?? ["chat"],
        toSession: sessionId,
        excludeFrom: sessionId,
        undeliveredTo: sessionId,
        sinceMs,
        // id > 0 ascending: oldest-unseen first.
        sinceId: input.sinceId ?? 0,
        limit: input.limit ?? 50,
      });
      if (sessionId && messages.length > 0) {
        markDelivered(
          messages.map((m) => m.id),
          sessionId,
          Date.now(),
        );
      }
      const cursor = messages.length
        ? messages[messages.length - 1].id
        : (input.sinceId ?? 0);
      return { room, cursor, messages };
    },
    async waitForActivity(input) {
      const room = resolveBusRoom(input ?? {});
      if (!room) return { activityMs: null, room: null };
      // Clamp below the HTTP client's tool timeout so the long-poll always
      // returns before the request is cut off.
      const timeoutMs = Math.min(
        Math.max(1000, Math.floor(input.timeoutMs ?? 25_000)),
        28_000,
      );
      const activityMs = await waitForRoomActivity(
        room,
        input.sinceMs ?? 0,
        timeoutMs,
      );
      return { activityMs, room };
    },
    async busRoster(input) {
      const room = resolveBusRoom(input ?? {});
      // bus_roster is your-room scoped: if we can't determine the caller's room,
      // return an empty roster rather than silently widening to every workspace.
      // (The generic `instances` tool is the explicit cross-room view.)
      if (!room) {
        return {
          now_ms: Date.now(),
          room: null,
          counts: { active: 0, idle: 0, exited: 0, total: 0 },
          instances: [],
        };
      }
      return readInstancesResult({ room });
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
      const scannerStatus = activeScannerStatus();
      const resyncNeeded = needsResync();
      if (resyncNeeded) {
        if (isDerivedRebuildInProgress(scannerStatus)) {
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
              opts?.summaries === false ? 0 : await runSummaryGeneration(),
          };
        }
        if (needsClaimsRebuild()) {
          rebuildClaimsDerivedState((msg) => log.scanner.debug(msg));
          return {
            filesScanned: 0,
            newTurns: 0,
            summariesUpdated:
              opts?.summaries === false ? 0 : await runSummaryGeneration(),
          };
        }
        return {
          filesScanned: 0,
          newTurns: 0,
          summariesUpdated:
            opts?.summaries === false ? 0 : await runSummaryGeneration(),
        };
      }
      if (scannerStatus) {
        throw new Error(
          `Scanner already in progress (${scannerStatus.phase}): ${scannerStatus.message}`,
        );
      }

      const result = scanOnce({
        profileLabel: "manual scan",
        logDetails: true,
      });
      return {
        filesScanned: result.filesScanned,
        newTurns: result.newTurns,
        summariesUpdated:
          opts?.summaries === false ? 0 : await runSummaryGeneration(),
      };
    },
    async regenerateSessionSummaries(opts) {
      return regenerateSessionSummaryEnrichments(opts);
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
    async syncPending(target: string) {
      return readSyncPending(target);
    },
    async syncTargetList() {
      return { targets: listTargets() };
    },
    async syncTargetAdd(target: SyncTargetAddInput) {
      if (loadSyncConfig().enabled === false) {
        throw new Error(
          'sync is disabled; run "panopticon sync enable" before adding sync targets',
        );
      }
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
