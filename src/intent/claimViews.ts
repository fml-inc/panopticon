import { getDb } from "../db/schema.js";

export interface ActiveIntent {
  intentKey: string;
  promptText?: string;
  promptTsMs?: number;
  promptTsSource?: string;
  sessionId?: string;
  repository?: string | null;
  cwd?: string | null;
  closedAtMs?: number | null;
}

export interface ActiveEdit {
  editKey: string;
  intentKey?: string;
  filePath?: string;
  toolName?: string;
  multiEditIndex?: number;
  newStringHash?: string;
  newStringSnippet?: string | null;
  timestampMs?: number;
  timestampSource?: string;
  hookEventId?: number | null;
  payloadEvidenceRefId?: number | null;
  payloadEvidenceKey?: string | null;
  landedStatus?: string | null;
  landedReason?: string | null;
}

interface LoadActiveClaimOptions {
  sessionId?: string;
}

interface ActiveClaimRow {
  subject: string;
  predicate: string;
  value_kind: string;
  value_text: string | null;
  value_num: number | null;
  value_json: string | null;
  source_type: string;
}

function loadActiveIntentRows(sessionId?: string): ActiveClaimRow[] {
  const db = getDb();
  if (!sessionId) {
    return db
      .prepare(
        `SELECT c.subject, c.predicate, c.value_kind, c.value_text, c.value_num, c.value_json, c.source_type
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.subject_kind = 'intent'`,
      )
      .all() as ActiveClaimRow[];
  }
  return db
    .prepare(
      `WITH scoped_intents AS (
         SELECT DISTINCT c.subject
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.subject_kind = 'intent'
           AND c.predicate = 'intent/session'
           AND c.value_text = ?
       )
       SELECT c.subject, c.predicate, c.value_kind, c.value_text, c.value_num, c.value_json, c.source_type
       FROM active_claims ac
       JOIN claims c ON c.id = ac.claim_id
       WHERE c.subject_kind = 'intent'
         AND c.subject IN (SELECT subject FROM scoped_intents)`,
    )
    .all(sessionId) as ActiveClaimRow[];
}

function loadActiveEditRows(sessionId?: string): ActiveClaimRow[] {
  const db = getDb();
  if (!sessionId) {
    return db
      .prepare(
        `SELECT c.subject, c.predicate, c.value_kind, c.value_text, c.value_num, c.value_json, c.source_type
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.subject_kind = 'edit'`,
      )
      .all() as ActiveClaimRow[];
  }
  return db
    .prepare(
      `WITH scoped_intents AS (
         SELECT DISTINCT c.subject
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.subject_kind = 'intent'
           AND c.predicate = 'intent/session'
           AND c.value_text = ?
       ),
       scoped_edits AS (
         SELECT DISTINCT c.subject
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.subject_kind = 'edit'
           AND c.predicate = 'edit/part-of-intent'
           AND c.value_text IN (SELECT subject FROM scoped_intents)
       )
       SELECT c.subject, c.predicate, c.value_kind, c.value_text, c.value_num, c.value_json, c.source_type
       FROM active_claims ac
       JOIN claims c ON c.id = ac.claim_id
       WHERE c.subject_kind = 'edit'
         AND c.subject IN (SELECT subject FROM scoped_edits)`,
    )
    .all(sessionId) as ActiveClaimRow[];
}

interface ActiveEditEvidenceRow {
  subject: string;
  evidence_ref_id: number;
  evidence_ref_key: string;
  hook_event_id: number | null;
}

function loadActiveEditEvidenceRows(
  sessionId?: string,
): ActiveEditEvidenceRow[] {
  const db = getDb();
  if (!sessionId) {
    return db
      .prepare(
        `SELECT c.subject,
                ce.evidence_ref_id,
                er.ref_key AS evidence_ref_key,
                he.id AS hook_event_id
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         JOIN claim_evidence ce ON ce.claim_id = c.id
         JOIN evidence_refs er ON er.id = ce.evidence_ref_id
         LEFT JOIN hook_events he
           ON er.kind = 'hook_event'
          AND he.sync_id = er.sync_id
         WHERE c.subject_kind = 'edit'
           AND er.kind IN ('hook_event', 'tool_call')
         ORDER BY
           CASE
             WHEN er.kind = 'hook_event' THEN 0
             ELSE 1
           END,
           ce.id ASC`,
      )
      .all() as ActiveEditEvidenceRow[];
  }
  return db
    .prepare(
      `WITH scoped_intents AS (
         SELECT DISTINCT c.subject
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.subject_kind = 'intent'
           AND c.predicate = 'intent/session'
           AND c.value_text = ?
       ),
       scoped_edits AS (
         SELECT DISTINCT c.subject
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.subject_kind = 'edit'
           AND c.predicate = 'edit/part-of-intent'
           AND c.value_text IN (SELECT subject FROM scoped_intents)
       )
       SELECT c.subject,
              ce.evidence_ref_id,
              er.ref_key AS evidence_ref_key,
              he.id AS hook_event_id
       FROM active_claims ac
       JOIN claims c ON c.id = ac.claim_id
       JOIN claim_evidence ce ON ce.claim_id = c.id
       JOIN evidence_refs er ON er.id = ce.evidence_ref_id
       LEFT JOIN hook_events he
         ON er.kind = 'hook_event'
        AND he.sync_id = er.sync_id
       WHERE c.subject_kind = 'edit'
         AND c.subject IN (SELECT subject FROM scoped_edits)
         AND er.kind IN ('hook_event', 'tool_call')
       ORDER BY
         CASE
           WHEN er.kind = 'hook_event' THEN 0
           ELSE 1
         END,
         ce.id ASC`,
    )
    .all(sessionId) as ActiveEditEvidenceRow[];
}

export function loadActiveIntents(
  opts?: LoadActiveClaimOptions,
): Map<string, ActiveIntent> {
  const rows = loadActiveIntentRows(opts?.sessionId);

  const intents = new Map<string, ActiveIntent>();
  for (const row of rows) {
    const intent = intents.get(row.subject) ?? { intentKey: row.subject };
    const value =
      row.value_kind === "num"
        ? (row.value_num ?? undefined)
        : row.value_kind === "json"
          ? (row.value_json ?? undefined)
          : (row.value_text ?? undefined);
    switch (row.predicate) {
      case "intent/prompt-text":
        intent.promptText = value as string | undefined;
        break;
      case "intent/prompt-ts-ms":
        intent.promptTsMs = Number(value);
        intent.promptTsSource = row.source_type;
        break;
      case "intent/session":
        intent.sessionId = value as string | undefined;
        break;
      case "intent/repository":
        intent.repository = (value as string | undefined) ?? null;
        break;
      case "intent/cwd":
        intent.cwd = (value as string | undefined) ?? null;
        break;
      case "intent/closed-at-ms":
        intent.closedAtMs = value == null ? null : Number(value);
        break;
    }
    intents.set(row.subject, intent);
  }
  return intents;
}

export function loadActiveEdits(
  opts?: LoadActiveClaimOptions,
): Map<string, ActiveEdit> {
  const rows = loadActiveEditRows(opts?.sessionId);

  const edits = new Map<string, ActiveEdit>();
  for (const row of rows) {
    const edit = edits.get(row.subject) ?? { editKey: row.subject };
    const value =
      row.value_kind === "num"
        ? (row.value_num ?? undefined)
        : row.value_kind === "json"
          ? (row.value_json ?? undefined)
          : (row.value_text ?? undefined);
    switch (row.predicate) {
      case "edit/part-of-intent":
        edit.intentKey = value as string | undefined;
        break;
      case "edit/file":
        edit.filePath = value as string | undefined;
        break;
      case "edit/tool-name":
        edit.toolName = value as string | undefined;
        break;
      case "edit/multi-edit-index":
        edit.multiEditIndex = Number(value);
        break;
      case "edit/new-string-hash":
        edit.newStringHash = value as string | undefined;
        break;
      case "edit/new-string-snippet":
        edit.newStringSnippet = (value as string | undefined) ?? null;
        break;
      case "edit/timestamp-ms":
        edit.timestampMs = Number(value);
        edit.timestampSource = row.source_type;
        break;
      case "edit/landed-status":
        edit.landedStatus = (value as string | undefined) ?? null;
        break;
      case "edit/landed-reason":
        edit.landedReason = (value as string | undefined) ?? null;
        break;
    }
    edits.set(row.subject, edit);
  }

  const evidenceRows = loadActiveEditEvidenceRows(opts?.sessionId);
  for (const row of evidenceRows) {
    const edit = edits.get(row.subject);
    if (!edit) continue;
    if (edit.payloadEvidenceRefId == null) {
      edit.payloadEvidenceRefId = row.evidence_ref_id;
    }
    if (!edit.payloadEvidenceKey) {
      edit.payloadEvidenceKey = row.evidence_ref_key;
    }
    if (row.hook_event_id != null && edit.hookEventId == null) {
      edit.hookEventId = row.hook_event_id;
    }
    edits.set(row.subject, edit);
  }

  return edits;
}
