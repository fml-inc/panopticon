import { getDb } from "../db/schema.js";
import { flattenDeltas, shouldFlatten } from "./flatten.js";
import { DELTA_INTERVAL, generateDelta } from "./generate.js";
import {
  deleteSummaryDeltas,
  insertSummaryDelta,
  readSummaryDeltas,
  updateSessionSummary,
} from "./store.js";

/**
 * Generate summaries for all sessions that have new turn data.
 * Called after scanner completes a scan cycle.
 */
export function generateSummariesOnce(log: (msg: string) => void = () => {}): {
  updated: number;
} {
  const db = getDb();
  let updated = 0;

  // Find sessions with enough new turns since last summary
  // summary_version tracks how many turns have been summarized (in units of DELTA_INTERVAL)
  const sessions = db
    .prepare(
      `
    SELECT session_id, turn_count, summary_version
    FROM sessions
    WHERE turn_count > 0
      AND turn_count >= (COALESCE(summary_version, 0) + 1) * ?
  `,
    )
    .all(DELTA_INTERVAL) as Array<{
    session_id: string;
    turn_count: number;
    summary_version: number | null;
  }>;

  for (const sess of sessions) {
    const currentVersion = sess.summary_version ?? 0;
    const fromTurn = currentVersion * DELTA_INTERVAL;
    const toTurn = fromTurn + DELTA_INTERVAL;

    const delta = generateDelta(sess.session_id, fromTurn, toTurn);
    if (!delta) continue;

    insertSummaryDelta(delta);
    const newVersion = currentVersion + 1;

    // Check if we should flatten
    const allDeltas = readSummaryDeltas(sess.session_id);
    if (shouldFlatten(allDeltas)) {
      const flatSummary = flattenDeltas(allDeltas);
      deleteSummaryDeltas(sess.session_id);
      updateSessionSummary(sess.session_id, flatSummary, newVersion);
      log(
        `Flattened summary for ${sess.session_id} (${allDeltas.length} deltas → 1)`,
      );
    } else {
      // Build summary from all deltas
      const summary = allDeltas.map((d) => d.content).join(" | ");
      updateSessionSummary(sess.session_id, summary, newVersion);
    }

    updated++;
  }

  if (updated > 0) {
    log(`Updated summaries for ${updated} sessions`);
  }

  return { updated };
}
