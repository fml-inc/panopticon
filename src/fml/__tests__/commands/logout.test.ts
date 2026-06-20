import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  authStorePath: () => "/tmp/fml-test-logout-auth.json",
}));

import { handleLogout } from "../../commands/logout.js";

describe("logout command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the auth file", () => {
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    handleLogout();
    expect(unlinkSpy).toHaveBeenCalledWith("/tmp/fml-test-logout-auth.json");
    consoleSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it("prints confirmation message", () => {
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    handleLogout();
    expect(consoleSpy).toHaveBeenCalledWith(
      "Logged out. Stored credentials cleared.",
    );
    consoleSpy.mockRestore();
  });

  it("does not throw when auth file does not exist", () => {
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => handleLogout()).not.toThrow();
    consoleSpy.mockRestore();
  });
});
