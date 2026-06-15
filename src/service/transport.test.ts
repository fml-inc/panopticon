import { describe, expect, it, vi } from "vitest";

import {
  dispatchExec,
  dispatchTool,
  isExecName,
  isToolName,
} from "./transport.js";
import type { PanopticonService } from "./types.js";

function createMockService(): PanopticonService {
  return {
    listSessions: vi.fn(async (opts) => ({ opts })),
    sessionTimeline: vi.fn(async (opts) => ({ opts })),
    costBreakdown: vi.fn(async (opts) => ({ opts })),
    activitySummary: vi.fn(async (opts) => ({ opts })),
    listPlans: vi.fn(async (opts) => ({ opts })),
    search: vi.fn(async (opts) => ({ opts })),
    print: vi.fn(async (opts) => ({ opts })),
    rawQuery: vi.fn(async (sql) => ({ sql })),
    dbStats: vi.fn(async () => ({ ok: true })),
    instances: vi.fn(async (opts) => ({ opts })),
    busSend: vi.fn(async (opts) => ({ opts })),
    busRead: vi.fn(async (opts) => ({ opts })),
    busRecv: vi.fn(async (opts) => ({ opts })),
    busRoster: vi.fn(async (opts) => ({ opts })),
    waitForActivity: vi.fn(async (opts) => ({ opts })),
    intentForCode: vi.fn(async (opts) => ({ opts })),
    searchIntent: vi.fn(async (opts) => ({ opts })),
    outcomesForIntent: vi.fn(async (opts) => ({ opts })),
    listSessionSummaries: vi.fn(async (opts) => ({ opts })),
    sessionSummaryDetail: vi.fn(async (opts) => ({ opts })),
    whyCode: vi.fn(async (opts) => ({ opts })),
    recentWorkOnPath: vi.fn(async (opts) => ({ opts })),
    fileOverview: vi.fn(async (opts) => ({ opts })),
    pruneEstimate: vi.fn(async (cutoffMs) => ({ cutoffMs, dryRun: true })),
    pruneExecute: vi.fn(async (cutoffMs, opts) => ({ cutoffMs, opts })),
    refreshPricing: vi.fn(async () => ({ ok: true })),
    scan: vi.fn(async (opts) => ({ opts })),
    regenerateSessionSummaries: vi.fn(async (opts) => ({ opts })),
    syncReset: vi.fn(async (target) => ({ target })),
    syncWatermarkGet: vi.fn(async (target, table) => ({ target, table })),
    syncWatermarkSet: vi.fn(async (target, table, value) => ({
      target,
      table,
      value,
    })),
    rebuildClaimsFromRaw: vi.fn(async (opts) => ({ opts })),
    rebuildIntentProjectionFromClaims: vi.fn(async (opts) => ({ opts })),
    reconcileLandedStatusFromDisk: vi.fn(async (opts) => ({ opts })),
    claimEvidenceIntegrity: vi.fn(async () => ({ ok: true })),
    syncPending: vi.fn(async (target) => ({ target })),
    syncTargetList: vi.fn(async () => ({ ok: true })),
    syncTargetAdd: vi.fn(async (target) => ({ target })),
    syncTargetRemove: vi.fn(async (name) => ({ name })),
  } as unknown as PanopticonService;
}

describe("service transport", () => {
  it("dispatches tool names through the shared service boundary", async () => {
    const service = createMockService();

    const result = await dispatchTool(service, "sessions", { limit: 5 });

    expect(service.listSessions).toHaveBeenCalledWith({ limit: 5 });
    expect(result).toEqual({ opts: { limit: 5 } });
  });

  it("dispatches why_code through the shared service boundary", async () => {
    const service = createMockService();

    const result = await dispatchTool(service, "why_code", {
      path: "src/service/transport.ts",
      line: 28,
    });

    expect(service.whyCode).toHaveBeenCalledWith({
      path: "src/service/transport.ts",
      line: 28,
    });
    expect(result).toEqual({
      opts: { path: "src/service/transport.ts", line: 28 },
    });
  });

  it("dispatches session_summaries through the shared service boundary", async () => {
    const service = createMockService();

    const result = await dispatchTool(service, "session_summaries", {
      since: "36h",
      limit: 5,
    });

    expect(service.listSessionSummaries).toHaveBeenCalledWith({
      since: "36h",
      limit: 5,
    });
    expect(result).toEqual({ opts: { since: "36h", limit: 5 } });
  });

  it("dispatches file_overview through the shared service boundary", async () => {
    const service = createMockService();

    const result = await dispatchTool(service, "file_overview", {
      path: "src/service/transport.ts",
      recent_limit: 3,
      related_limit: 4,
    });

    expect(service.fileOverview).toHaveBeenCalledWith({
      path: "src/service/transport.ts",
      recent_limit: 3,
      related_limit: 4,
    });
    expect(result).toEqual({
      opts: {
        path: "src/service/transport.ts",
        recent_limit: 3,
        related_limit: 4,
      },
    });
  });

  it("dispatches bus_read to unread consume-once receive", async () => {
    const service = createMockService();

    const result = await dispatchTool(service, "bus_read", {
      room: "r",
      session_id: "s",
    });

    expect(service.busRecv).toHaveBeenCalledWith({
      room: "r",
      session_id: "s",
      kinds: ["challenge", "chat"],
      limit: 50,
    });
    expect(service.busRead).not.toHaveBeenCalled();
    expect(result).toEqual({
      opts: {
        room: "r",
        session_id: "s",
        kinds: ["challenge", "chat"],
        limit: 50,
      },
    });
  });

  it("dispatches bus_history to non-consuming message history", async () => {
    const service = createMockService();

    const result = await dispatchTool(service, "bus_history", {
      room: "r",
      kinds: ["challenge"],
      from: "frenemy",
    });

    expect(service.busRead).toHaveBeenCalledWith({
      room: "r",
      kinds: ["challenge"],
      from: "frenemy",
    });
    expect(service.busRecv).not.toHaveBeenCalled();
    expect(result).toEqual({
      opts: { room: "r", kinds: ["challenge"], from: "frenemy" },
    });
  });

  it("dispatches prune dry-run through pruneEstimate", async () => {
    const service = createMockService();

    const result = await dispatchExec(service, "prune", {
      cutoffMs: 123,
      dryRun: true,
    });

    expect(service.pruneEstimate).toHaveBeenCalledWith(123);
    expect(service.pruneExecute).not.toHaveBeenCalled();
    expect(result).toEqual({ cutoffMs: 123, dryRun: true });
  });

  it("validates required exec params in shared transport dispatch", async () => {
    const service = createMockService();

    await expect(dispatchExec(service, "prune", {})).rejects.toThrow(
      "cutoffMs is required and must be a number",
    );
  });

  it("dispatches session summary regeneration through exec transport", async () => {
    const service = createMockService();

    const result = await dispatchExec(service, "session-summaries-regenerate", {
      since: "24h",
      by: "activity",
      dryRun: false,
    });

    expect(service.regenerateSessionSummaries).toHaveBeenCalledWith({
      since: "24h",
      by: "activity",
      dryRun: false,
    });
    expect(result).toEqual({
      opts: {
        since: "24h",
        by: "activity",
        dryRun: false,
      },
    });
  });

  it("exposes tool and exec name guards", () => {
    expect(isToolName("sessions")).toBe(true);
    expect(isToolName("nope")).toBe(false);
    expect(isExecName("scan")).toBe(true);
    expect(isExecName("nope")).toBe(false);
  });
});
