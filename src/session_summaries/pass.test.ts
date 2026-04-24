import { beforeEach, describe, expect, it, vi } from "vitest";

const { refreshSessionSummaryEnrichmentsOnceMock, generateSummariesOnceMock } =
  vi.hoisted(() => ({
    refreshSessionSummaryEnrichmentsOnceMock: vi.fn(),
    generateSummariesOnceMock: vi.fn(),
  }));
const { ensureSessionSummaryProjectionsMock } = vi.hoisted(() => ({
  ensureSessionSummaryProjectionsMock: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    enableSessionSummaryProjections: true,
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

vi.mock("../summary/index.js", () => ({
  generateSummariesOnce: generateSummariesOnceMock,
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

    expect(ensureSessionSummaryProjectionsMock).toHaveBeenCalledOnce();
    expect(generateSummariesOnceMock).toHaveBeenCalledOnce();
    expect(onEnrichmentError).toHaveBeenCalledOnce();
    expect(onLegacySummaryError).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 3 });
  });

  it("leaves llm enrichment idle when the enrichment flag is disabled", () => {
    (
      config as { enableSessionSummaryEnrichment: boolean }
    ).enableSessionSummaryEnrichment = false;
    generateSummariesOnceMock.mockReturnValue({ updated: 2 });

    const result = runSessionSummaryPass({
      log: vi.fn(),
      onEnrichmentError: vi.fn(),
      onLegacySummaryError: vi.fn(),
    });

    expect(ensureSessionSummaryProjectionsMock).toHaveBeenCalledOnce();
    expect(refreshSessionSummaryEnrichmentsOnceMock).not.toHaveBeenCalled();
    expect(generateSummariesOnceMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ updated: 2 });
  });
});
