import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWriteTokens = vi.fn();

vi.mock("../../config.js", () => ({
  getSiteUrl: () => "https://test.convex.site",
  WORKOS_API_URL: "https://api.workos.com",
}));

vi.mock("../../auth/token-store.js", () => ({
  writeTokens: (...args: unknown[]) => mockWriteTokens(...args),
}));

import { deviceLogin } from "../../auth/device-flow.js";

describe("deviceLogin", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("uses WorkOS device auth and stores user credentials", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, workosClientId: "client_123" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "device_123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example/device",
          verification_uri_complete:
            "https://auth.example/device?user_code=ABCD-EFGH",
          expires_in: 300,
          interval: 0,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "authorization_pending" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "jwt_access",
          refresh_token: "refresh_token",
          expires_in: 600,
          user: {
            id: "user_123",
            email: "a@example.com",
            first_name: "Ada",
            last_name: "Lovelace",
          },
        }),
      } as Response);

    await expect(deviceLogin()).resolves.toEqual({
      email: "a@example.com",
      name: "Ada Lovelace",
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://test.convex.site/api/auth/config",
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://api.workos.com/user_management/authorize/device",
      expect.objectContaining({
        method: "POST",
        body: new URLSearchParams({ client_id: "client_123" }),
      }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://api.workos.com/user_management/authenticate",
      expect.objectContaining({
        method: "POST",
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device_123",
          client_id: "client_123",
        }),
      }),
    );
    expect(mockWriteTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "jwt_access",
        refreshToken: "refresh_token",
        user: { id: "user_123", email: "a@example.com", name: "Ada Lovelace" },
        workosClientId: "client_123",
      }),
    );
    expect(mockWriteTokens.mock.calls[0][0]).not.toHaveProperty("tokenType");
  });

  it("throws a clear error when authorization is denied", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, workosClientId: "client_123" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "device_123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example/device",
          expires_in: 300,
          interval: 0,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "access_denied" }),
      } as Response);

    await expect(deviceLogin()).rejects.toThrow(
      "Device authorization was denied",
    );
    expect(mockWriteTokens).not.toHaveBeenCalled();
  });

  it("rejects incomplete successful token responses", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, workosClientId: "client_123" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "device_123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example/device",
          expires_in: 300,
          interval: 0,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "jwt_access" }),
      } as Response);

    await expect(deviceLogin()).rejects.toThrow("incomplete token response");
    expect(mockWriteTokens).not.toHaveBeenCalled();
  });
});
