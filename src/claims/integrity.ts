import { getDb } from "../db/schema.js";

export function resolveEvidenceKey(key: string): unknown | null {
  const db = getDb();
  if (key.startsWith("message:")) {
    const remainder = key.slice("message:".length);
    const splitAt = remainder.lastIndexOf(":");
    if (splitAt <= 0) return null;
    const sessionId = remainder.slice(0, splitAt);
    const ordinal = remainder.slice(splitAt + 1);
    return (
      db
        .prepare(
          `SELECT id, session_id, ordinal
           FROM messages WHERE session_id = ? AND ordinal = ?`,
        )
        .get(sessionId, Number(ordinal)) ?? null
    );
  }
  if (key.startsWith("tool:")) {
    const toolUseId = key.slice("tool:".length);
    return (
      db
        .prepare(`SELECT id, tool_use_id FROM tool_calls WHERE tool_use_id = ?`)
        .get(toolUseId) ?? null
    );
  }
  if (key.startsWith("tool_local:")) {
    const remainder = key.slice("tool_local:".length);
    const last = remainder.lastIndexOf(":");
    if (last <= 0) return null;
    const secondLast = remainder.lastIndexOf(":", last - 1);
    if (secondLast <= 0) return null;
    const sessionId = remainder.slice(0, secondLast);
    const ordinal = remainder.slice(secondLast + 1, last);
    const toolCallIndex = remainder.slice(last + 1);
    return (
      db
        .prepare(
          `SELECT tc.id
           FROM tool_calls tc
           JOIN messages m ON m.id = tc.message_id
           WHERE tc.session_id = ? AND m.ordinal = ?
           ORDER BY tc.id ASC
           LIMIT 1 OFFSET ?`,
        )
        .get(sessionId, Number(ordinal), Number(toolCallIndex)) ?? null
    );
  }
  if (key.startsWith("hook:")) {
    const id = Number(key.slice("hook:".length));
    return (
      db.prepare(`SELECT id FROM hook_events WHERE id = ?`).get(id) ?? null
    );
  }
  if (key.startsWith("claim:")) {
    const observationKey = key.slice("claim:".length);
    return (
      db
        .prepare(
          `SELECT id, observation_key FROM claims WHERE observation_key = ?`,
        )
        .get(observationKey) ?? null
    );
  }
  if (
    key.startsWith("git_commit:") ||
    key.startsWith("git_hunk:") ||
    key.startsWith("fs_snapshot:")
  ) {
    return { key };
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
    .prepare(`SELECT evidence_key FROM claim_evidence ORDER BY id ASC`)
    .all() as Array<{ evidence_key: string }>;
  const dangling: string[] = [];
  for (const row of rows) {
    if (!resolveEvidenceKey(row.evidence_key)) {
      dangling.push(row.evidence_key);
    }
  }
  return {
    total: rows.length,
    dangling: dangling.length,
    examples: dangling.slice(0, 20),
  };
}
