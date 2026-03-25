import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-unified-config");
  return {
    config: { dataDir: tmpDir },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "./config.js";
import {
  loadRetentionConfig,
  loadUnifiedConfig,
  saveUnifiedConfig,
} from "./unified-config.js";

describe("unified config", () => {
  beforeEach(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("returns defaults when no files exist", () => {
    const cfg = loadUnifiedConfig();
    expect(cfg.sync.targets).toEqual([]);
    expect(cfg.retention.maxAgeDays).toBe(90);
    expect(cfg.retention.maxSizeMb).toBe(1000);
    expect(cfg.retention.syncedMaxAgeDays).toBeUndefined();
  });

  it("reads config.json when present", () => {
    fs.writeFileSync(
      path.join(config.dataDir, "config.json"),
      JSON.stringify({
        sync: { targets: [{ name: "prod", url: "http://prod" }] },
        retention: { maxAgeDays: 30, maxSizeMb: 500, syncedMaxAgeDays: 7 },
      }),
    );
    const cfg = loadUnifiedConfig();
    expect(cfg.sync.targets).toHaveLength(1);
    expect(cfg.sync.targets[0].name).toBe("prod");
    expect(cfg.retention.maxAgeDays).toBe(30);
    expect(cfg.retention.syncedMaxAgeDays).toBe(7);
  });

  it("merges defaults for missing retention fields", () => {
    fs.writeFileSync(
      path.join(config.dataDir, "config.json"),
      JSON.stringify({
        sync: { targets: [] },
        retention: { syncedMaxAgeDays: 14 },
      }),
    );
    const cfg = loadUnifiedConfig();
    expect(cfg.retention.maxAgeDays).toBe(90);
    expect(cfg.retention.maxSizeMb).toBe(1000);
    expect(cfg.retention.syncedMaxAgeDays).toBe(14);
  });

  it("merges defaults when retention section is missing entirely", () => {
    fs.writeFileSync(
      path.join(config.dataDir, "config.json"),
      JSON.stringify({ sync: { targets: [] } }),
    );
    const cfg = loadUnifiedConfig();
    expect(cfg.retention.maxAgeDays).toBe(90);
    expect(cfg.retention.maxSizeMb).toBe(1000);
  });

  it("migrates sync.json to config.json", () => {
    const syncPath = path.join(config.dataDir, "sync.json");
    fs.writeFileSync(
      syncPath,
      JSON.stringify({
        targets: [{ name: "grafana", url: "http://grafana:14318" }],
        filter: { includeRepos: ["org/*"] },
      }),
    );

    const cfg = loadUnifiedConfig();

    // Data migrated correctly
    expect(cfg.sync.targets).toHaveLength(1);
    expect(cfg.sync.targets[0].name).toBe("grafana");
    expect(cfg.sync.filter?.includeRepos).toEqual(["org/*"]);
    expect(cfg.retention.maxAgeDays).toBe(90);

    // config.json created
    expect(fs.existsSync(path.join(config.dataDir, "config.json"))).toBe(true);

    // sync.json renamed to .bak
    expect(fs.existsSync(syncPath)).toBe(false);
    expect(fs.existsSync(path.join(config.dataDir, "sync.json.bak"))).toBe(
      true,
    );
  });

  it("does not clobber existing config.json during migration", () => {
    // Write both files — config.json should win
    fs.writeFileSync(
      path.join(config.dataDir, "config.json"),
      JSON.stringify({
        sync: { targets: [{ name: "real", url: "http://real" }] },
        retention: { maxAgeDays: 10, maxSizeMb: 100 },
      }),
    );
    fs.writeFileSync(
      path.join(config.dataDir, "sync.json"),
      JSON.stringify({ targets: [{ name: "stale", url: "http://stale" }] }),
    );

    const cfg = loadUnifiedConfig();
    expect(cfg.sync.targets[0].name).toBe("real");
    // sync.json should still be there (not migrated)
    expect(fs.existsSync(path.join(config.dataDir, "sync.json"))).toBe(true);
  });

  it("save and load round-trips", () => {
    const original = {
      sync: {
        targets: [{ name: "t", url: "http://t", token: "secret" }],
        filter: { excludeRepos: ["private/*"] },
      },
      retention: { maxAgeDays: 60, maxSizeMb: 2000, syncedMaxAgeDays: 3 },
    };
    saveUnifiedConfig(original);
    const loaded = loadUnifiedConfig();
    expect(loaded).toEqual(original);
  });

  it("loadRetentionConfig returns just retention", () => {
    saveUnifiedConfig({
      sync: { targets: [] },
      retention: { maxAgeDays: 45, maxSizeMb: 800 },
    });
    const ret = loadRetentionConfig();
    expect(ret.maxAgeDays).toBe(45);
    expect(ret.maxSizeMb).toBe(800);
  });

  it("handles corrupt config.json gracefully", () => {
    fs.writeFileSync(path.join(config.dataDir, "config.json"), "not json{{{");
    const cfg = loadUnifiedConfig();
    expect(cfg.sync.targets).toEqual([]);
    expect(cfg.retention.maxAgeDays).toBe(90);
  });

  it("handles corrupt sync.json gracefully during migration", () => {
    fs.writeFileSync(path.join(config.dataDir, "sync.json"), "broken");
    const cfg = loadUnifiedConfig();
    expect(cfg.sync.targets).toEqual([]);
  });
});
