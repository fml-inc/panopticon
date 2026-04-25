import { beforeEach, describe, expect, it, vi } from "vitest";

const { refreshSessionSummaryEnrichmentsOnceMock } = vi.hoisted(() => ({
  refreshSessionSummaryEnrichmentsOnceMock: vi.fn(),
}));
const { ensureSessionSummaryProjectionsMock } = vi.hoisted(() => ({
  ensureSessionSummaryProjectionsMock: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    enableSessionSummaryEnrichment: true,
  },
}));

vi.mock("./enrichment.js", () => ({
  refreshSessionSummaryEnrichmentsOnce:
    refreshSessionSummaryEnrichmentsOnceMock,
}));

vi.mock("./query.js", () => ({
  ensureSessionSummaryProjections: ensureSessionSummaryProjectionsMock,
}));

import { config } from "../config.js";
import { runSessionSummaryPass } from "./pass.js";

describe("runSessionSummaryPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (
      config as { enableSessionSummaryEnrichment: boolean }
    ).enableSessionSummaryEnrichment = true;
    refreshSessionSummaryEnrichmentsOnceMock.mockResolvedValue({ updated: 0 });
  });

  it("still ensures projections when enrichment throws", async () => {
    refreshSessionSummaryEnrichmentsOnceMock.mockRejectedValue(
      new Error("enrichment failed"),
    );
    const onEnrichmentError = vi.fn();

    const result = await runSessionSummaryPass({
      log: vi.fn(),
      onEnrichmentError,
    });

    expect(ensureSessionSummaryProjectionsMock).toHaveBeenCalledOnce();
    expect(onEnrichmentError).toHaveBeenCalledOnce();
    expect(result).toEqual({ updated: 0 });
  });

  it("leaves llm enrichment idle when the enrichment flag is disabled", async () => {
    (
      config as { enableSessionSummaryEnrichment: boolean }
    ).enableSessionSummaryEnrichment = false;

    const result = await runSessionSummaryPass({
      log: vi.fn(),
      onEnrichmentError: vi.fn(),
    });

    expect(ensureSessionSummaryProjectionsMock).toHaveBeenCalledOnce();
    expect(refreshSessionSummaryEnrichmentsOnceMock).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0 });
  });
});
