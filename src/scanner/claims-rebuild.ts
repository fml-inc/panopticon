import { performance } from "node:perf_hooks";
import { rebuildActiveClaims } from "../claims/canonicalize.js";
import { markClaimsRebuildComplete } from "../db/schema.js";
import { rebuildIntentClaimsFromHooks } from "../intent/asserters/from_hooks.js";
import { rebuildIntentClaimsFromScanner } from "../intent/asserters/from_scanner.js";
import { reconcileLandedClaimsFromDisk } from "../intent/asserters/landed_from_disk.js";
import { rebuildIntentProjection } from "../intent/project.js";
import { clearScannerStatus, writeScannerStatus } from "./status.js";

export interface ClaimsRebuildResult {
  scannerIntents: number;
  scannerEdits: number;
  hookPrompts: number;
  hookEdits: number;
  activeHeadsAfterClaims: number;
  landedChecked: number;
  activeHeadsAfterLanded: number;
  projectedIntents: number;
  projectedEdits: number;
  projectedSessionSummaries: number;
  projectedMemberships: number;
  projectedProvenance: number;
  totalMs: number;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function writeClaimsRebuildStatus(
  phase:
    | "claims_rebuild_init"
    | "claims_rebuild_claims"
    | "claims_rebuild_projection"
    | "claims_rebuild_finalize"
    | "claims_rebuild_error",
  message: string,
  startedAtMs: number,
): void {
  writeScannerStatus({
    pid: process.pid,
    phase,
    message,
    startedAtMs,
    elapsedMs: Date.now() - startedAtMs,
  });
}

export function rebuildClaimsDerivedState(
  log: (msg: string) => void = () => {},
): ClaimsRebuildResult {
  const startedAt = performance.now();
  const statusStartedAtMs = Date.now();

  writeClaimsRebuildStatus(
    "claims_rebuild_init",
    "Starting claims rebuild from local raw data...",
    statusStartedAtMs,
  );
  log("Starting claims rebuild from local raw data...");

  try {
    writeClaimsRebuildStatus(
      "claims_rebuild_claims",
      "Rebuilding claims from local raw data...",
      statusStartedAtMs,
    );

    let phaseStartedAt = performance.now();
    const scanner = rebuildIntentClaimsFromScanner();
    log(
      `Claims rebuild phase scanner-claims: ${formatMs(performance.now() - phaseStartedAt)} (intents=${scanner.intents} edits=${scanner.edits})`,
    );

    phaseStartedAt = performance.now();
    const hooks = rebuildIntentClaimsFromHooks();
    log(
      `Claims rebuild phase hook-claims: ${formatMs(performance.now() - phaseStartedAt)} (prompts=${hooks.prompts} edits=${hooks.edits})`,
    );

    phaseStartedAt = performance.now();
    const activeHeadsAfterClaims = rebuildActiveClaims();
    log(
      `Claims rebuild phase canonicalize-claims: ${formatMs(performance.now() - phaseStartedAt)} (active_heads=${activeHeadsAfterClaims})`,
    );

    phaseStartedAt = performance.now();
    const landed = reconcileLandedClaimsFromDisk();
    log(
      `Claims rebuild phase landed-reconciliation: ${formatMs(performance.now() - phaseStartedAt)} (checked=${landed.checked})`,
    );

    phaseStartedAt = performance.now();
    const activeHeadsAfterLanded = rebuildActiveClaims();
    log(
      `Claims rebuild phase canonicalize-landed: ${formatMs(performance.now() - phaseStartedAt)} (active_heads=${activeHeadsAfterLanded})`,
    );

    writeClaimsRebuildStatus(
      "claims_rebuild_projection",
      "Rebuilding intent projection from claims...",
      statusStartedAtMs,
    );
    phaseStartedAt = performance.now();
    const projection = rebuildIntentProjection();
    log(
      `Claims rebuild phase intent-projection: ${formatMs(performance.now() - phaseStartedAt)} (intents=${projection.intents} edits=${projection.edits} summaries=${projection.sessionSummaries})`,
    );

    writeClaimsRebuildStatus(
      "claims_rebuild_finalize",
      "Finalizing claims rebuild...",
      statusStartedAtMs,
    );
    markClaimsRebuildComplete();
    clearScannerStatus();

    const totalMs = performance.now() - startedAt;
    log(
      `Claims rebuild finished in ${formatMs(totalMs)} (scanner_intents=${scanner.intents} scanner_edits=${scanner.edits} hook_prompts=${hooks.prompts} hook_edits=${hooks.edits} landed_checked=${landed.checked} projected_intents=${projection.intents} projected_edits=${projection.edits})`,
    );

    return {
      scannerIntents: scanner.intents,
      scannerEdits: scanner.edits,
      hookPrompts: hooks.prompts,
      hookEdits: hooks.edits,
      activeHeadsAfterClaims,
      landedChecked: landed.checked,
      activeHeadsAfterLanded,
      projectedIntents: projection.intents,
      projectedEdits: projection.edits,
      projectedSessionSummaries: projection.sessionSummaries,
      projectedMemberships: projection.memberships,
      projectedProvenance: projection.provenance,
      totalMs,
    };
  } catch (err) {
    writeClaimsRebuildStatus(
      "claims_rebuild_error",
      `Claims rebuild failed: ${err instanceof Error ? err.message : err}`,
      statusStartedAtMs,
    );
    throw err;
  }
}
