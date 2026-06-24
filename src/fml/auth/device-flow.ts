/**
 * CLI OAuth Device Authorization Flow
 *
 * This uses the OAuth 2.0 device authorization grant so device login produces
 * the same user credential family as browser OAuth login.
 */

import { getSiteUrl, WORKOS_API_URL } from "../config.js";
import { writeTokens } from "./token-store.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface DeviceTokenSuccessResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  user: {
    id: string;
    email: string;
    first_name?: string;
    last_name?: string;
  };
}

interface DeviceTokenErrorResponse {
  error?: string;
  error_description?: string;
}

function userName(user: DeviceTokenSuccessResponse["user"]): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

async function requestDeviceAuthorization(
  clientId: string,
): Promise<DeviceAuthorizationResponse> {
  const response = await fetch(
    `${WORKOS_API_URL}/user_management/authorize/device`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId }),
    },
  );
  const data =
    (await response.json()) as Partial<DeviceAuthorizationResponse> & {
      error?: string;
      error_description?: string;
    };

  if (
    !response.ok ||
    !data.device_code ||
    !data.user_code ||
    !data.verification_uri
  ) {
    throw new Error(
      data.error_description ?? data.error ?? `HTTP ${response.status}`,
    );
  }

  return data as DeviceAuthorizationResponse;
}

async function pollForTokens(
  clientId: string,
  authorization: DeviceAuthorizationResponse,
): Promise<DeviceTokenSuccessResponse> {
  let intervalMs = (authorization.interval ?? 5) * 1000;
  const deadline = Date.now() + (authorization.expires_in ?? 300) * 1000;

  while (Date.now() < deadline) {
    const response = await fetch(
      `${WORKOS_API_URL}/user_management/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: authorization.device_code,
          client_id: clientId,
        }),
      },
    );
    const data = (await response.json()) as
      | DeviceTokenSuccessResponse
      | DeviceTokenErrorResponse;

    if (response.ok) {
      const success = data as DeviceTokenSuccessResponse;
      if (!success.access_token || !success.refresh_token || !success.user) {
        throw new Error(
          "Device authorization returned an incomplete token response.",
        );
      }
      return success;
    }

    const error = (data as DeviceTokenErrorResponse).error;
    if (error === "authorization_pending") {
      await sleep(intervalMs);
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 5_000;
      await sleep(intervalMs);
      continue;
    }
    if (error === "access_denied") {
      throw new Error("Device authorization was denied.");
    }
    if (error === "expired_token") {
      throw new Error("Device authorization expired. Run `fml login` again.");
    }

    throw new Error(
      (data as DeviceTokenErrorResponse).error_description ??
        error ??
        `HTTP ${response.status}`,
    );
  }

  throw new Error("Device authorization timed out. Run `fml login` again.");
}

/**
 * Run CLI OAuth device authorization.
 */
export async function deviceLogin(): Promise<{
  email: string;
  name: string;
}> {
  const clientId = await fetchWorkosClientId();
  const authorization = await requestDeviceAuthorization(clientId);

  console.log("");
  console.log("  Sign in with this code:");
  console.log("");
  console.log(`  ${authorization.user_code}`);
  console.log("");
  console.log("  Open this URL in your browser:");
  console.log("");
  console.log(
    `  ${authorization.verification_uri_complete ?? authorization.verification_uri}`,
  );
  console.log("");
  console.log("  Waiting for authorization...");

  const data = await pollForTokens(clientId, authorization);
  const name = userName(data.user);

  writeTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 300) * 1000,
    user: {
      id: data.user.id,
      email: data.user.email,
      name,
    },
    workosClientId: clientId,
  });

  return { email: data.user.email, name };
}
