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
    refreshSessionSummaryEnrichmentsOnceMock.mockReturnValue({ updated: 0 });
  });

  it("still ensures projections when enrichment throws", () => {
    refreshSessionSummaryEnrichmentsOnceMock.mockImplementation(() => {
      throw new Error("enrichment failed");
    });
    const onEnrichmentError = vi.fn();

    const result = runSessionSummaryPass({
      log: vi.fn(),
      onEnrichmentError,
    });

    expect(ensureSessionSummaryProjectionsMock).toHaveBeenCalledOnce();
    expect(onEnrichmentError).toHaveBeenCalledOnce();
    expect(result).toEqual({ updated: 0 });
  });

  it("leaves llm enrichment idle when the enrichment flag is disabled", () => {
    (
      config as { enableSessionSummaryEnrichment: boolean }
    ).enableSessionSummaryEnrichment = false;

    const result = runSessionSummaryPass({
      log: vi.fn(),
      onEnrichmentError: vi.fn(),
    });

    expect(ensureSessionSummaryProjectionsMock).toHaveBeenCalledOnce();
    expect(refreshSessionSummaryEnrichmentsOnceMock).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0 });
  });
});
