import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPanopticonExec = vi.fn();

vi.mock("../../daemon-utils.js", () => ({
  panopticonExec: (...args: unknown[]) => mockPanopticonExec(...args),
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockPanopticonExec.mockReturnValue({ ok: true, stdout: "ok\n" });
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
});
