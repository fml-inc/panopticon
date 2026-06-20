import { execSync } from "node:child_process";
import { readTokens } from "../auth/token-store.js";
import { getActiveEnv, isValidEnvName } from "../config.js";

const TOKEN_TTL_MS = 5 * 60 * 1000;

let cachedGitHubToken: { value: string; expiresAt: number } | null = null;

export function resolveGitHubToken(): string | null {
  if (cachedGitHubToken && Date.now() < cachedGitHubToken.expiresAt) {
    return cachedGitHubToken.value;
  }

  const envToken = process.env.PANOPTICON_GITHUB_TOKEN;
  if (envToken) {
    cachedGitHubToken = {
      value: envToken,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    return envToken;
  }

  try {
    const token = execSync("gh auth token", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (token) {
      cachedGitHubToken = {
        value: token,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      };
    }
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Pick the best `tokenCommand` to write onto a sync target, given what's
 * currently available on this machine:
 *
 *   1. `gh auth token` — preferred on dev laptops. Keeps telemetry
 *      attributed to the GitHub identity, which is how work is rolled up
 *      for individual contributors.
 *   2. `fml sync-token --env <active>` — fallback for sandboxes / CI /
 *      containers that don't have `gh` but have (or will have) an
 *      `fml login` session. Pinned to the active env so panopticon reads
 *      the right auth file even when the user later switches envs. The
 *      FML session token carries `actAsExternalId` so attribution still
 *      lands on a specific user — via FML identity instead of GH.
 *   3. `undefined` — nothing usable yet. Install writes a URL-only target
 *      and `fml login` will back-patch it after the user signs in.
 */
export function resolveSyncTokenCommand(): string | undefined {
  if (resolveGitHubToken()) return "gh auth token";
  if (readTokens()) {
    const { name } = getActiveEnv();
    if (isValidEnvName(name)) return `fml sync-token --env ${name}`;
  }
  return undefined;
}
