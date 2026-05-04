import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENRICHMENT_FLAG =
  process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT;
const ORIGINAL_LOG_ROTATE_BYTES = process.env.PANOPTICON_LOG_ROTATE_BYTES;
const ORIGINAL_LOG_ROTATE_FILES = process.env.PANOPTICON_LOG_ROTATE_FILES;

async function loadConfigWithEnrichmentFlag(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) {
    delete process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT;
  } else {
    process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT = value;
  }
  return (await import("./config.js")).config;
}

async function loadConfigWithLogRotation(opts: {
  bytes?: string;
  files?: string;
}) {
  vi.resetModules();
  if (opts.bytes === undefined) delete process.env.PANOPTICON_LOG_ROTATE_BYTES;
  else process.env.PANOPTICON_LOG_ROTATE_BYTES = opts.bytes;
  if (opts.files === undefined) delete process.env.PANOPTICON_LOG_ROTATE_FILES;
  else process.env.PANOPTICON_LOG_ROTATE_FILES = opts.files;
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
    if (ORIGINAL_LOG_ROTATE_BYTES === undefined) {
      delete process.env.PANOPTICON_LOG_ROTATE_BYTES;
    } else {
      process.env.PANOPTICON_LOG_ROTATE_BYTES = ORIGINAL_LOG_ROTATE_BYTES;
    }
    if (ORIGINAL_LOG_ROTATE_FILES === undefined) {
      delete process.env.PANOPTICON_LOG_ROTATE_FILES;
    } else {
      process.env.PANOPTICON_LOG_ROTATE_FILES = ORIGINAL_LOG_ROTATE_FILES;
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

  it("allows log rotation to be disabled with zero values", async () => {
    const config = await loadConfigWithLogRotation({ bytes: "0", files: "0" });

    expect(config.logRotateBytes).toBe(0);
    expect(config.logRotateFiles).toBe(0);
  });
});
