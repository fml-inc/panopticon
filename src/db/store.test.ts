import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
  const dataDir = `/tmp/panopticon-store-test-${process.pid}`;
  return {
    dataDir,
    dbPath: `${dataDir}/panopticon.db`,
  };
});

vi.mock("../config.js", () => ({
  config: {
    dataDir: testPaths.dataDir,
    dbPath: testPaths.dbPath,
  },
}));

import { closeDb, getDb } from "./schema.js";
import { insertUserConfigSnapshot, type UserConfigSnapshot } from "./store.js";

function baseUserConfigSnapshot(
  overrides: Partial<UserConfigSnapshot> = {},
): UserConfigSnapshot {
  return {
    deviceName: "test-device",
    target: "pi",
    permissions: { allow: ["Read"], nested: { ask: true } },
    enabledPlugins: [{ pluginName: "pi-subagents", marketplace: "npm" }],
    hooks: [],
    commands: [],
    rules: [],
    skills: [{ name: "review", content: "# Review\n" }],
    pluginHooks: [{ event: "SessionStart", hooks: [] }],
    panopticonAllowed: { commands: ["pnpm test"] },
    panopticonApprovals: { approvals: { abc: true } },
    memoryFiles: { project: { "memory/MEMORY.md": "hello" } },
    ...overrides,
  };
}

function userConfigSnapshotCount(): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM user_config_snapshots")
      .get() as { count: number }
  ).count;
}

describe("insertUserConfigSnapshot", () => {
  beforeEach(() => {
    fs.mkdirSync(testPaths.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  });

  it("deduplicates identical user config snapshots", () => {
    expect(insertUserConfigSnapshot(baseUserConfigSnapshot())).toBe(true);
    expect(insertUserConfigSnapshot(baseUserConfigSnapshot())).toBe(false);
    expect(userConfigSnapshotCount()).toBe(1);
  });

  it("inserts a new row when normalized snapshot content changes", () => {
    expect(insertUserConfigSnapshot(baseUserConfigSnapshot())).toBe(true);

    expect(
      insertUserConfigSnapshot(
        baseUserConfigSnapshot({
          enabledPlugins: [
            { pluginName: "pi-subagents", marketplace: "npm" },
            { pluginName: "pi-missions", marketplace: "local" },
          ],
        }),
      ),
    ).toBe(true);

    expect(userConfigSnapshotCount()).toBe(2);
  });
});
