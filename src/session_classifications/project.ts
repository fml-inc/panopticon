import {
  getDb,
  markSessionClassificationComplete,
  needsSessionClassificationRebuild,
} from "../db/schema.js";
import {
  classifySession,
  type SessionClassification,
  type SessionClassificationSignals,
} from "./classifier.js";

export const SESSION_CLASSIFIER_VERSION = 1;

interface SessionClassificationRow extends SessionClassificationSignals {
  sessionId: string;
}

export interface SessionClassificationProjectionResult {
  sessions: number;
  classified: number;
  interactive: number;
  automated: number;
  unclassified: number;
  changed: number;
}

export function ensureSessionClassifications(): void {
  if (needsSessionClassificationRebuild()) {
    rebuildSessionClassifications();
  }
}

export function refreshSessionClassification(
  sessionId: string,
  nowMs = Date.now(),
): { changed: boolean; classification: SessionClassification | null } {
  const db = getDb();
  const row = loadSessionClassificationRow(sessionId);
  const result = row ? classifySession(row) : null;
  const existing = db
    .prepare(
      `SELECT classification, reason, classifier_version
       FROM session_classifications
       WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        classification: SessionClassification;
        reason: string;
        classifier_version: number;
      }
    | undefined;

  if (!result) {
    if (existing) {
      db.prepare(
        `DELETE FROM session_classifications
         WHERE session_id = ?`,
      ).run(sessionId);
      bumpDerivedSyncSeq(sessionId);
      return { changed: true, classification: null };
    }
    return { changed: false, classification: null };
  }

  const changed =
    !existing ||
    existing.classification !== result.classification ||
    existing.reason !== result.reason ||
    existing.classifier_version !== SESSION_CLASSIFIER_VERSION;

  if (changed) {
    db.prepare(
      `INSERT INTO session_classifications
       (session_id, classification, reason, classifier_version, computed_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         classification = excluded.classification,
         reason = excluded.reason,
         classifier_version = excluded.classifier_version,
         computed_at_ms = excluded.computed_at_ms`,
    ).run(
      sessionId,
      result.classification,
      result.reason,
      SESSION_CLASSIFIER_VERSION,
      nowMs,
    );
    bumpDerivedSyncSeq(sessionId);
  }

  return { changed, classification: result.classification };
}

export function rebuildSessionClassifications(opts?: {
  sessionId?: string;
  nowMs?: number;
}): SessionClassificationProjectionResult {
  const db = getDb();
  const nowMs = opts?.nowMs ?? Date.now();
  const rows = loadSessionClassificationRows(opts?.sessionId);
  const existingRows = db
    .prepare(
      opts?.sessionId
        ? `SELECT session_id, classification, reason, classifier_version
           FROM session_classifications
           WHERE session_id = ?`
        : `SELECT session_id, classification, reason, classifier_version
           FROM session_classifications`,
    )
    .all(...(opts?.sessionId ? [opts.sessionId] : [])) as Array<{
    session_id: string;
    classification: SessionClassification;
    reason: string;
    classifier_version: number;
  }>;
  const existing = new Map(existingRows.map((row) => [row.session_id, row]));

  const upsert = db.prepare(
    `INSERT INTO session_classifications
     (session_id, classification, reason, classifier_version, computed_at_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       classification = excluded.classification,
       reason = excluded.reason,
       classifier_version = excluded.classifier_version,
       computed_at_ms = excluded.computed_at_ms`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM session_classifications
     WHERE session_id = ?`,
  );
  const bumpStmt = db.prepare(
    `UPDATE sessions
     SET derived_sync_seq = COALESCE(derived_sync_seq, 0) + 1
     WHERE session_id = ?`,
  );

  const seen = new Set<string>();
  let classified = 0;
  let interactive = 0;
  let automated = 0;
  let unclassified = 0;
  let changed = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      seen.add(row.sessionId);
      const result = classifySession(row);
      if (!result) {
        unclassified += 1;
        if (existing.has(row.sessionId)) {
          deleteStmt.run(row.sessionId);
          bumpStmt.run(row.sessionId);
          changed += 1;
        }
        continue;
      }

      classified += 1;
      if (result.classification === "interactive") interactive += 1;
      if (result.classification === "automated") automated += 1;

      const prior = existing.get(row.sessionId);
      const rowChanged =
        !prior ||
        prior.classification !== result.classification ||
        prior.reason !== result.reason ||
        prior.classifier_version !== SESSION_CLASSIFIER_VERSION;
      if (rowChanged) {
        upsert.run(
          row.sessionId,
          result.classification,
          result.reason,
          SESSION_CLASSIFIER_VERSION,
          nowMs,
        );
        bumpStmt.run(row.sessionId);
        changed += 1;
      }
    }

    for (const prior of existing.values()) {
      if (seen.has(prior.session_id)) continue;
      deleteStmt.run(prior.session_id);
      bumpStmt.run(prior.session_id);
      changed += 1;
    }
  });
  tx();

  if (!opts?.sessionId) {
    markSessionClassificationComplete();
  }

  return {
    sessions: rows.length,
    classified,
    interactive,
    automated,
    unclassified,
    changed,
  };
}

function loadSessionClassificationRow(
  sessionId: string,
): SessionClassificationRow | null {
  return loadSessionClassificationRows(sessionId)[0] ?? null;
}

function loadSessionClassificationRows(
  sessionId?: string,
): SessionClassificationRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.session_id,
              s.target,
              s.first_prompt,
              s.model,
              s.models,
              s.project,
              COALESCE(
                s.cwd,
                (
                  SELECT scw.cwd
                  FROM session_cwds scw
                  WHERE scw.session_id = s.session_id
                  ORDER BY scw.first_seen_ms ASC
                  LIMIT 1
                )
              ) AS cwd,
              COALESCE(s.user_message_count, 0) AS user_message_count,
              CASE
                WHEN COALESCE(json_extract(s.hook_event_type_counts, '$.UserPromptSubmit'), 0) > 0
                  OR EXISTS (
                    SELECT 1
                    FROM hook_events he
                    WHERE he.session_id = s.session_id
                      AND he.event_type = 'UserPromptSubmit'
                  )
                THEN 1
                ELSE 0
              END AS has_user_prompt_submit,
              s.parent_session_id,
              s.relationship_type
       FROM sessions s
       ${sessionId ? "WHERE s.session_id = ?" : ""}
       ORDER BY s.session_id ASC`,
    )
    .all(...(sessionId ? [sessionId] : []))
    .map((row) => {
      const r = row as {
        session_id: string;
        target: string | null;
        first_prompt: string | null;
        model: string | null;
        models: string | null;
        project: string | null;
        cwd: string | null;
        user_message_count: number;
        has_user_prompt_submit: number;
        parent_session_id: string | null;
        relationship_type: string | null;
      };
      return {
        sessionId: r.session_id,
        target: r.target,
        firstPrompt: r.first_prompt,
        model: r.model,
        models: r.models,
        project: r.project,
        cwd: r.cwd,
        userMessageCount: r.user_message_count,
        hasUserPromptSubmit: r.has_user_prompt_submit > 0,
        parentSessionId: r.parent_session_id,
        relationshipType: r.relationship_type,
      };
    });
}

function bumpDerivedSyncSeq(sessionId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions
     SET derived_sync_seq = COALESCE(derived_sync_seq, 0) + 1
     WHERE session_id = ?`,
  ).run(sessionId);
}
