const MIN_REASONABLE_EPOCH_NS = 1_700_000_000_000_000_000;
const MAX_FUTURE_SKEW_MS = 60_000;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeLogBody(
  rawBody: string | number | boolean | null,
  eventName: unknown,
): string | undefined {
  if (hasText(rawBody)) return rawBody;
  if (rawBody != null && typeof rawBody !== "string") {
    return JSON.stringify(rawBody);
  }
  return hasText(eventName) ? eventName : undefined;
}

export function normalizeLogSessionId(
  ...candidates: unknown[]
): string | undefined {
  return candidates.find(hasText);
}

export function isQueryableLogRecord(
  body: string | undefined,
  sessionId: string | undefined,
): boolean {
  return hasText(body) && hasText(sessionId);
}

export function normalizeLogTimestampNs(
  primary: number,
  eventTimestamp: unknown,
  observed: number | undefined,
  nowMs = Date.now(),
): number {
  if (isReasonableTimestampNs(primary, nowMs)) return primary;

  if (hasText(eventTimestamp)) {
    const eventMs = Date.parse(eventTimestamp);
    if (Number.isFinite(eventMs)) {
      const eventNs = eventMs * 1_000_000;
      if (isReasonableTimestampNs(eventNs, nowMs)) return eventNs;
    }
  }

  if (
    observed !== undefined &&
    Number.isFinite(observed) &&
    isReasonableTimestampNs(observed, nowMs)
  ) {
    return observed;
  }

  return nowMs * 1_000_000;
}

function isReasonableTimestampNs(timestampNs: number, nowMs: number): boolean {
  return (
    Number.isFinite(timestampNs) &&
    timestampNs >= MIN_REASONABLE_EPOCH_NS &&
    timestampNs <= (nowMs + MAX_FUTURE_SKEW_MS) * 1_000_000
  );
}
