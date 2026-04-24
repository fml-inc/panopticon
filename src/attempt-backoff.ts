import { getDb } from "./db/schema.js";

const ATTEMPT_BACKOFF_SCHEDULE_MS = [
  60_000,
  2 * 60_000,
  4 * 60_000,
  8 * 60_000,
  16 * 60_000,
  32 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;
const ATTEMPT_BACKOFF_JITTER_RATIO = 0.1;

export interface AttemptBackoffRow {
  scope_kind: string;
  scope_key: string;
  failure_count: number;
  last_attempted_at_ms: number | null;
  next_attempt_at_ms: number | null;
  last_error: string | null;
  updated_at_ms: number;
}

export function computeAttemptBackoffDelayMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  return ATTEMPT_BACKOFF_SCHEDULE_MS[
    Math.min(failureCount - 1, ATTEMPT_BACKOFF_SCHEDULE_MS.length - 1)
  ];
}

export function applyAttemptBackoffJitter(
  delayMs: number,
  random = Math.random,
): number {
  if (delayMs <= 0) return 0;
  const sample = Math.min(1, Math.max(0, random()));
  const factor =
    1 -
    ATTEMPT_BACKOFF_JITTER_RATIO +
    sample * (2 * ATTEMPT_BACKOFF_JITTER_RATIO);
  return Math.max(1, Math.round(delayMs * factor));
}

export function getAttemptBackoff(
  scopeKind: string,
  scopeKey: string,
): AttemptBackoffRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT scope_kind, scope_key, failure_count, last_attempted_at_ms,
                next_attempt_at_ms, last_error, updated_at_ms
         FROM attempt_backoffs
         WHERE scope_kind = ? AND scope_key = ?`,
      )
      .get(scopeKind, scopeKey) as AttemptBackoffRow | undefined) ?? null
  );
}

export function isAttemptBackoffActive(
  scopeKind: string,
  scopeKey: string,
  nowMs = Date.now(),
): boolean {
  const row = getAttemptBackoff(scopeKind, scopeKey);
  return (
    !!row && row.next_attempt_at_ms !== null && row.next_attempt_at_ms > nowMs
  );
}

export function recordAttemptBackoffFailure(
  scopeKind: string,
  scopeKey: string,
  error: string,
  nowMs = Date.now(),
  random = Math.random,
): AttemptBackoffRow {
  const existing = getAttemptBackoff(scopeKind, scopeKey);
  const failureCount = (existing?.failure_count ?? 0) + 1;
  const nextAttemptAtMs =
    nowMs +
    applyAttemptBackoffJitter(
      computeAttemptBackoffDelayMs(failureCount),
      random,
    );
  const db = getDb();
  db.prepare(
    `INSERT INTO attempt_backoffs (
       scope_kind, scope_key, failure_count, last_attempted_at_ms,
       next_attempt_at_ms, last_error, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_kind, scope_key) DO UPDATE SET
       failure_count = excluded.failure_count,
       last_attempted_at_ms = excluded.last_attempted_at_ms,
       next_attempt_at_ms = excluded.next_attempt_at_ms,
       last_error = excluded.last_error,
       updated_at_ms = excluded.updated_at_ms`,
  ).run(
    scopeKind,
    scopeKey,
    failureCount,
    nowMs,
    nextAttemptAtMs,
    error,
    nowMs,
  );
  return {
    scope_kind: scopeKind,
    scope_key: scopeKey,
    failure_count: failureCount,
    last_attempted_at_ms: nowMs,
    next_attempt_at_ms: nextAttemptAtMs,
    last_error: error,
    updated_at_ms: nowMs,
  };
}

export function clearAttemptBackoff(scopeKind: string, scopeKey: string): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM attempt_backoffs
     WHERE scope_kind = ? AND scope_key = ?`,
  ).run(scopeKind, scopeKey);
}
