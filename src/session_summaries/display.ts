import { invalidSessionSummaryEnrichmentReason } from "./enrichment-quality.js";
import { SESSION_SUMMARY_ENRICHMENT_VERSION } from "./model.js";

export type SessionSummaryDisplaySource =
  | "llm"
  | "deterministic"
  | "synthetic"
  | null;

export type SessionSummaryStaleReason =
  | "dirty"
  | "summary_version_changed"
  | "summary_policy_changed";

export interface SessionSummaryDisplayInput {
  title?: string | null;
  status?: string | null;
  intent_count?: number | null;
  edit_count?: number | null;
  landed_edit_count?: number | null;
  open_edit_count?: number | null;
  top_files?: string[];
  summary_text?: string | null;
  summary_source?: "deterministic" | null;
  enriched_summary_text?: string | null;
  enrichment_source?: "llm" | null;
  enrichment_dirty?: boolean | null;
  enrichment_summary_version?: number | null;
  enrichment_policy_hash?: string | null;
  current_policy_hash?: string | null;
  allow_synthetic_fallback?: boolean;
}

export interface SelectedSessionSummaryDisplay {
  summaryText: string | null;
  summarySource: SessionSummaryDisplaySource;
  enrichment: {
    summaryText: string | null;
    invalidReason: string | null;
    dirty: boolean;
    stale: boolean;
    staleReasons: SessionSummaryStaleReason[];
    summaryVersion: number | null;
    currentSummaryVersion: number;
  };
}

export function selectSessionSummaryDisplay(
  input: SessionSummaryDisplayInput,
): SelectedSessionSummaryDisplay {
  const deterministicSummary = emptyToNull(input.summary_text ?? null);
  const rawEnrichedSummary = emptyToNull(input.enriched_summary_text ?? null);
  const invalidReason =
    rawEnrichedSummary && input.enrichment_source === "llm"
      ? invalidSessionSummaryEnrichmentReason(rawEnrichedSummary)
      : null;
  const enrichedSummary =
    rawEnrichedSummary && input.enrichment_source === "llm" && !invalidReason
      ? rawEnrichedSummary
      : null;
  const staleReasons = enrichmentStaleReasons(input);
  const syntheticSummary = input.allow_synthetic_fallback
    ? buildSyntheticSummary(input)
    : null;
  const summaryText =
    enrichedSummary ?? deterministicSummary ?? syntheticSummary;
  const summarySource: SessionSummaryDisplaySource = enrichedSummary
    ? "llm"
    : deterministicSummary
      ? "deterministic"
      : syntheticSummary
        ? "synthetic"
        : null;

  return {
    summaryText,
    summarySource,
    enrichment: {
      summaryText: enrichedSummary,
      invalidReason,
      dirty: input.enrichment_dirty === true,
      stale: staleReasons.length > 0,
      staleReasons,
      summaryVersion: input.enrichment_summary_version ?? null,
      currentSummaryVersion: SESSION_SUMMARY_ENRICHMENT_VERSION,
    },
  };
}

function enrichmentStaleReasons(
  input: SessionSummaryDisplayInput,
): SessionSummaryStaleReason[] {
  const reasons: SessionSummaryStaleReason[] = [];
  if (input.enrichment_dirty === true) reasons.push("dirty");
  if (
    input.enrichment_summary_version !== null &&
    input.enrichment_summary_version !== undefined &&
    input.enrichment_summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION
  ) {
    reasons.push("summary_version_changed");
  }
  if (
    input.current_policy_hash &&
    input.enrichment_policy_hash &&
    input.enrichment_policy_hash !== input.current_policy_hash
  ) {
    reasons.push("summary_policy_changed");
  }
  return reasons;
}

function buildSyntheticSummary(
  input: SessionSummaryDisplayInput,
): string | null {
  const title = emptyToNull(input.title ?? null);
  const status = emptyToNull(input.status ?? null);
  if (!title || !status) return null;
  const intents = input.intent_count ?? 0;
  const edits = input.edit_count ?? 0;
  const landed = input.landed_edit_count ?? 0;
  const open = input.open_edit_count ?? 0;
  const files =
    input.top_files && input.top_files.length > 0
      ? ` Top files: ${input.top_files.join(", ")}.`
      : "";
  return `${title}. Status: ${status}. ${intents} intents, ${edits} edits, ${landed} landed, ${open} open.${files}`;
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
