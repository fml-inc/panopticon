import crypto from "node:crypto";
import http from "node:http";
import { getSiteUrl, WORKOS_API_URL, WORKOS_AUTH_URL } from "../config.js";
import { writeTokens } from "./token-store.js";

/**
 * Fetch the OAuth client ID from the active backend deployment.
 * This allows each environment to use its own OAuth configuration.
 */
async function fetchWorkosClientId(): Promise<string> {
  const response = await fetch(`${getSiteUrl()}/api/auth/config`);
  const data = (await response.json()) as {
    ok?: boolean;
    workosClientId?: string;
    error?: string;
  };

  if (!response.ok || data.ok === false || !data.workosClientId) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }

  return data.workosClientId;
}

/**
 * Detect if a browser can be opened on this machine.
 * Returns false for headless environments (containers, SSH, no display).
 */
export async function canOpenBrowser(): Promise<boolean> {
  // Explicit overrides
  if (process.env.FML_DEVICE_FLOW === "1") return false;
  if (process.env.FML_NO_BROWSER === "1") return false;

  // Linux without a display server
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    return false;
  }

  // Remote/container environments
  if (process.env.SSH_CONNECTION) return false;
  if (process.env.CODESPACES) return false;
  if (process.env.REMOTE_CONTAINERS) return false;

  // Container detection
  try {
    const fs = await import("node:fs");
    if (fs.existsSync("/.dockerenv")) return false;
  } catch {
    // ignore
  }

  return true;
}

/**
 * Run the browser PKCE OAuth flow:
 * 1. Generate code_verifier + code_challenge
 * 2. Start local HTTP server for callback
 * 3. Open browser to the OAuth authorization URL
 * 4. Receive callback with authorization code
 * 5. Exchange code for tokens
 * 6. Store tokens
 */
export async function login(): Promise<{
  email: string;
  name: string;
}> {
  // Fetch the OAuth client ID from the active backend deployment
  const clientId = await fetchWorkosClientId();

  // Generate PKCE code verifier and challenge
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  // Generate state for CSRF protection (defense-in-depth alongside PKCE)
  const state = crypto.randomBytes(16).toString("hex");

  // Find a free port and start callback server (pass state for CSRF verification)
  const { port, waitForCode, close } = await startCallbackServer(state);

  const redirectUri = `http://localhost:${port}/callback`;
  const authUrl = new URL(`${WORKOS_AUTH_URL}/user_management/authorize`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("provider", "authkit");
  authUrl.searchParams.set("state", state);

  // Open browser
  const open = (await import("open")).default;
  await open(authUrl.toString());

  console.log("\nOpening browser for login...");
  console.log(`If it doesn't open, visit: ${authUrl.toString()}\n`);

  // Wait for the callback
  const code = await waitForCode();
  close();

  // Exchange code for tokens
  const tokenResponse = await fetch(
    `${WORKOS_API_URL}/user_management/authenticate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    },
  );

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const data = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user: {
      id: string;
      email: string;
      first_name?: string;
      last_name?: string;
    };
  };

  const userName = [data.user.first_name, data.user.last_name]
    .filter(Boolean)
    .join(" ");

  writeTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 300) * 1000,
    user: {
      id: data.user.id,
      email: data.user.email,
      name: userName,
    },
    workosClientId: clientId,
  });

  return { email: data.user.email, name: userName };
}

function startCallbackServer(expectedState: string): Promise<{
  port: number;
  waitForCode: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;

    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const returnedState = url.searchParams.get("state");

        // Verify state parameter to prevent CSRF
        if (returnedState !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Login failed</h1><p>Invalid state parameter. You can close this tab.</p></body></html>",
          );
          rejectCode(new Error("OAuth state mismatch — possible CSRF attack"));
          return;
        }

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Login failed</h1><p>You can close this tab.</p></body></html>",
          );
          rejectCode(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Login successful!</h1><p>You can close this tab and return to the terminal.</p></body></html>",
          );
          resolveCode(code);
          return;
        }

        res.writeHead(400);
        res.end("Missing code parameter");
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    // Listen on a random available port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start callback server"));
        return;
      }

      resolve({
        port: addr.port,
        waitForCode: () => codePromise,
        close: () => server.close(),
      });
    });

    server.on("error", reject);

    // Timeout after 5 minutes
    setTimeout(
      () => {
        rejectCode(new Error("Login timed out (5 minutes)"));
        server.close();
      },
      5 * 60 * 1000,
    );
  });
}
