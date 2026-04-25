import { config } from "../config.js";
import { refreshSessionSummaryEnrichmentsOnce } from "./enrichment.js";
import { ensureSessionSummaryProjections } from "./query.js";

export function runSessionSummaryPass(opts: {
  log: (msg: string) => void;
  enrichmentLog?: (msg: string) => void;
  onEnrichmentError: (err: unknown) => void;
  enrichmentLimit?: number;
}): {
  updated: number;
} {
  let updated = 0;
  ensureSessionSummaryProjections();

  if (config.enableSessionSummaryEnrichment) {
    try {
      updated += refreshSessionSummaryEnrichmentsOnce({
        log: opts.enrichmentLog ?? opts.log,
        limit: opts.enrichmentLimit,
      }).updated;
    } catch (err) {
      opts.onEnrichmentError(err);
    }
  }

  return { updated };
}
