import { beforeEach, describe, expect, it, vi } from "vitest";

const clearStoredCredentials = vi.fn();

vi.mock("../../auth/token-store.js", () => ({
  clearStoredCredentials: () => clearStoredCredentials(),
}));

vi.mock("../../config.js", () => ({
  getActiveEnv: () => ({
    name: "fml",
    convexUrl: "https://example.convex.cloud",
  }),
}));

import { handleLogout } from "../../commands/logout.js";

describe("logout command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears stored credentials", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    handleLogout();
    expect(clearStoredCredentials).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it("prints confirmation message naming the active env", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    handleLogout();
    expect(consoleSpy).toHaveBeenCalledWith(
      'Logged out of "fml". Stored credentials cleared.',
    );
    consoleSpy.mockRestore();
  });
});
