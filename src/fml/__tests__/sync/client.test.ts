import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.fn();
const mockReadTokens = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("../../auth/token-store.js", () => ({
  readTokens: (...args: unknown[]) => mockReadTokens(...args),
}));

vi.mock("../../config.js", () => ({
  getActiveEnv: () => ({ name: "fml", convexUrl: null }),
  isValidEnvName: (s: string) => /^[A-Za-z0-9_-]+$/.test(s),
}));

describe("resolveSyncTokenCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PANOPTICON_GITHUB_TOKEN;
    // Reset module cache so the per-module gh-token cache starts clean
    vi.resetModules();
  });

  it("picks 'gh auth token' when gh is available", async () => {
    mockExecSync.mockReturnValue("gho_abc123\n");
    const { resolveSyncTokenCommand } = await import("../../sync/client.js");

    expect(resolveSyncTokenCommand()).toBe("gh auth token");
    expect(mockReadTokens).not.toHaveBeenCalled();
  });

  it("picks 'gh auth token' when PANOPTICON_GITHUB_TOKEN is set", async () => {
    process.env.PANOPTICON_GITHUB_TOKEN = "gho_env";
    const { resolveSyncTokenCommand } = await import("../../sync/client.js");

    expect(resolveSyncTokenCommand()).toBe("gh auth token");
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("falls back to 'fml sync-token --env <active>' when gh fails but a login exists", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh not found");
    });
    mockReadTokens.mockReturnValue({
      accessToken: "x",
      refreshToken: "y",
      expiresAt: Date.now() + 3_600_000,
      user: { id: "u", email: "e", name: "n" },
    });
    const { resolveSyncTokenCommand } = await import("../../sync/client.js");

    expect(resolveSyncTokenCommand()).toBe("fml sync-token --env fml");
  });

  it("returns undefined when neither gh nor a login is available", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh not found");
    });
    mockReadTokens.mockReturnValue(null);
    const { resolveSyncTokenCommand } = await import("../../sync/client.js");

    expect(resolveSyncTokenCommand()).toBeUndefined();
  });
});
