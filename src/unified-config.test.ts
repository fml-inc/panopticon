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

  it("save and load round-trips", () => {
    const original = {
      sync: {
        enabled: true,
        targets: [{ name: "t", url: "http://t", token: "secret" }],
        filter: { excludeRepos: ["private/*"] },
      },
      retention: { maxAgeDays: 60, maxSizeMb: 2000, syncedMaxAgeDays: 3 },
    };
    saveUnifiedConfig(original);
    const loaded = loadUnifiedConfig();
    expect(loaded).toEqual({
      hooksInstalled: undefined,
      sentryDsn: undefined,
      ...original,
    });
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

  it("hooksInstalled defaults to undefined when not set", () => {
    const cfg = loadUnifiedConfig();
    expect(cfg.hooksInstalled).toBeUndefined();
  });

  it("hooksInstalled round-trips through save/load", () => {
    saveUnifiedConfig({
      hooksInstalled: true,
      sync: { targets: [] },
      retention: { maxAgeDays: 90, maxSizeMb: 1000 },
    });
    const cfg = loadUnifiedConfig();
    expect(cfg.hooksInstalled).toBe(true);
  });

  it("hooksInstalled is preserved when missing from file", () => {
    fs.writeFileSync(
      path.join(config.dataDir, "config.json"),
      JSON.stringify({
        sync: { targets: [] },
        retention: { maxAgeDays: 90, maxSizeMb: 1000 },
      }),
    );
    const cfg = loadUnifiedConfig();
    expect(cfg.hooksInstalled).toBeUndefined();
  });

  it("handles corrupt config.json gracefully", () => {
    fs.writeFileSync(path.join(config.dataDir, "config.json"), "not json{{{");
    const cfg = loadUnifiedConfig();
    expect(cfg.sync.targets).toEqual([]);
    expect(cfg.retention.maxAgeDays).toBe(90);
  });
});
