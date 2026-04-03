const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;

export async function postSync(
  url: string,
  body: { table: string; rows: unknown[] },
  headers: Record<string, string>,
): Promise<void> {
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
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) return;

      const status = response.status;

      // Don't retry client errors (except 429 rate limit)
      if (status >= 400 && status < 500 && status !== 429) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${status}: ${text}`);
      }

      lastError = new Error(`HTTP ${status}`);
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
