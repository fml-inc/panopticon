import type { ReadStream } from "node:tty";
import { addTarget, loadSyncConfig, saveSyncConfig } from "../../sync/index.js";
import { deviceLogin } from "../auth/device-flow.js";
import { canOpenBrowser, login } from "../auth/oauth.js";
import {
  getSelectedOrg,
  getValidToken,
  SERVICE_TOKEN_LOGIN_USER_ID,
  setSelectedOrg,
  storeServiceRefreshToken,
} from "../auth/token-store.js";
import {
  DEFAULT_SYNC_URL,
  getActiveEnv,
  getSiteUrl,
  isValidEnvName,
} from "../config.js";
import { createFmlClient } from "../fml-client.js";
import { Sentry } from "../sentry.js";
import { resolveGitHubToken } from "../sync/client.js";

/**
 * After login, link the user's GitHub identity to their FML account
 * so that sync data (authenticated via GitHub token) can be attributed.
 */
async function linkGitHubIdentity(): Promise<void> {
  const token = resolveGitHubToken();
  if (!token) {
    console.warn("[fml] No GitHub token available — skipping identity link");
    return;
  }

  try {
    const fmlToken = await getValidToken();
    if (!fmlToken) {
      console.warn("[fml] No FML token available — skipping identity link");
      return;
    }

    // Service tokens (device flow) can't call JWT-authenticated Convex mutations.
    // Identity is already attributed server-side via actAsExternalId on the token.
    if (fmlToken.startsWith("fml_st_")) {
      return;
    }

    const linkResponse = await fetch(
      `${getSiteUrl()}/api/auth/link-github-identity`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fmlToken}`,
        },
        body: JSON.stringify({ githubAccessToken: token }),
      },
    );
    const linkResult = (await linkResponse.json()) as {
      ok?: boolean;
      error?: string;
    };
    if (!linkResponse.ok || linkResult.ok === false) {
      throw new Error(linkResult.error ?? `HTTP ${linkResponse.status}`);
    }

    console.log("Linked GitHub account");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[fml] Failed to link GitHub identity: ${msg}`);
  }
}

// Config snapshots are now synced automatically via panopticon sync —
// no manual upload needed after login.

function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        input += chunk;
      });
      process.stdin.once("end", () => resolve(input.trim()));
      process.stdin.once("error", reject);
    });
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin as ReadStream;
    const wasRaw = stdin.isRaw === true;
    let value = "";
    let settled = false;

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write("\n");
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          finish(() => reject(new Error("Canceled")));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(() => resolve(value.trim()));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * After a successful login, pin the active env's sync target to
 * `fml sync-token --env <activeEnv>` so panopticon always reads the auth
 * file for that env (even when the user later switches active envs).
 *
 * - Target missing entirely → add one pointing at prod with the pinned cmd.
 * - Target is URL-only or uses the legacy `fml sync-token` (no --env) →
 *   upgrade to the pinned form.
 * - Target has an unrelated tokenCommand (gh auth token, custom) or a
 *   static token → leave it alone unless this is an explicit service-token
 *   login; in that case the user is choosing the FML token helper.
 */
// Exported for unit testing; called from within handleLogin otherwise.
export function upgradeSyncTargetAfterLogin(opts?: {
  forceTokenCommand?: boolean;
}): void {
  try {
    const { name: envName } = getActiveEnv();
    // envName is interpolated into tokenCommand, which panopticon shells out.
    // Guard against metacharacters in a corrupted env.json.
    if (!isValidEnvName(envName)) {
      console.warn(
        `[fml] Skipping sync-target upgrade: env name "${envName}" contains unsafe characters.`,
      );
      return;
    }
    const pinnedCmd = `fml sync-token --env ${envName}`;
    const config = loadSyncConfig();
    const existing = config.targets.find((t) => t.name === envName);
    if (!existing) {
      addTarget({
        name: envName,
        url: DEFAULT_SYNC_URL,
        tokenCommand: pinnedCmd,
      });
      console.log(`Sync target "${envName}" configured with ${pinnedCmd}.`);
      console.log("Restart panopticon to apply: fml stop && fml start");
      return;
    }
    if (existing.token && !opts?.forceTokenCommand) return;
    if (existing.tokenCommand === pinnedCmd) return;
    if (
      !opts?.forceTokenCommand &&
      existing.tokenCommand &&
      existing.tokenCommand !== "fml sync-token"
    ) {
      // Preserve explicit choices (e.g. `gh auth token`, custom commands).
      return;
    }
    delete existing.token;
    existing.tokenCommand = pinnedCmd;
    saveSyncConfig(config);
    console.log(`Sync target "${envName}" now using ${pinnedCmd}.`);
    console.log("Restart panopticon to apply: fml stop && fml start");
  } catch (err: unknown) {
    // Non-fatal — login itself succeeded, worst case sync stays URL-only
    // and the user can run `fml sync setup` manually.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[fml] Could not update sync target: ${msg}`);
  }
}

/**
 * After login, select and persist the user's org.
 * Single-org users get auto-selected; multi-org users get the first org
 * (can be changed later via `fml org`).
 */
async function selectOrg(envName?: string): Promise<void> {
  try {
    const token = await getValidToken({ env: envName });
    if (!token) return;

    const api = createFmlClient(token);
    const orgs = await api.queryOrgs();
    if (orgs.length === 0) return;

    // Preserve the user's existing selection if it's still a valid org —
    // only fall back to the first org when nothing valid is selected. Logging
    // in (or re-logging-in) should not silently reset a prior `fml org <slug>`.
    const current = getSelectedOrg(envName);
    const org =
      (current && orgs.find((o) => (o.slug ?? o.name) === current)) || orgs[0];
    const slug = org.slug ?? org.name;
    setSelectedOrg(slug, envName);
    console.log(`Selected org: ${org.name} (${slug})`);
  } catch {
    // Non-fatal — org selection can happen later via `fml org`
  }
}

export async function runServiceTokenLogin(
  refreshToken?: string,
): Promise<void> {
  const { name: envName } = getActiveEnv();
  if (!isValidEnvName(envName)) {
    throw new Error(
      `Cannot store service-token login for unsafe env name "${envName}".`,
    );
  }

  console.log(`Signing in to FML with a service token (${envName})...`);
  const token =
    refreshToken ??
    (await promptHidden("Paste FML service refresh token (fml_srt_*): "));
  const ok = await storeServiceRefreshToken(token, { env: envName });
  if (!ok) {
    throw new Error("Service token login failed.");
  }

  await selectOrg(envName);
  upgradeSyncTargetAfterLogin({ forceTokenCommand: true });

  console.log("Logged in with FML service token.");
  console.log("Queries and sync will use the stored service token.");
  console.log("You're all set! Restart Claude Code to use FML tools.");
}

export async function handleServiceTokenLogin(
  refreshToken?: string,
): Promise<void> {
  try {
    await runServiceTokenLogin(refreshToken);
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "Canceled") {
      console.error("Login canceled.");
      process.exit(1);
    }
    Sentry.captureException(err);
    console.error(`Login failed: ${msg}`);
    process.exit(1);
  }
}

export async function handleLogin(opts?: {
  device?: boolean;
  serviceToken?: boolean;
}): Promise<void> {
  if (opts?.serviceToken) {
    await handleServiceTokenLogin();
    return;
  }

  const { name: envName } = getActiveEnv();

  // Skip OAuth if already authenticated — still run post-login tasks
  const existingToken = await getValidToken();
  if (existingToken) {
    const { readTokens } = await import("../auth/token-store.js");
    const stored = readTokens();
    if (stored?.tokenType === "service") {
      const label =
        stored.user.id === SERVICE_TOKEN_LOGIN_USER_ID
          ? "a service token"
          : `${stored.user.name} (${stored.user.email})`;
      console.log(`Already logged in with ${label} on ${envName}.`);
    } else {
      console.log(
        `Already logged in as ${stored?.user.name} (${stored?.user.email}) on ${envName}.`,
      );
    }

    await linkGitHubIdentity();
    await selectOrg(envName);
    upgradeSyncTargetAfterLogin();

    console.log("You're all set! Restart Claude Code to use FML tools.");
    process.exit(0);
  }

  console.log(`Signing in to FML (${envName})...`);
  try {
    const useDeviceFlow = opts?.device || !(await canOpenBrowser());
    let result: { email: string; name: string };

    if (useDeviceFlow) {
      result = await deviceLogin();
    } else {
      result = await login();
    }

    console.log(`\nLogged in as ${result.name} (${result.email})`);

    await linkGitHubIdentity();
    await selectOrg(envName);
    upgradeSyncTargetAfterLogin();

    console.log("You're all set! Restart Claude Code to use FML tools.");
    process.exit(0);
  } catch (err: unknown) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Login failed: ${msg}`);
    process.exit(1);
  }
}
