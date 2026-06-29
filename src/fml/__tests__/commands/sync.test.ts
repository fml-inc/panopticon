import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSyncReset = vi.fn();
const mockSyncPending = vi.fn();
const mockSyncRejected = vi.fn();
const mockListTargets = vi.fn();

vi.mock("../../../api/client.js", () => ({
  syncReset: (...args: unknown[]) => mockSyncReset(...args),
  syncPending: (...args: unknown[]) => mockSyncPending(...args),
  syncRejected: (...args: unknown[]) => mockSyncRejected(...args),
}));

vi.mock("../../../sync/index.js", () => ({
  createSyncLoop: vi.fn(),
  loadSyncConfig: vi.fn(),
  listTargets: (...args: unknown[]) => mockListTargets(...args),
  addTarget: vi.fn(),
  removeTarget: vi.fn(),
  saveSyncConfig: vi.fn(),
}));

vi.mock("../../sync/client.js", () => ({
  resolveGitHubToken: vi.fn(),
  resolveSyncTokenCommand: vi.fn(),
}));

import {
  handleSyncRejected,
  handleSyncReset,
  handleSyncStatus,
} from "../../commands/sync.js";

describe("sync reset command", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListTargets.mockReturnValue([]);
    mockSyncPending.mockResolvedValue({
      target: "fml",
      totalPending: 0,
      rejectedSessions: 0,
      tables: {},
    });
    mockSyncRejected.mockResolvedValue({
      target: "fml",
      total: 0,
      limit: 50,
      offset: 0,
      sessions: [],
    });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("resets all watermarks when no target specified", async () => {
    await handleSyncReset();

    expect(mockSyncReset).toHaveBeenCalledWith("fml");
    expect(consoleSpy).toHaveBeenCalledWith(
      'Sync watermarks for "fml" reset to 0.',
    );
  });

  it("resets watermarks for specific target", async () => {
    await handleSyncReset("my-target");

    expect(mockSyncReset).toHaveBeenCalledWith("my-target");
    expect(consoleSpy).toHaveBeenCalledWith(
      'Sync watermarks for "my-target" reset to 0.',
    );
  });

  it("reports rejected sessions separately from pending work", async () => {
    mockListTargets.mockReturnValue([
      {
        name: "fml",
        url: "https://api.fml.dev/sync",
        tokenCommand: "fml sync-token",
      },
    ]);
    mockSyncPending.mockResolvedValue({
      target: "fml",
      totalPending: 0,
      rejectedSessions: 2,
      tables: {},
    });

    await handleSyncStatus();

    expect(consoleSpy).toHaveBeenCalledWith("  Status: no pending rows");
    expect(consoleSpy).toHaveBeenCalledWith(
      '  Rejected: 2 sessions (run "fml sync reset fml" to retry)',
    );
  });

  it("lists rejected session details for the default sync target", async () => {
    mockSyncRejected.mockResolvedValue({
      target: "fml",
      total: 1,
      limit: 10,
      offset: 0,
      sessions: [
        {
          sessionId: "session-1",
          code: "repo_not_allowed",
          reason: "repository is not enabled for target",
          rejectedAtMs: 123,
          syncSeq: 4,
        },
      ],
    });

    await handleSyncRejected(undefined, { limit: 10, offset: 0 });

    expect(mockSyncRejected).toHaveBeenCalledWith("fml", {
      limit: 10,
      offset: 0,
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      'Rejected sessions for "fml" (1 total):',
    );
    expect(consoleSpy).toHaveBeenCalledWith("  session-1");
    expect(consoleSpy).toHaveBeenCalledWith("    code: repo_not_allowed");
    expect(consoleSpy).toHaveBeenCalledWith(
      "    reason: repository is not enabled for target",
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      "Retry after fixing the cause: fml sync reset fml",
    );
  });

  it("prints rejected session diagnostics as JSON", async () => {
    const payload = {
      target: "other",
      total: 0,
      limit: 50,
      offset: 0,
      sessions: [],
    };
    mockSyncRejected.mockResolvedValue(payload);

    await handleSyncRejected("other", { json: true });

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(payload, null, 2));
  });
});
