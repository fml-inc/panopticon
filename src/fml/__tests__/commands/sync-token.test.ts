import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetValidToken = vi.fn();

vi.mock("../../auth/token-store.js", () => ({
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

import { handleSyncToken } from "../../commands/sync-token.js";

describe("fml sync-token command", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Stop `process.exit` from killing the test runner; throw instead so
    // the assertion after the exit call is unreachable (matches real
    // behavior where `handleSyncToken` never returns).
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("writes the token to stdout and exits 0", async () => {
    mockGetValidToken.mockResolvedValue("fml_st_abcdef");

    await expect(handleSyncToken()).rejects.toThrow("exit:0");

    expect(stdoutSpy).toHaveBeenCalledWith("fml_st_abcdef");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("errors on stderr and exits 1 when no token is available", async () => {
    mockGetValidToken.mockResolvedValue(null);

    await expect(handleSyncToken()).rejects.toThrow("exit:1");

    expect(stderrSpy).toHaveBeenCalledWith(
      "fml: not logged in. Run `fml login` to enable sync.",
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("forwards --env to getValidToken and names the env in the error", async () => {
    mockGetValidToken.mockResolvedValue(null);

    await expect(handleSyncToken({ env: "dev" })).rejects.toThrow("exit:1");

    expect(mockGetValidToken).toHaveBeenCalledWith({ env: "dev" });
    expect(stderrSpy).toHaveBeenCalledWith(
      'fml: not logged in for env "dev". Run `fml login` to enable sync.',
    );
  });
});
