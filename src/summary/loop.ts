import { getDb } from "../db/schema.js";
import { flattenDeltas, shouldFlatten } from "./flatten.js";
import { DELTA_INTERVAL, generateDelta } from "./generate.js";
import {
  deleteSummaryDeltas,
  insertSummaryDelta,
  readSummaryDeltas,
  updateSessionSummary,
} from "./store.js";

// Max sessions to summarize per cycle. Each invocation spawns a claude -p
// process, so we cap to avoid resource spikes after a cold-start backfill.
const MAX_SESSIONS_PER_CYCLE = 5;

/**
 * Generate summaries for sessions that have new turn data.
 * Called when the scanner is idle (no new files to process).
 * Processes at most MAX_SESSIONS_PER_CYCLE sessions per call,
 * prioritizing the most recently active.
 */
export function generateSummariesOnce(log: (msg: string) => void = () => {}): {
  updated: number;
} {
  const db = getDb();
  let updated = 0;

  // Find sessions with enough new turns since last summary.
  // Prioritize recently active sessions and cap per cycle.
  const sessions = db
    .prepare(
      `
    SELECT session_id, turn_count, summary_version
    FROM sessions
    WHERE turn_count > 0
      AND turn_count >= (COALESCE(summary_version, 0) + 1) * ?
    ORDER BY started_at_ms DESC
    LIMIT ?
  `,
    )
    .all(DELTA_INTERVAL, MAX_SESSIONS_PER_CYCLE) as Array<{
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
