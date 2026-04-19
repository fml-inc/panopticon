import { getDb } from "../db/schema.js";
import type { ClaimRow } from "./types.js";

function rankClaims(a: ClaimRow, b: ClaimRow): number {
  if (a.source_rank !== b.source_rank) return b.source_rank - a.source_rank;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.observed_at_ms !== b.observed_at_ms) {
    return b.observed_at_ms - a.observed_at_ms;
  }
  if (a.asserted_at_ms !== b.asserted_at_ms) {
    return b.asserted_at_ms - a.asserted_at_ms;
  }
  return b.id - a.id;
}

export function selectActiveClaimForHeadKey(headKey: string): number | null {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, observation_key, head_key, predicate, subject_kind, subject,
              value_kind, value_text, value_num, value_json,
              source_type, source_rank, confidence, observed_at_ms,
              asserted_at_ms, asserter, asserter_version
       FROM claims
       WHERE head_key = ?`,
    )
    .all(headKey) as ClaimRow[];
  if (rows.length === 0) {
    db.prepare(`DELETE FROM active_claims WHERE head_key = ?`).run(headKey);
    return null;
  }
  rows.sort(rankClaims);
  const winner = rows[0];
  db.prepare(
    `INSERT INTO active_claims (head_key, claim_id, selected_at_ms, selection_reason)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(head_key) DO UPDATE SET
       claim_id = excluded.claim_id,
       selected_at_ms = excluded.selected_at_ms,
       selection_reason = excluded.selection_reason`,
  ).run(
    headKey,
    winner.id,
    Date.now(),
    "source_rank,confidence,observed_at_ms,asserted_at_ms",
  );
  return winner.id;
}

export function rebuildActiveClaims(): number {
  const db = getDb();
  const headKeys = db
    .prepare(`SELECT DISTINCT head_key FROM claims ORDER BY head_key ASC`)
    .all() as Array<{ head_key: string }>;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM active_claims`).run();
    for (const row of headKeys) {
      selectActiveClaimForHeadKey(row.head_key);
    }
  });
  tx();
  return headKeys.length;
}
