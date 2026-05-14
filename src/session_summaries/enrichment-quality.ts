const SESSION_SUMMARY_ENRICHMENT_FAILURE_PATTERNS = [
  /(?:could not|couldn't|cannot|can't|unable to|not able to).{0,100}(?:load|loaded|retrieve|access|fetch|complete).{0,100}(?:session|structured|panopticon).{0,100}(?:data|details|summary|lookup)/i,
  /(?:session|mcp|tool).{0,100}(?:request|lookup|tool call).{0,100}(?:cancelled|canceled|failed)/i,
  /(?:cancelled|canceled|failed).{0,100}(?:mcp|tool|session summary|session data|session details|panopticon)/i,
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
