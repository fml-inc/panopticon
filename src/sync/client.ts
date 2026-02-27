import { execSync } from "node:child_process";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

export function resolveGitHubToken(): string | null {
  // Prefer explicit env var
  const envToken = process.env.PANOPTICON_GITHUB_TOKEN;
  if (envToken) return envToken;

  // Fall back to gh CLI
  try {
    return execSync("gh auth token", { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export async function postBatch(
  url: string,
  body: unknown,
  token: string,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (response.ok) return;

      const status = response.status;

      // Don't retry client errors (except 429)
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
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError ?? new Error("postBatch failed");
}

/**
 * Chunk an array into batches of a given size.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
