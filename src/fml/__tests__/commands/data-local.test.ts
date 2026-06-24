import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPanopticonExec = vi.fn();
const mockCallBackend = vi.fn();
const mockGetAuthenticatedClient = vi.fn();

vi.mock("../../daemon-utils.js", () => ({
  panopticonExec: (...args: unknown[]) => mockPanopticonExec(...args),
}));

vi.mock("../../fml-client.js", () => ({
  getAuthenticatedClient: (...args: unknown[]) =>
    mockGetAuthenticatedClient(...args),
}));

import {
  handleActivity,
  handleSearch,
  handleSessions,
  handleSpending,
  handleTimeline,
} from "../../commands/data.js";
import { handleLocal } from "../../commands/local.js";

describe("local data command forwarding", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(
      (_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      },
    );
    mockPanopticonExec.mockReturnValue({ ok: true, stdout: "ok\n" });
    mockGetAuthenticatedClient.mockResolvedValue({
      callBackend: mockCallBackend,
    });
    mockCallBackend.mockResolvedValue({ ok: true, result: { ok: true } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards activity --local to panopticon summary", async () => {
    await handleActivity({ local: true, since: "7d" });

    expect(mockPanopticonExec).toHaveBeenCalledWith(
      "summary",
      "--since",
      "7d",
      {
        timeout: 120_000,
      },
    );
  });

  it("uses the cloud default window for activity --local", async () => {
    await handleActivity({ local: true });

    expect(mockPanopticonExec).toHaveBeenCalledWith(
      "summary",
      "--since",
      "24h",
      { timeout: 120_000 },
    );
  });

  it("forwards sessions --local to panopticon sessions", async () => {
    await handleSessions({ local: true, since: "24h", limit: "5" });

    expect(mockPanopticonExec).toHaveBeenCalledWith(
      "sessions",
      "--since",
      "24h",
      "--limit",
      "5",
      { timeout: 120_000 },
    );
  });

  it("uses the cloud default window for sessions --local", async () => {
    await handleSessions({ local: true, limit: "5" });

    expect(mockPanopticonExec).toHaveBeenCalledWith(
      "sessions",
      "--since",
      "24h",
      "--limit",
      "5",
      { timeout: 120_000 },
    );
  });

  it("forwards timeline --local to panopticon timeline", async () => {
    await handleTimeline("session-1", {
      local: true,
      limit: "20",
      offset: "2",
      full: true,
    });

    expect(mockPanopticonExec).toHaveBeenCalledWith(
      "timeline",
      "session-1",
      "--limit",
      "20",
      "--offset",
      "2",
      "--full",
      { timeout: 120_000 },
    );
  });

  it("forwards spending --local to panopticon costs", async () => {
    await handleSpending({ local: true, since: "30d", groupBy: "model" });

    expect(mockPanopticonExec).toHaveBeenCalledWith(
      "costs",
      "--since",
      "30d",
      "--group-by",
      "model",
      { timeout: 120_000 },
    );
  });

  it("uses the cloud default window for spending --local", async () => {
    await handleSpending({ local: true });

    expect(mockPanopticonExec).toHaveBeenCalledWith("costs", "--since", "7d", {
      timeout: 120_000,
    });
  });

  it("forwards search --local to panopticon search", async () => {
    await handleSearch("auth flow", {
      local: true,
      since: "7d",
      limit: "10",
      offset: "3",
      full: true,
    });

    expect(mockPanopticonExec).toHaveBeenCalledWith(
      "search",
      "auth flow",
      "--since",
      "7d",
      "--limit",
      "10",
      "--offset",
      "3",
      "--full",
      { timeout: 120_000 },
    );
  });

  it("uses the cloud default window for search --local", async () => {
    await handleSearch("auth flow", { local: true });

    expect(mockPanopticonExec).toHaveBeenCalledWith(
      "search",
      "auth flow",
      "--since",
      "7d",
      { timeout: 120_000 },
    );
  });

  it("passes arbitrary fml local args through", () => {
    handleLocal(["file", "overview", "src/cli.ts"]);

    expect(mockPanopticonExec).toHaveBeenCalledWith(
      "file",
      "overview",
      "src/cli.ts",
      { timeout: 120_000 },
    );
  });

  it("passes timeline cloud offset through to the backend", async () => {
    await handleTimeline("session-1", {
      limit: "20",
      offset: "2",
    });

    expect(mockCallBackend).toHaveBeenCalledWith("get-session-timeline", {
      sessionId: "session-1",
      limit: 20,
      offset: 2,
    });
  });

  it("rejects timeline --full without --local", async () => {
    await expect(handleTimeline("session-1", { full: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--full is only supported with --local"),
    );
    expect(mockCallBackend).not.toHaveBeenCalled();
  });

  it("passes search cloud query options through to the backend", async () => {
    await handleSearch("auth flow", { since: "30d", limit: "10" });

    expect(mockCallBackend).toHaveBeenCalledWith(
      "search-engineering-sessions",
      {
        query: "auth flow",
        timeRange: "30d",
        limit: 10,
      },
    );
  });

  it("rejects search local-only flags without --local", async () => {
    await expect(
      handleSearch("auth flow", { offset: "20", full: true }),
    ).rejects.toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "--offset, --full are only supported with --local",
      ),
    );
    expect(mockCallBackend).not.toHaveBeenCalled();
  });
});
