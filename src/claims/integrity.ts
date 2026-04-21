import { getDb } from "../db/schema.js";
import { loadEvidenceRefById } from "./evidence-refs.js";

export function resolveEvidenceRef(refId: number): unknown | null {
  const db = getDb();
  const ref = loadEvidenceRefById(db, refId);
  if (!ref) return null;
  if (ref.kind === "message") {
    if (!ref.sync_id) return null;
    return (
      db
        .prepare(
          `SELECT id, session_id, ordinal, sync_id
           FROM messages WHERE sync_id = ?`,
        )
        .get(ref.sync_id) ?? null
    );
  }
  if (ref.kind === "tool_call") {
    if (!ref.sync_id) return null;
    return (
      db
        .prepare(
          `SELECT id, session_id, call_index, tool_use_id, sync_id
           FROM tool_calls WHERE sync_id = ?`,
        )
        .get(ref.sync_id) ?? null
    );
  }
  if (ref.kind === "scanner_turn") {
    if (!ref.sync_id) return null;
    return (
      db
        .prepare(
          `SELECT id, session_id, source, turn_index, sync_id
           FROM scanner_turns WHERE sync_id = ?`,
        )
        .get(ref.sync_id) ?? null
    );
  }
  if (ref.kind === "scanner_event") {
    if (!ref.sync_id) return null;
    return (
      db
        .prepare(
          `SELECT id, session_id, source, event_index, sync_id
           FROM scanner_events WHERE sync_id = ?`,
        )
        .get(ref.sync_id) ?? null
    );
  }
  if (ref.kind === "hook_event") {
    if (!ref.sync_id) return null;
    return (
      db
        .prepare(
          `SELECT id, session_id, sync_id
           FROM hook_events WHERE sync_id = ?`,
        )
        .get(ref.sync_id) ?? null
    );
  }
  if (ref.kind === "otel_log") {
    if (!ref.sync_id) return null;
    return (
      db
        .prepare(
          `SELECT id, session_id, sync_id
           FROM otel_logs WHERE sync_id = ?`,
        )
        .get(ref.sync_id) ?? null
    );
  }
  if (ref.kind === "otel_metric") {
    if (!ref.sync_id) return null;
    return (
      db
        .prepare(
          `SELECT id, session_id, sync_id
           FROM otel_metrics WHERE sync_id = ?`,
        )
        .get(ref.sync_id) ?? null
    );
  }
  if (ref.kind === "otel_span") {
    if (!ref.trace_id || !ref.span_id) return null;
    return (
      db
        .prepare(
          `SELECT id, trace_id, span_id
           FROM otel_spans WHERE trace_id = ? AND span_id = ?`,
        )
        .get(ref.trace_id, ref.span_id) ?? null
    );
  }
  if (
    ref.kind === "git_commit" ||
    ref.kind === "git_hunk" ||
    ref.kind === "file_snapshot"
  ) {
    return { key: ref.ref_key };
  }
  return null;
}

export function runIntegrityCheck(): {
  total: number;
  dangling: number;
  examples: string[];
} {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT evidence_ref_id
       FROM claim_evidence
       ORDER BY id ASC`,
    )
    .all() as Array<{
    evidence_ref_id: number;
  }>;
  const dangling: string[] = [];
  for (const row of rows) {
    const resolved = resolveEvidenceRef(row.evidence_ref_id);
    if (!resolved) {
      dangling.push(`evidence_ref:${row.evidence_ref_id}`);
    }
  }
  return {
    total: rows.length,
    dangling: dangling.length,
    examples: dangling.slice(0, 20),
  };
}
