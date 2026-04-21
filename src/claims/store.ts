import { getDb } from "../db/schema.js";
import { selectActiveClaimForHeadKey } from "./canonicalize.js";
import { ensureEvidenceRef } from "./evidence-refs.js";
import {
  claimHeadKey,
  encodeClaimValue,
  normalizedValueForKey,
  observationKey,
} from "./keys.js";
import { getPredicateSpec, sourceRank } from "./predicates.js";
import type { AssertClaimInput, EvidenceRefInput } from "./types.js";

export interface AssertClaimResult {
  claimId: number;
  inserted: boolean;
  headKey: string;
}

interface NormalizedEvidenceItem {
  key: string;
  role?: "origin" | "supporting" | "refuting" | "context";
  detail?: unknown;
  evidenceRef: EvidenceRefInput;
}

export function assertClaim(input: AssertClaimInput): AssertClaimResult {
  const db = getDb();
  const spec = getPredicateSpec(input.predicate);
  const encoded = encodeClaimValue(input.value);
  const normalizedValue = normalizedValueForKey(spec.valueKind, encoded);
  const headKey = claimHeadKey(
    input.predicate,
    input.subject,
    spec.valueKind,
    normalizedValue,
  );
  const evidence = (input.evidence ?? []).map((item) => {
    if (!item.ref.refKey) {
      throw new Error("Claim evidence ref_key is required");
    }
    return {
      key: item.ref.refKey,
      role: item.role,
      detail: item.detail,
      evidenceRef: item.ref,
    } satisfies NormalizedEvidenceItem;
  });
  const obsKey = observationKey({
    predicate: input.predicate,
    subject: input.subject,
    normalizedValue,
    evidence: input.evidence ?? [],
    sourceType: input.sourceType,
    asserter: input.asserter,
    asserterVersion: input.asserterVersion,
    observedAtMs: input.observedAtMs,
  });
  const now = Date.now();
  let inserted = false;
  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO claims
         (observation_key, head_key, predicate, subject_kind, subject,
          value_kind, value_text, value_num, value_json,
          source_type, source_rank, confidence, observed_at_ms, asserted_at_ms,
          asserter, asserter_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        obsKey,
        headKey,
        input.predicate,
        input.subjectKind,
        input.subject,
        encoded.valueKind,
        encoded.valueText,
        encoded.valueNum,
        encoded.valueJson,
        input.sourceType,
        sourceRank(input.predicate, input.sourceType),
        input.confidence ?? 1,
        input.observedAtMs,
        now,
        input.asserter,
        input.asserterVersion,
      );
    inserted = result.changes > 0;
    const row = db
      .prepare(`SELECT id FROM claims WHERE observation_key = ?`)
      .get(obsKey) as { id: number };
    if (inserted && evidence.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO claim_evidence (claim_id, evidence_ref_id, detail, role)
         VALUES (?, ?, ?, ?)`,
      );
      for (const item of evidence) {
        const evidenceRefId = ensureEvidenceRef(db, item.evidenceRef);
        stmt.run(
          row.id,
          evidenceRefId,
          item.detail ? JSON.stringify(item.detail) : null,
          item.role ?? "supporting",
        );
      }
    }
    if (input.canonicalize !== false) {
      selectActiveClaimForHeadKey(headKey);
    }
  });
  tx();
  const row = db
    .prepare(`SELECT id FROM claims WHERE observation_key = ?`)
    .get(obsKey) as { id: number };
  return { claimId: row.id, inserted, headKey };
}

export function deleteClaimsByAsserter(asserter: string): number {
  const db = getDb();
  const tx = db.transaction(() => {
    const ids = db
      .prepare(`SELECT id, head_key FROM claims WHERE asserter = ?`)
      .all(asserter) as Array<{ id: number; head_key: string }>;
    if (ids.length === 0) return 0;
    const idList = ids.map((row) => row.id);
    const placeholders = idList.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM claim_evidence WHERE claim_id IN (${placeholders})`,
    ).run(...idList);
    db.prepare(`DELETE FROM claims WHERE id IN (${placeholders})`).run(
      ...idList,
    );
    for (const headKey of new Set(ids.map((row) => row.head_key))) {
      selectActiveClaimForHeadKey(headKey);
    }
    return ids.length;
  });
  return tx();
}

export function deleteClaimsByAsserterForSession(
  asserter: string,
  sessionId: string,
): number {
  const db = getDb();
  const tx = db.transaction(() => {
    const intentSubjects = (
      db
        .prepare(
          `SELECT DISTINCT subject
           FROM claims
           WHERE predicate = 'intent/session' AND value_text = ?`,
        )
        .all(sessionId) as Array<{ subject: string }>
    ).map((row) => row.subject);
    if (intentSubjects.length === 0) return 0;

    const intentPlaceholders = intentSubjects.map(() => "?").join(",");
    const editSubjects = (
      db
        .prepare(
          `SELECT DISTINCT subject
           FROM claims
           WHERE predicate = 'edit/part-of-intent'
             AND value_text IN (${intentPlaceholders})`,
        )
        .all(...intentSubjects) as Array<{ subject: string }>
    ).map((row) => row.subject);

    const subjects = [...new Set([...intentSubjects, ...editSubjects])];
    const subjectPlaceholders = subjects.map(() => "?").join(",");
    const ids = db
      .prepare(
        `SELECT id, head_key
         FROM claims
         WHERE asserter = ? AND subject IN (${subjectPlaceholders})`,
      )
      .all(asserter, ...subjects) as Array<{ id: number; head_key: string }>;
    if (ids.length === 0) return 0;

    const idList = ids.map((row) => row.id);
    const idPlaceholders = idList.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM claim_evidence WHERE claim_id IN (${idPlaceholders})`,
    ).run(...idList);
    db.prepare(`DELETE FROM claims WHERE id IN (${idPlaceholders})`).run(
      ...idList,
    );
    for (const headKey of new Set(ids.map((row) => row.head_key))) {
      selectActiveClaimForHeadKey(headKey);
    }
    return ids.length;
  });
  return tx();
}
