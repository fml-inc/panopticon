export interface SessionSummaryActivitySqlAliases {
  summaryAlias?: string;
  sessionAlias?: string;
}

export function sessionSummaryLastActivitySql(
  opts: SessionSummaryActivitySqlAliases = {},
): string {
  const summaryAlias = opts.summaryAlias ?? "s";
  const sessionAlias = opts.sessionAlias ?? "sess";
  return `MAX(
  COALESCE(${summaryAlias}.source_last_seen_at_ms, 0),
  COALESCE(${summaryAlias}.last_intent_ts_ms, 0),
  COALESCE(${sessionAlias}.ended_at_ms, 0),
  COALESCE(${sessionAlias}.started_at_ms, 0)
)`;
}
