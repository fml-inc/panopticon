import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config to use temp directory
let tmpDir: string;

vi.mock("../../config.js", () => ({
  authStorePath: () => path.join(tmpDir, "auth.json"),
  authStorePathFor: (envName: string) =>
    path.join(tmpDir, `auth.${envName}.json`),
  resolveEnvConvexUrl: () => null,
  CONVEX_URL: "https://test.convex.cloud",
  WORKOS_API_URL: "https://api.workos.com",
}));

vi.mock("../../sentry.js", () => ({
  Sentry: { captureException: vi.fn() },
}));

import {
  getSelectedOrg,
  getValidToken,
  readTokens,
  SERVICE_TOKEN_LOGIN_USER_ID,
  setSelectedOrg,
  storeServiceRefreshToken,
  writeTokens,
} from "../../auth/token-store.js";

function makeAuth(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "test_access_token",
    refreshToken: "test_refresh_token",
    expiresAt: Date.now() + 3_600_000,
    user: { id: "u1", email: "test@example.com", name: "Test User" },
    ...overrides,
  };
}

describe("token-store", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fml-test-"));
    vi.unstubAllEnvs();
    fetchSpy = null;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readTokens / writeTokens", () => {
    it("returns null when no auth file exists", () => {
      expect(readTokens()).toBeNull();
    });

    it("round-trips tokens through write and read", () => {
      const auth = makeAuth();
      writeTokens(auth);
      const read = readTokens();
      expect(read).toEqual(auth);
    });

    it("reads and writes selected org in the env-specific auth store", () => {
      writeTokens(makeAuth({ orgSlug: "default-org" }));
      writeTokens(makeAuth({ orgSlug: "dev-org" }), "dev");

      expect(getSelectedOrg()).toBe("default-org");
      expect(getSelectedOrg("dev")).toBe("dev-org");

      setSelectedOrg("new-dev-org", "dev");

      expect(getSelectedOrg()).toBe("default-org");
      expect(getSelectedOrg("dev")).toBe("new-dev-org");
    });
  });

  describe("getValidToken", () => {
    it("returns static fml_st_* FML_TOKEN env var when set", async () => {
      vi.stubEnv("FML_TOKEN", "fml_st_env");
      // Even with stored tokens, env var takes precedence
      writeTokens(makeAuth());
      const token = await getValidToken();
      expect(token).toBe("fml_st_env");
    });

    it("rejects unsupported FML_TOKEN formats without using stored tokens", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv("FML_TOKEN", "pat_from_env");
      writeTokens(makeAuth({ accessToken: "stored_tok" }));

      const token = await getValidToken();

      expect(token).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        "[fml] Auth: unsupported FML_TOKEN format. Expected fml_srt_* or fml_st_*.",
      );
      errorSpy.mockRestore();
    });

    it("returns null when no auth and no env var", async () => {
      const token = await getValidToken();
      expect(token).toBeNull();
    });

    it("returns stored token when valid and no env var", async () => {
      writeTokens(makeAuth({ accessToken: "stored_tok" }));
      const token = await getValidToken();
      expect(token).toBe("stored_tok");
    });

    it("skips empty FML_TOKEN", async () => {
      vi.stubEnv("FML_TOKEN", "");
      writeTokens(makeAuth({ accessToken: "stored_tok" }));
      const token = await getValidToken();
      expect(token).toBe("stored_tok");
    });

    it("refreshes fml_srt_* FML_TOKEN env var", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          accessToken: "fml_st_refreshed",
          expiresAt: Date.now() + 300_000,
        }),
      } as Response);
      vi.stubEnv("FML_TOKEN", "fml_srt_refresh");

      const token = await getValidToken();

      expect(token).toBe("fml_st_refreshed");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://test.convex.site/api/tokens/refresh");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer fml_srt_refresh",
      );
      fetchSpy.mockRestore();
    });

    it("reads the env-specific store when env is provided", async () => {
      writeTokens(makeAuth({ accessToken: "default_tok" }));
      writeTokens(makeAuth({ accessToken: "dev_tok" }), "dev");
      writeTokens(makeAuth({ accessToken: "prod_tok" }), "prod");

      expect(await getValidToken({ env: "dev" })).toBe("dev_tok");
      expect(await getValidToken({ env: "prod" })).toBe("prod_tok");
      expect(await getValidToken()).toBe("default_tok");
    });
  });

  describe("storeServiceRefreshToken", () => {
    it("refreshes and stores a pasted service refresh token", async () => {
      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          accessToken: "fml_st_access",
          expiresAt: Date.now() + 3_600_000,
        }),
      } as Response);

      const stored = await storeServiceRefreshToken(" fml_srt_refresh ", {
        env: "service",
      });

      expect(stored).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.convex.site/api/tokens/refresh",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer fml_srt_refresh",
          }),
        }),
      );
      expect(readTokens("service")).toMatchObject({
        accessToken: "fml_st_access",
        refreshToken: "fml_srt_refresh",
        user: {
          id: SERVICE_TOKEN_LOGIN_USER_ID,
          email: "service-token",
          name: "FML service token",
        },
        tokenType: "service",
      });
      await expect(getValidToken({ env: "service" })).resolves.toBe(
        "fml_st_access",
      );
    });

    it("rejects non-refresh service tokens", async () => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const stored = await storeServiceRefreshToken("fml_st_access");

      expect(stored).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("fml_srt_"),
      );
      errorSpy.mockRestore();
    });
  });
});
