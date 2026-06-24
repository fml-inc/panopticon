import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncTarget } from "../../../sync/index.js";

const mockAddTarget = vi.fn();
const mockLoadSyncConfig = vi.fn();
const mockSaveSyncConfig = vi.fn();
const mockStoreServiceRefreshToken = vi.fn();
const mockCreateFmlClient = vi.fn();
const mockGetSelectedOrg = vi.fn();
const mockGetValidToken = vi.fn();
const mockSetSelectedOrg = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("../../../sync/index.js", () => ({
  addTarget: (...args: unknown[]) => mockAddTarget(...args),
  loadSyncConfig: (...args: unknown[]) => mockLoadSyncConfig(...args),
  saveSyncConfig: (...args: unknown[]) => mockSaveSyncConfig(...args),
}));

// Stub out modules handleLogin pulls in — we only test the helper.
vi.mock("../../auth/oauth.js", () => ({
  login: vi.fn(),
  canOpenBrowser: vi.fn(),
}));
vi.mock("../../auth/device-flow.js", () => ({ deviceLogin: vi.fn() }));
vi.mock("../../auth/token-store.js", () => ({
  getSelectedOrg: (...args: unknown[]) => mockGetSelectedOrg(...args),
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
  SERVICE_TOKEN_LOGIN_USER_ID: "service-token",
  setSelectedOrg: (...args: unknown[]) => mockSetSelectedOrg(...args),
  storeServiceRefreshToken: (...args: unknown[]) =>
    mockStoreServiceRefreshToken(...args),
}));
vi.mock("../../fml-client.js", () => ({
  createFmlClient: (...args: unknown[]) => mockCreateFmlClient(...args),
}));
vi.mock("../../sync/client.js", () => ({ resolveGitHubToken: vi.fn() }));
vi.mock("../../sentry.js", () => ({
  Sentry: {
    captureException: (...args: unknown[]) => mockCaptureException(...args),
  },
}));
const mockGetActiveEnv = vi.fn(() => ({
  name: "fml" as string,
  convexUrl: null as string | null,
}));
vi.mock("../../config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    getActiveEnv: () => mockGetActiveEnv(),
  };
});

import {
  handleServiceTokenLogin,
  runServiceTokenLogin,
  upgradeSyncTargetAfterLogin,
} from "../../commands/login.js";

describe("upgradeSyncTargetAfterLogin", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFmlClient.mockReset();
    mockGetSelectedOrg.mockReset();
    mockGetValidToken.mockReset();
    mockSetSelectedOrg.mockReset();
    mockStoreServiceRefreshToken.mockReset();
    mockCaptureException.mockReset();
    mockGetActiveEnv.mockReturnValue({ name: "fml", convexUrl: null });
    mockGetValidToken.mockResolvedValue(null);
    mockGetSelectedOrg.mockReturnValue(null);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("adds the active env's target when none exists", () => {
    mockLoadSyncConfig.mockReturnValue({ targets: [] });

    upgradeSyncTargetAfterLogin();

    expect(mockAddTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "fml",
        tokenCommand: "fml sync-token --env fml",
      }),
    );
    expect(mockSaveSyncConfig).not.toHaveBeenCalled();
  });

  it("pins tokenCommand when the active env's target is URL-only", () => {
    const target: SyncTarget = { name: "fml", url: "https://x.convex.site" };
    mockLoadSyncConfig.mockReturnValue({ targets: [target] });

    upgradeSyncTargetAfterLogin();

    expect(target.tokenCommand).toBe("fml sync-token --env fml");
    expect(mockSaveSyncConfig).toHaveBeenCalledWith({ targets: [target] });
    expect(mockAddTarget).not.toHaveBeenCalled();
  });

  it("upgrades legacy `fml sync-token` (no --env) to the pinned form", () => {
    const target: SyncTarget = {
      name: "fml",
      url: "https://x.convex.site",
      tokenCommand: "fml sync-token",
    };
    mockLoadSyncConfig.mockReturnValue({ targets: [target] });

    upgradeSyncTargetAfterLogin();

    expect(target.tokenCommand).toBe("fml sync-token --env fml");
    expect(mockSaveSyncConfig).toHaveBeenCalled();
  });

  it("does not touch other envs' targets", () => {
    const devTarget: SyncTarget = {
      name: "dev",
      url: "https://y.convex.site",
    };
    const fmlTarget: SyncTarget = {
      name: "fml",
      url: "https://x.convex.site",
    };
    mockLoadSyncConfig.mockReturnValue({ targets: [devTarget, fmlTarget] });

    upgradeSyncTargetAfterLogin();

    expect(devTarget.tokenCommand).toBeUndefined();
    expect(fmlTarget.tokenCommand).toBe("fml sync-token --env fml");
  });

  it("leaves an unrelated tokenCommand untouched (preserves gh attribution)", () => {
    const target: SyncTarget = {
      name: "fml",
      url: "https://x.convex.site",
      tokenCommand: "gh auth token",
    };
    mockLoadSyncConfig.mockReturnValue({ targets: [target] });

    upgradeSyncTargetAfterLogin();

    expect(target.tokenCommand).toBe("gh auth token");
    expect(mockSaveSyncConfig).not.toHaveBeenCalled();
    expect(mockAddTarget).not.toHaveBeenCalled();
  });

  it("forces an explicit service-token login over an unrelated tokenCommand", async () => {
    const target: SyncTarget = {
      name: "fml",
      url: "https://x.convex.site",
      tokenCommand: "gh auth token",
    };
    mockLoadSyncConfig.mockReturnValue({ targets: [target] });
    mockStoreServiceRefreshToken.mockResolvedValue(true);

    await runServiceTokenLogin("fml_srt_refresh");

    expect(mockStoreServiceRefreshToken).toHaveBeenCalledWith(
      "fml_srt_refresh",
      { env: "fml" },
    );
    expect(target.tokenCommand).toBe("fml sync-token --env fml");
    expect(mockSaveSyncConfig).toHaveBeenCalledWith({ targets: [target] });
  });

  it("passes the active env through org selection after service-token login", async () => {
    const target: SyncTarget = {
      name: "dev",
      url: "https://x.convex.site",
    };
    mockGetActiveEnv.mockReturnValue({ name: "dev", convexUrl: null });
    mockLoadSyncConfig.mockReturnValue({ targets: [target] });
    mockStoreServiceRefreshToken.mockResolvedValue(true);
    mockGetValidToken.mockResolvedValue("fml_st_access");
    mockCreateFmlClient.mockReturnValue({
      queryOrgs: vi
        .fn()
        .mockResolvedValue([{ _id: "org1", name: "Agent F", slug: "agent-f" }]),
    });

    await runServiceTokenLogin("fml_srt_refresh");

    expect(mockGetValidToken).toHaveBeenCalledWith({ env: "dev" });
    expect(mockGetSelectedOrg).toHaveBeenCalledWith("dev");
    expect(mockSetSelectedOrg).toHaveBeenCalledWith("agent-f", "dev");
  });

  it("does not report user-canceled service-token login to Sentry", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    mockLoadSyncConfig.mockReturnValue({ targets: [] });
    mockStoreServiceRefreshToken.mockRejectedValue(new Error("Canceled"));

    await expect(handleServiceTokenLogin("fml_srt_refresh")).rejects.toThrow(
      "exit:1",
    );

    expect(errorSpy).toHaveBeenCalledWith("Login canceled.");
    expect(mockCaptureException).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("leaves an existing static token untouched", () => {
    const target: SyncTarget = {
      name: "fml",
      url: "https://x.convex.site",
      token: "static_xyz",
    };
    mockLoadSyncConfig.mockReturnValue({ targets: [target] });

    upgradeSyncTargetAfterLogin();

    expect(target.token).toBe("static_xyz");
    expect(target.tokenCommand).toBeUndefined();
    expect(mockSaveSyncConfig).not.toHaveBeenCalled();
  });

  it("removes a static token when service-token login is explicit", () => {
    const target: SyncTarget = {
      name: "fml",
      url: "https://x.convex.site",
      token: "static_xyz",
    };
    mockLoadSyncConfig.mockReturnValue({ targets: [target] });

    upgradeSyncTargetAfterLogin({ forceTokenCommand: true });

    expect(target.token).toBeUndefined();
    expect(target.tokenCommand).toBe("fml sync-token --env fml");
    expect(mockSaveSyncConfig).toHaveBeenCalledWith({ targets: [target] });
  });

  it("refuses to write a tokenCommand when the env name is unsafe", () => {
    mockGetActiveEnv.mockReturnValue({ name: "x; rm -rf /", convexUrl: null });
    mockLoadSyncConfig.mockReturnValue({ targets: [] });

    upgradeSyncTargetAfterLogin();

    expect(mockAddTarget).not.toHaveBeenCalled();
    expect(mockSaveSyncConfig).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsafe characters"),
    );
  });

  it("swallows errors from loadSyncConfig and warns instead", () => {
    mockLoadSyncConfig.mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => upgradeSyncTargetAfterLogin()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not update sync target: boom"),
    );
  });
});
