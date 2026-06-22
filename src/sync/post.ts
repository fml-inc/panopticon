const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Node networking error codes that mean the target is unreachable. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/**
 * Whether a sync failure reflects the user's environment/config rather than a
 * panopticon bug: an offline or misconfigured sync target (network down, request
 * timeout) or an auth/config rejection (HTTP 4xx other than 429 rate-limiting).
 *
 * These are already surfaced via the sync log and driven into attempt backoff,
 * so reporting them to Sentry is pure noise — they accounted for the bulk of the
 * project's captured events (unreachable local targets, expired sync tokens).
 * Genuinely unexpected failures (HTTP 5xx, response parse errors, internal
 * exceptions) are NOT expected and should still be captured.
 */
export function isExpectedSyncError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Auth / client-config rejections — 4xx, except 429 which postSync retries.
  if (err.message.startsWith("HTTP 4") && !err.message.startsWith("HTTP 429")) {
    return true;
  }

  // Request timeout: AbortController fired (target too slow / unreachable).
  if (err.name === "AbortError") return true;

  // Undici surfaces transport failures as `TypeError: fetch failed` with the
  // underlying networking error attached as `cause`.
  if (err.message.includes("fetch failed")) return true;

  const cause = err.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
  }

  return false;
}

export async function postSync(
  url: string,
  body: { table: string; rows: unknown[] },
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  return postWithRetries(url, {
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export interface SessionFileUploadMetadata {
  sessionId: string;
  source: string;
  fileName: string;
  contentType: string;
  contentEncoding: string;
  sizeBytes: number;
  contentHash: string;
}

export async function postSessionFile(
  url: string,
  metadata: SessionFileUploadMetadata,
  content: Buffer,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  );
  form.append(
    "file",
    new Blob([new Uint8Array(content)], { type: metadata.contentType }),
    metadata.fileName,
  );

  return postWithRetries(url, {
    headers,
    body: form,
  });
}

async function postWithRetries(
  url: string,
  init: {
    headers: Record<string, string>;
    body: BodyInit;
  },
): Promise<Record<string, unknown>> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );
      const response = await fetch(url, {
        method: "POST",
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text().catch(() => "");
        try {
          return text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      }

      const status = response.status;

      // Don't retry client errors (except 429 rate limit)
      if (status >= 400 && status < 500 && status !== 429) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${status}: ${text}`);
      }

      // 5xx (and 429): retryable. Capture the response body in the error so the
      // server's reason (e.g. `{error: "..."}`) survives to Sentry instead of a
      // contentless `HTTP 500`. startsWith("HTTP 4") still gates isExpectedSyncError.
      const text = await response.text().catch(() => "");
      lastError = new Error(
        text ? `HTTP ${status}: ${text}` : `HTTP ${status}`,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("HTTP 4") &&
        !err.message.startsWith("HTTP 429")
      ) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError ?? new Error("postSync failed");
}
