import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  needsResyncMock,
  getDbMock,
  scanOnceMock,
  reparseAllMock,
  readScannerStatusMock,
  generateSummariesOnceMock,
} = vi.hoisted(() => ({
  needsResyncMock: vi.fn(),
  getDbMock: vi.fn(() => ({
    pragma: vi.fn(),
    exec: vi.fn(),
  })),
  scanOnceMock: vi.fn(),
  reparseAllMock: vi.fn(),
  readScannerStatusMock: vi.fn(),
  generateSummariesOnceMock: vi.fn(),
}));

vi.mock("../claims/canonicalize.js", () => ({
  rebuildActiveClaims: vi.fn(),
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
  needsResync: needsResyncMock,
}));

vi.mock("../intent/asserters/from_hooks.js", () => ({
  rebuildIntentClaimsFromHooks: vi.fn(),
}));

vi.mock("../intent/asserters/from_scanner.js", () => ({
  rebuildIntentClaimsFromScanner: vi.fn(),
}));

vi.mock("../intent/asserters/landed_from_disk.js", () => ({
  reconcileLandedClaimsFromDisk: vi.fn(),
}));

vi.mock("../intent/project.js", () => ({
  rebuildIntentProjection: vi.fn(),
}));

vi.mock("../intent/query.js", () => ({
  intentForCode: vi.fn(),
  outcomesForIntent: vi.fn(),
  searchIntent: vi.fn(),
}));

vi.mock("../log.js", () => ({
  log: {
    scanner: {
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock("../scanner/index.js", () => ({
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
    generateSummariesOnceMock.mockReturnValue({ updated: 5 });
  });

  it("triggers atomic reparse when stale data needs resync", async () => {
    needsResyncMock.mockReturnValue(true);
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

  it("refuses a manual scan while startup reparse is already running", async () => {
    needsResyncMock.mockReturnValue(true);
    readScannerStatusMock.mockReturnValue({
      phase: "reparse_scan",
      message: "Scanning raw session files into temp DB...",
    });
    const service = createDirectPanopticonService();

    await expect(service.scan()).rejects.toThrow(
      "Scanner resync already in progress",
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
    expect(result).toEqual({
      filesScanned: 2,
      newTurns: 3,
      summariesUpdated: 0,
    });
  });
});
