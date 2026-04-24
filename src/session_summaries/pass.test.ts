import { beforeEach, describe, expect, it, vi } from "vitest";

const { refreshSessionSummaryEnrichmentsOnceMock, generateSummariesOnceMock } =
  vi.hoisted(() => ({
    refreshSessionSummaryEnrichmentsOnceMock: vi.fn(),
    generateSummariesOnceMock: vi.fn(),
  }));

vi.mock("../config.js", () => ({
  config: {
    enableSessionSummaryProjections: true,
  },
}));

vi.mock("./enrichment.js", () => ({
  refreshSessionSummaryEnrichmentsOnce:
    refreshSessionSummaryEnrichmentsOnceMock,
}));

vi.mock("../summary/index.js", () => ({
  generateSummariesOnce: generateSummariesOnceMock,
}));

import { runSessionSummaryPass } from "./pass.js";

describe("runSessionSummaryPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshSessionSummaryEnrichmentsOnceMock.mockReturnValue({ updated: 0 });
    generateSummariesOnceMock.mockReturnValue({ updated: 0 });
  });

  it("still runs legacy summary generation when enrichment throws", () => {
    refreshSessionSummaryEnrichmentsOnceMock.mockImplementation(() => {
      throw new Error("enrichment failed");
    });
    generateSummariesOnceMock.mockReturnValue({ updated: 3 });
    const onEnrichmentError = vi.fn();
    const onLegacySummaryError = vi.fn();

    const result = runSessionSummaryPass({
      log: vi.fn(),
      onEnrichmentError,
      onLegacySummaryError,
    });

    expect(generateSummariesOnceMock).toHaveBeenCalledOnce();
    expect(onEnrichmentError).toHaveBeenCalledOnce();
    expect(onLegacySummaryError).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 3 });
  });
});
