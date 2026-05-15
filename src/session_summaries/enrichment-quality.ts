const SESSION_SUMMARY_ENRICHMENT_FAILURE_PATTERNS = [
  /(?:could not|couldn't|cannot|can't|unable to|not able to).{0,100}(?:load|loaded|retrieve|access|fetch|complete).{0,100}(?:session|structured|panopticon).{0,100}(?:data|details|summary|lookup)/i,
  /(?:no code changed because|could not|couldn't|cannot|can't|unable to|not able to).{0,160}(?:session|mcp|tool|panopticon).{0,160}(?:request|lookup|tool call).{0,160}(?:cancelled|canceled|failed)/i,
  /no structured session data to summarize/i,
  /provided no structured session data/i,
] as const;

export function invalidSessionSummaryEnrichmentReason(
  text: string | null | undefined,
): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return "empty summary text";

  for (const pattern of SESSION_SUMMARY_ENRICHMENT_FAILURE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "summary text reports unavailable session data";
    }
  }

  return null;
}

export function isValidSessionSummaryEnrichmentText(
  text: string | null | undefined,
): boolean {
  return invalidSessionSummaryEnrichmentReason(text) === null;
}
