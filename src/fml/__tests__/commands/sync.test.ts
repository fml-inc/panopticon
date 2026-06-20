import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSyncReset = vi.fn();

vi.mock("../../../api/client.js", () => ({
  syncReset: (...args: unknown[]) => mockSyncReset(...args),
  syncPending: vi.fn(),
}));

vi.mock("../../../sync/index.js", () => ({
  createSyncLoop: vi.fn(),
  loadSyncConfig: vi.fn(),
  listTargets: vi.fn(() => []),
  addTarget: vi.fn(),
  removeTarget: vi.fn(),
  saveSyncConfig: vi.fn(),
}));

vi.mock("../../sync/client.js", () => ({
  resolveGitHubToken: vi.fn(),
  resolveSyncTokenCommand: vi.fn(),
}));

import { handleSyncReset } from "../../commands/sync.js";

describe("sync reset command", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
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
});
