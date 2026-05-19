export function tokenizeSearchTerms(query: string, minLength = 3): string[] {
  const matches = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(matches.filter((term) => term.length >= minLength))];
}

export function buildSafeFtsQuery(query: string): string | null {
  // FTS5 trigram matching is poor for sub-3-char tokens and raw punctuation can
  // trigger MATCH parser errors, so keep this stricter than LIKE fallbacks.
  const terms = tokenizeSearchTerms(query, 3);
  return terms.length > 0 ? terms.join(" AND ") : null;
}
