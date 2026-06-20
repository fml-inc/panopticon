import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  CONVEX_URL: "https://test.convex.cloud",
  authStorePath: () => "/tmp/auth.json",
  authStorePathFor: () => "/tmp/auth.json",
  resolveEnvConvexUrl: () => null,
  WORKOS_API_URL: "https://api.workos.com",
}));

vi.mock("../sentry.js", () => ({
  Sentry: { captureException: vi.fn() },
}));

const mockReadTokens = vi.fn();
const mockGetSelectedOrg = vi.fn<() => string | undefined>(() => undefined);
vi.mock("../auth/token-store.js", () => ({
  SERVICE_TOKEN_LOGIN_USER_ID: "service-token",
  readTokens: () => mockReadTokens(),
  getValidToken: vi.fn(),
  getSelectedOrg: () => mockGetSelectedOrg(),
}));

const mockConvexQuery = vi.fn();
const mockConvexAction = vi.fn();
const mockResolveRepoFromCwd = vi.fn<() => { repo: string } | null>(() => null);

vi.mock("../../repo.js", () => ({
  resolveRepoFromCwd: () => mockResolveRepoFromCwd(),
}));

import { createFmlClient, type PublicToolDescriptor } from "../fml-client.js";

const DESCRIPTORS: PublicToolDescriptor[] = [
  {
    name: "integration-github",
    description: "GitHub integration",
    inputSchema: { type: "object" },
    category: "integrations",
  },
];

const SERVICE_TOKEN = "fml_st_testtoken";
const JWT_TOKEN = "eyJhbGciOiJSUzI1NiJ9.test.signature";

// The site URL is derived from CONVEX_URL by replacing .convex.cloud -> .convex.site
const SITE_URL = "https://test.convex.site";

describe("createFmlClient.listTools — service token path", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls GET /api/tools/list with pluginVersion query param", async () => {
    fetchSpy.mockResolvedValue({
      text: async () => JSON.stringify({ ok: true, descriptors: DESCRIPTORS }),
    } as Response);

    const api = createFmlClient(SERVICE_TOKEN);
    const result = await api.listTools("1.2.3");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SITE_URL}/api/tools/list?pluginVersion=1.2.3`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SERVICE_TOKEN}`,
    );
    expect(result).toEqual(DESCRIPTORS);
  });

  it("omits pluginVersion param when not provided", async () => {
    fetchSpy.mockResolvedValue({
      text: async () => JSON.stringify({ ok: true, descriptors: DESCRIPTORS }),
    } as Response);

    const api = createFmlClient(SERVICE_TOKEN);
    await api.listTools();

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SITE_URL}/api/tools/list`);
  });

  it("throws when response has ok: false", async () => {
    fetchSpy.mockResolvedValue({
      text: async () =>
        JSON.stringify({ ok: false, error: "fml login required" }),
    } as Response);

    const api = createFmlClient(SERVICE_TOKEN);
    await expect(api.listTools()).rejects.toThrow("fml login required");
  });

  it("throws when response body is non-JSON", async () => {
    fetchSpy.mockResolvedValue({
      status: 502,
      text: async () => "Bad Gateway",
    } as Response);

    const api = createFmlClient(SERVICE_TOKEN);
    await expect(api.listTools()).rejects.toThrow("HTTP 502");
  });
});

describe("createFmlClient.listTools — JWT path (also routes through HTTP)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls GET /api/tools/list with the JWT bearer (not client.query)", async () => {
    fetchSpy.mockResolvedValue({
      text: async () => JSON.stringify({ ok: true, descriptors: DESCRIPTORS }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    const result = await api.listTools("2.0.0");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SITE_URL}/api/tools/list?pluginVersion=2.0.0`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${JWT_TOKEN}`,
    );
    expect(result).toEqual(DESCRIPTORS);
    expect(mockConvexQuery).not.toHaveBeenCalled();
  });

  it("omits pluginVersion param when not provided", async () => {
    fetchSpy.mockResolvedValue({
      text: async () => JSON.stringify({ ok: true, descriptors: DESCRIPTORS }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    await api.listTools();

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SITE_URL}/api/tools/list`);
  });

  it("throws auth error translated to login message on Unauthorized", async () => {
    fetchSpy.mockResolvedValue({
      text: async () => JSON.stringify({ ok: false, error: "Unauthorized" }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    await expect(api.listTools()).rejects.toThrow("fml login");
  });

  it("uses tool error codes to translate auth failures", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          ok: false,
          error: "Missing Authorization header",
          code: "UNAUTHENTICATED",
        }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    await expect(api.listTools()).rejects.toThrow("fml login");
  });
});

describe("createFmlClient.callBackend — unified HTTP path", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSelectedOrg.mockReturnValue(undefined);
    mockReadTokens.mockReturnValue(null);
    mockResolveRepoFromCwd.mockReturnValue(null);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("calls POST /api/tools/execute for JWT callers instead of Convex action", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { done: true } }),
    } as Response);
    mockGetSelectedOrg.mockReturnValue("acme");
    mockResolveRepoFromCwd.mockReturnValue({ repo: "acme/repo" });

    const api = createFmlClient(JWT_TOKEN);
    const result = await api.callBackend("list-engineering-sessions", {
      limit: 5,
    });

    expect(result).toEqual({ ok: true, result: { done: true } });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SITE_URL}/api/tools/execute`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${JWT_TOKEN}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      toolName: "list-engineering-sessions",
      args: { limit: 5 },
      org: "acme",
      repo: "acme/repo",
    });
    expect(mockConvexAction).not.toHaveBeenCalled();
  });

  it("lets explicit org override selected org", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: null }),
    } as Response);
    mockGetSelectedOrg.mockReturnValue("stored-org");

    const api = createFmlClient(JWT_TOKEN);
    await api.callBackend("ping", {}, { org: "explicit-org" });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      org: "explicit-org",
    });
  });

  it("forwards service-token userExternalId only for service-token callers", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: "ok" }),
    } as Response);
    mockReadTokens.mockReturnValue({ user: { id: "stored-user" } });
    vi.stubEnv("FML_USER_EXTERNAL_ID", "env-user");

    const api = createFmlClient(SERVICE_TOKEN);
    await api.callBackend("get-engineering-activity", {});

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      userExternalId: "env-user",
    });
  });

  it("omits synthetic service-token login user ids", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: "ok" }),
    } as Response);
    mockReadTokens.mockReturnValue({
      tokenType: "service",
      user: { id: "service-token", email: "service-token", name: "service" },
    });

    const api = createFmlClient(SERVICE_TOKEN);
    await api.callBackend("get-engineering-activity", {});

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty(
      "userExternalId",
    );
  });

  it("does not inherit userExternalId from stored OAuth auth for service-token callers", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: "ok" }),
    } as Response);
    mockReadTokens.mockReturnValue({
      tokenType: "oauth",
      user: {
        id: "user_oauth",
        email: "oauth@example.com",
        name: "OAuth User",
      },
    });

    const api = createFmlClient(SERVICE_TOKEN);
    await api.callBackend("get-engineering-activity", {});

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty(
      "userExternalId",
    );
  });

  it("preserves real device-flow service-token user ids", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: "ok" }),
    } as Response);
    mockReadTokens.mockReturnValue({
      tokenType: "service",
      user: { id: "user_real", email: "user@example.com", name: "User" },
    });

    const api = createFmlClient(SERVICE_TOKEN);
    await api.callBackend("get-engineering-activity", {});

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      userExternalId: "user_real",
    });
  });

  it("does not forward userExternalId for JWT callers", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: "ok" }),
    } as Response);
    mockReadTokens.mockReturnValue({ user: { id: "stored-user" } });
    vi.stubEnv("FML_USER_EXTERNAL_ID", "env-user");

    const api = createFmlClient(JWT_TOKEN);
    await api.callBackend("get-engineering-activity", {});

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty(
      "userExternalId",
    );
  });

  it("maps non-JSON HTTP response to ToolResult error", async () => {
    fetchSpy.mockResolvedValue({
      status: 502,
      text: async () => "Bad Gateway",
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    await expect(api.callBackend("ping", {})).resolves.toEqual({
      ok: false,
      error: "HTTP 502: Bad Gateway",
    });
  });

  it("translates unauthenticated HTTP envelope to login guidance", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ ok: false, error: "Unauthorized" }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    const result = await api.callBackend("ping", {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("fml login");
  });

  it("uses tool error codes to translate token expiry", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          ok: false,
          error: "Token expired",
          code: "TOKEN_EXPIRED",
        }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    const result = await api.callBackend("ping", {});

    expect(result).toEqual({
      ok: false,
      error:
        "Authentication expired. Run `fml login` to sign in again, then restart Claude Code.",
      code: "TOKEN_EXPIRED",
    });
  });

  it("preserves non-auth tool error codes for callers", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          ok: false,
          error: "Access denied",
          code: "ACCESS_DENIED",
        }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    const result = await api.callBackend("ping", {});

    expect(result).toEqual({
      ok: false,
      error: "Access denied",
      code: "ACCESS_DENIED",
    });
  });

  it("preserves unknown tool error codes for forward compatibility", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () =>
        JSON.stringify({
          ok: false,
          error: "Try again later",
          code: "NEW_BACKEND_CODE",
        }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    const result = await api.callBackend("ping", {});

    expect(result).toEqual({
      ok: false,
      error: "Try again later",
      code: "NEW_BACKEND_CODE",
    });
  });
});

describe("createFmlClient context helpers — tool gateway path", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSelectedOrg.mockReturnValue(undefined);
    mockReadTokens.mockReturnValue(null);
    mockResolveRepoFromCwd.mockReturnValue(null);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("queryOrgs calls list-orgs over HTTP for JWT callers", async () => {
    const orgs = [{ _id: "org1", name: "Acme", slug: "acme", repos: [] }];
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: orgs }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    await expect(api.queryOrgs()).resolves.toEqual(orgs);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      toolName: "list-orgs",
      args: {},
    });
    expect(mockConvexQuery).not.toHaveBeenCalled();
  });

  it("queryOrgs calls list-orgs over HTTP for service-token callers", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          result: [{ _id: "org_service", name: "Svc" }],
        }),
    } as Response);

    const api = createFmlClient(SERVICE_TOKEN);
    await expect(api.queryOrgs()).resolves.toEqual([
      { _id: "org_service", name: "Svc" },
    ]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(mockConvexQuery).not.toHaveBeenCalled();
  });

  it("queryOrgs throws tool gateway errors instead of returning empty results", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          ok: false,
          error: "Access denied",
          code: "ACCESS_DENIED",
        }),
    } as Response);

    const api = createFmlClient(SERVICE_TOKEN);
    await expect(api.queryOrgs()).rejects.toThrow("Access denied");
  });

  it("config helpers throw tool gateway errors instead of returning empty results", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () =>
        JSON.stringify({ ok: false, error: "Backend exploded" }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    await expect(api.listUserConfigSnapshots("acme")).rejects.toThrow(
      "Backend exploded",
    );
  });

  it("resolveRepo calls resolve-repo with explicit org", async () => {
    const resolved = {
      repoId: "repo1",
      fullName: "acme/repo",
      orgSlug: "acme",
    };
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: resolved }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    await expect(api.resolveRepo("acme", "acme/repo")).resolves.toEqual(
      resolved,
    );

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      toolName: "resolve-repo",
      args: { orgSlug: "acme", repoFullName: "acme/repo" },
      org: "acme",
    });
  });

  it("config snapshot helpers call their gateway tools", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: [] }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    await api.listUserConfigSnapshots("acme");
    await api.listRepoConfigSnapshots("acme", "acme/repo");

    const bodies = fetchSpy.mock.calls.map((call: unknown) => {
      const [, init] = call as [string, RequestInit];
      return JSON.parse(init.body as string);
    });
    expect(bodies).toEqual([
      {
        toolName: "list-user-config-snapshots",
        args: { orgSlug: "acme" },
        org: "acme",
      },
      {
        toolName: "list-repo-config-snapshots",
        args: { orgSlug: "acme", repository: "acme/repo" },
        org: "acme",
      },
    ]);
  });

  it("config snapshot detail helpers call their gateway tools", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: null }),
    } as Response);

    const api = createFmlClient(JWT_TOKEN);
    await api.getUserConfigDetail("acme", "octo");
    await api.getRepoConfigDetail("acme", "acme/repo");

    const bodies = fetchSpy.mock.calls.map((call: unknown) => {
      const [, init] = call as [string, RequestInit];
      return JSON.parse(init.body as string);
    });
    expect(bodies).toEqual([
      {
        toolName: "get-user-config-snapshot",
        args: { orgSlug: "acme", githubUsername: "octo" },
        org: "acme",
      },
      {
        toolName: "get-repo-config-snapshot",
        args: { orgSlug: "acme", repository: "acme/repo" },
        org: "acme",
      },
    ]);
  });
});
