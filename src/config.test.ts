import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENRICHMENT_FLAG =
  process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT;

async function loadConfigWithEnrichmentFlag(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) {
    delete process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT;
  } else {
    process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT = value;
  }
  return (await import("./config.js")).config;
}

describe("config", () => {
  afterEach(() => {
    vi.resetModules();
    if (ORIGINAL_ENRICHMENT_FLAG === undefined) {
      delete process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT;
    } else {
      process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT =
        ORIGINAL_ENRICHMENT_FLAG;
    }
  });

  it("enables session summary enrichment by default", async () => {
    const config = await loadConfigWithEnrichmentFlag(undefined);

    expect(config.enableSessionSummaryEnrichment).toBe(true);
  });

  it("allows session summary enrichment to be disabled explicitly", async () => {
    const config = await loadConfigWithEnrichmentFlag("0");

    expect(config.enableSessionSummaryEnrichment).toBe(false);
  });
});
