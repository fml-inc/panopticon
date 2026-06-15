/**
 * Point-in-time cutoff helpers shared by provenance queries.
 *
 * Replay and clock-overridden callers pass an `untilMs` so historical context
 * injection does not see provenance from after the replay point. Live callers
 * pass nothing and get the full, present-day view.
 */

/** Coerce an optional cutoff into a finite number or null. */
export function normalizeUntilMs(
  value: number | null | undefined,
): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build the optional `AND <expr> <= ?` cutoff clause for a query.
 *
 * Cutoff queries are replay-time views: rows with no usable timestamp are
 * excluded because Panopticon cannot prove they existed before the replay
 * point. Live queries pass no cutoff and still include timestamp-less rows.
 */
export function buildTimestampCutoffClause(
  timestampExpr: string,
  untilMs: number | null,
): string {
  return untilMs === null ? "" : `AND ${timestampExpr} <= ?`;
}
