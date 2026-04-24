export const SESSION_SUMMARY_SEARCH_CORPUS = {
  deterministicSummary: "deterministic_summary",
  deterministicSearch: "deterministic_search",
  llmSummary: "llm_summary",
  llmSearch: "llm_search",
} as const;

export const SESSION_SUMMARY_SEARCH_PRIORITY = {
  deterministicSummary: 40,
  deterministicSearch: 30,
  llmSummary: 100,
  llmSearch: 90,
} as const;
