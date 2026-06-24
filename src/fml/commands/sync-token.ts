import { once } from "node:events";
import { getValidToken } from "../auth/token-store.js";

/**
 * Print the current FML access token to stdout.
 *
 * Wired into panopticon sync targets as `tokenCommand: "fml sync-token"`.
 * Resolves and refreshes the stored FML session token, the same credential
 * `fml login` produces. Used on sandboxes / CI / containers where there's
 * no `gh auth token` to attribute sync telemetry to a GitHub identity.
 *
 * Output: token on stdout, nothing else. Non-zero exit on any failure so
 * panopticon's token helper treats it as a missed refresh rather than
 * caching an empty string as the bearer.
 */
export async function handleSyncToken(opts?: { env?: string }): Promise<void> {
  const token = await getValidToken({ env: opts?.env });
  if (!token) {
    const suffix = opts?.env ? ` for env "${opts.env}"` : "";
    console.error(
      `fml: not logged in${suffix}. Run \`fml login\` to enable sync.`,
    );
    process.exit(1);
  }
  // Wait for drain before exiting — small writes on a pipe are usually
  // synchronous up to PIPE_BUF, but on slow/full pipes (or non-Linux
  // platforms) `process.exit` can cut off the write mid-flight and
  // hand panopticon a truncated token.
  if (!process.stdout.write(token)) {
    await once(process.stdout, "drain");
  }
  process.exit(0);
}
