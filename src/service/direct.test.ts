import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  needsResyncMock,
  needsRawDataResyncMock,
  needsClaimsRebuildMock,
  staleDataComponentsMock,
  markDataComponentsCurrentMock,
  getDbMock,
  scanOnceMock,
  reparseAllMock,
  rebuildClaimsDerivedStateMock,
  rebuildActiveClaimsMock,
  rebuildIntentClaimsFromScannerMock,
  rebuildIntentClaimsFromHooksMock,
  rebuildIntentProjectionMock,
  reconcileLandedClaimsFromDiskMock,
  readScannerStatusMock,
  refreshSessionSummaryEnrichmentsOnceMock,
  generateSummariesOnceMock,
} = vi.hoisted(() => ({
  needsResyncMock: vi.fn(),
  needsRawDataResyncMock: vi.fn(),
  needsClaimsRebuildMock: vi.fn(),
  staleDataComponentsMock: vi.fn<() => string[]>(() => []),
  markDataComponentsCurrentMock: vi.fn(),
  getDbMock: vi.fn(() => ({
    pragma: vi.fn(),
    exec: vi.fn(),
  })),
  scanOnceMock: vi.fn(),
  reparseAllMock: vi.fn(),
  rebuildClaimsDerivedStateMock: vi.fn(),
  rebuildActiveClaimsMock: vi.fn(() => 3),
  rebuildIntentClaimsFromScannerMock: vi.fn(() => ({ intents: 1, edits: 2 })),
  rebuildIntentClaimsFromHooksMock: vi.fn(() => ({ prompts: 3, edits: 4 })),
  rebuildIntentProjectionMock: vi.fn(() => ({
    intents: 6,
    edits: 7,
    sessionSummaries: 8,
    memberships: 9,
    provenance: 10,
  })),
  reconcileLandedClaimsFromDiskMock: vi.fn(() => ({ checked: 5 })),
  readScannerStatusMock: vi.fn(),
  refreshSessionSummaryEnrichmentsOnceMock: vi.fn(),
  generateSummariesOnceMock: vi.fn(),
}));

vi.mock("../claims/canonicalize.js", () => ({
  rebuildActiveClaims: rebuildActiveClaimsMock,
}));

vi.mock("../claims/integrity.js", () => ({
  runIntegrityCheck: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    enableSessionSummaryProjections: true,
  },
}));

vi.mock("../db/pricing.js", () => ({
  refreshPricing: vi.fn(),
}));

vi.mock("../db/prune.js", () => ({
  pruneEstimate: vi.fn(),
  pruneExecute: vi.fn(),
}));

vi.mock("../db/query.js", () => ({
  activitySummary: vi.fn(),
  costBreakdown: vi.fn(),
  dbStats: vi.fn(),
  listPlans: vi.fn(),
  listSessions: vi.fn(),
  print: vi.fn(),
  rawQuery: vi.fn(),
  search: vi.fn(),
  sessionTimeline: vi.fn(),
}));

vi.mock("../db/schema.js", () => ({
  getDb: getDbMock,
  markDataComponentsCurrent: markDataComponentsCurrentMock,
  needsClaimsRebuild: needsClaimsRebuildMock,
  needsRawDataResync: needsRawDataResyncMock,
  needsResync: needsResyncMock,
  staleDataComponents: staleDataComponentsMock,
}));

vi.mock("../intent/asserters/from_hooks.js", () => ({
  rebuildIntentClaimsFromHooks: rebuildIntentClaimsFromHooksMock,
}));

vi.mock("../intent/asserters/from_scanner.js", () => ({
  rebuildIntentClaimsFromScanner: rebuildIntentClaimsFromScannerMock,
}));

vi.mock("../intent/asserters/landed_from_disk.js", () => ({
  reconcileLandedClaimsFromDisk: reconcileLandedClaimsFromDiskMock,
}));

vi.mock("../intent/project.js", () => ({
  rebuildIntentProjection: rebuildIntentProjectionMock,
}));

vi.mock("../intent/query.js", () => ({
  intentForCode: vi.fn(),
  outcomesForIntent: vi.fn(),
  searchIntent: vi.fn(),
}));

vi.mock("../log.js", () => ({
  log: {
    scanner: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock("../scanner/index.js", () => ({
  rebuildClaimsDerivedState: rebuildClaimsDerivedStateMock,
  reparseAll: reparseAllMock,
  scanOnce: scanOnceMock,
}));

vi.mock("../scanner/status.js", () => ({
  readScannerStatus: readScannerStatusMock,
}));

vi.mock("../session_summaries/query.js", () => ({
  listSessionSummaries: vi.fn(),
  recentWorkOnPath: vi.fn(),
  sessionSummaryDetail: vi.fn(),
  whyCode: vi.fn(),
}));

vi.mock("../session_summaries/enrichment.js", () => ({
  refreshSessionSummaryEnrichmentsOnce:
    refreshSessionSummaryEnrichmentsOnceMock,
}));

vi.mock("../summary/index.js", () => ({
  generateSummariesOnce: generateSummariesOnceMock,
}));

vi.mock("../sync/config.js", () => ({
  addTarget: vi.fn(),
  listTargets: vi.fn(),
  removeTarget: vi.fn(),
}));

vi.mock("../sync/registry.js", () => ({
  TABLE_SYNC_REGISTRY: [],
}));

vi.mock("../sync/watermark.js", () => ({
  readWatermark: vi.fn(),
  resetWatermarks: vi.fn(),
  watermarkKey: vi.fn(),
  writeWatermark: vi.fn(),
}));

import { createDirectPanopticonService } from "./direct.js";

describe("direct service scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    needsResyncMock.mockReturnValue(false);
    needsRawDataResyncMock.mockReturnValue(false);
    needsClaimsRebuildMock.mockReturnValue(false);
    staleDataComponentsMock.mockReturnValue([]);
    readScannerStatusMock.mockReturnValue(null);
    scanOnceMock.mockReturnValue({
      filesScanned: 2,
      newTurns: 3,
    });
    reparseAllMock.mockReturnValue({
      success: true,
      filesScanned: 7,
      newTurns: 11,
    });
    rebuildClaimsDerivedStateMock.mockReturnValue({
      scannerIntents: 1,
      scannerEdits: 2,
      hookPrompts: 0,
      hookEdits: 0,
      activeHeadsAfterClaims: 3,
      landedChecked: 4,
      activeHeadsAfterLanded: 5,
      projectedIntents: 6,
      projectedEdits: 7,
      projectedSessionSummaries: 8,
      projectedMemberships: 9,
      projectedProvenance: 10,
      totalMs: 11,
    });
    refreshSessionSummaryEnrichmentsOnceMock.mockReturnValue({ updated: 5 });
    generateSummariesOnceMock.mockReturnValue({ updated: 5 });
  });

  it("triggers atomic reparse when raw data needs resync", async () => {
    needsResyncMock.mockReturnValue(true);
    needsRawDataResyncMock.mockReturnValue(true);
    const service = createDirectPanopticonService();

    const result = await service.scan();

    expect(reparseAllMock).toHaveBeenCalledTimes(1);
    expect(scanOnceMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      filesScanned: 7,
      newTurns: 11,
      summariesUpdated: 5,
    });
  });

  it("triggers a claims-only rebuild when claim data is stale", async () => {
    needsResyncMock.mockReturnValue(true);
    needsClaimsRebuildMock.mockReturnValue(true);
    const service = createDirectPanopticonService();

    const result = await service.scan();

    expect(rebuildClaimsDerivedStateMock).toHaveBeenCalledTimes(1);
    expect(reparseAllMock).not.toHaveBeenCalled();
    expect(scanOnceMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      filesScanned: 0,
      newTurns: 0,
      summariesUpdated: 5,
    });
  });

  it("refuses a manual scan while startup reparse is already running", async () => {
    needsResyncMock.mockReturnValue(true);
    readScannerStatusMock.mockReturnValue({
      phase: "reparse_scan",
      message: "Scanning raw session files into temp DB...",
    });
    const service = createDirectPanopticonService();

    await expect(service.scan()).rejects.toThrow(
      "Derived-state rebuild already in progress",
    );
    expect(reparseAllMock).not.toHaveBeenCalled();
    expect(scanOnceMock).not.toHaveBeenCalled();
  });

  it("falls back to a normal scan once resync is complete", async () => {
    const service = createDirectPanopticonService();

    const result = await service.scan({ summaries: false });

    expect(scanOnceMock).toHaveBeenCalledWith({
      profileLabel: "manual scan",
      logDetails: true,
    });
    expect(reparseAllMock).not.toHaveBeenCalled();
    expect(generateSummariesOnceMock).not.toHaveBeenCalled();
    expect(refreshSessionSummaryEnrichmentsOnceMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      filesScanned: 2,
      newTurns: 3,
      summariesUpdated: 0,
    });
  });

  it("marks full raw-claims rebuild components current", async () => {
    const service = createDirectPanopticonService();

    const result = await service.rebuildClaimsFromRaw();

    expect(rebuildIntentClaimsFromScannerMock).toHaveBeenCalledWith({
      sessionId: undefined,
    });
    expect(rebuildIntentClaimsFromHooksMock).toHaveBeenCalledWith({
      sessionId: undefined,
    });
    expect(rebuildIntentProjectionMock).toHaveBeenCalledWith({
      sessionId: undefined,
    });
    expect(markDataComponentsCurrentMock).toHaveBeenNthCalledWith(1, [
      "intent.from_scanner",
      "intent.from_hooks",
      "claims.projection",
    ]);
    expect(markDataComponentsCurrentMock).toHaveBeenNthCalledWith(2, [
      "claims.active",
    ]);
    expect(result).toEqual({
      scanner: { intents: 1, edits: 2 },
      hooks: { prompts: 3, edits: 4 },
      activeHeads: 3,
      projection: {
        intents: 6,
        edits: 7,
        sessionSummaries: 8,
        memberships: 9,
        provenance: 10,
      },
    });
  });

  it("does not mark active claims current if another claim source component is still stale", async () => {
    staleDataComponentsMock.mockReturnValue(["intent.landed_from_disk"]);
    const service = createDirectPanopticonService();

    await service.rebuildClaimsFromRaw();

    expect(markDataComponentsCurrentMock).toHaveBeenCalledTimes(1);
    expect(markDataComponentsCurrentMock).toHaveBeenCalledWith([
      "intent.from_scanner",
      "intent.from_hooks",
      "claims.projection",
    ]);
  });

  it("does not clear global version state for scoped raw-claims rebuilds", async () => {
    const service = createDirectPanopticonService();

    await service.rebuildClaimsFromRaw({ sessionId: "session-1" });

    expect(rebuildIntentProjectionMock).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
    expect(markDataComponentsCurrentMock).not.toHaveBeenCalled();
  });

  it("marks landed and active claim components current after a full landed rebuild", async () => {
    const service = createDirectPanopticonService();

    const result = await service.reconcileLandedStatusFromDisk();

    expect(reconcileLandedClaimsFromDiskMock).toHaveBeenCalledWith({
      sessionId: undefined,
    });
    expect(rebuildIntentProjectionMock).toHaveBeenCalledWith({
      sessionId: undefined,
    });
    expect(markDataComponentsCurrentMock).toHaveBeenNthCalledWith(1, [
      "intent.landed_from_disk",
      "claims.projection",
    ]);
    expect(markDataComponentsCurrentMock).toHaveBeenNthCalledWith(2, [
      "claims.active",
    ]);
    expect(result).toEqual({
      landed: { checked: 5 },
      activeHeads: 3,
      projection: {
        intents: 6,
        edits: 7,
        sessionSummaries: 8,
        memberships: 9,
        provenance: 10,
      },
    });
  });

  it("marks projection current after a full projection rebuild", async () => {
    const service = createDirectPanopticonService();

    const result = await service.rebuildIntentProjectionFromClaims();

    expect(rebuildIntentProjectionMock).toHaveBeenCalledWith({
      sessionId: undefined,
    });
    expect(markDataComponentsCurrentMock).toHaveBeenCalledWith([
      "claims.projection",
    ]);
    expect(result).toEqual({
      intents: 6,
      edits: 7,
      sessionSummaries: 8,
      memberships: 9,
      provenance: 10,
    });
  });
});
