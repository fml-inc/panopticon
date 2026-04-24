import { config } from "../config.js";
import { generateSummariesOnce } from "../summary/index.js";
import { refreshSessionSummaryEnrichmentsOnce } from "./enrichment.js";

export function runSessionSummaryPass(opts: {
  log: (msg: string) => void;
  onEnrichmentError: (err: unknown) => void;
  onLegacySummaryError: (err: unknown) => void;
  enrichmentLimit?: number;
}): {
  updated: number;
} {
  let updated = 0;
  if (config.enableSessionSummaryProjections) {
    try {
      updated += refreshSessionSummaryEnrichmentsOnce({
        log: opts.log,
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
