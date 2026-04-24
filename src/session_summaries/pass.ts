import { config } from "../config.js";
import { generateSummariesOnce } from "../summary/index.js";
import { refreshSessionSummaryEnrichmentsOnce } from "./enrichment.js";
import { ensureSessionSummaryProjections } from "./query.js";

export function runSessionSummaryPass(opts: {
  log: (msg: string) => void;
  enrichmentLog?: (msg: string) => void;
  onEnrichmentError: (err: unknown) => void;
  onLegacySummaryError: (err: unknown) => void;
  enrichmentLimit?: number;
}): {
  updated: number;
} {
  let updated = 0;
  if (config.enableSessionSummaryProjections) {
    ensureSessionSummaryProjections();
  }

  if (
    config.enableSessionSummaryProjections &&
    config.enableSessionSummaryEnrichment
  ) {
    try {
      updated += refreshSessionSummaryEnrichmentsOnce({
        log: opts.enrichmentLog ?? opts.log,
        limit: opts.enrichmentLimit,
      }).updated;
    } catch (err) {
      opts.onEnrichmentError(err);
    }
  }

  try {
    updated += generateSummariesOnce(opts.log).updated;
  } catch (err) {
    opts.onLegacySummaryError(err);
  }

  return { updated };
}
