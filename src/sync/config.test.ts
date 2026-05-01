import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-sync-config");
  return {
    config: { dataDir: tmpDir },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "../config.js";

import {
  addTarget,
  listTargets,
  loadSyncConfig,
  removeTarget,
  saveSyncConfig,
} from "./config.js";

describe("sync config", () => {
  beforeEach(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("returns empty targets when no config file", () => {
    const cfg = loadSyncConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.targets).toEqual([]);
  });

  it("saves and loads config", () => {
    saveSyncConfig({
      targets: [{ name: "test", url: "http://localhost:4318" }],
    });
    const cfg = loadSyncConfig();
    expect(cfg.targets).toHaveLength(1);
    expect(cfg.targets[0].name).toBe("test");
    expect(cfg.targets[0].url).toBe("http://localhost:4318");
    expect(cfg.enabled).toBe(true);
  });

  it("saves disabled sync config", () => {
    saveSyncConfig({
      enabled: false,
      targets: [{ name: "test", url: "http://localhost:4318" }],
    });
    const cfg = loadSyncConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.targets).toHaveLength(1);
  });

  it("preserves disabled sync when saving targets only", () => {
    saveSyncConfig({
      enabled: false,
      targets: [{ name: "test", url: "http://localhost:4318" }],
    });
    saveSyncConfig({
      targets: [{ name: "prod", url: "http://localhost:4318" }],
    });
    const cfg = loadSyncConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.targets).toHaveLength(1);
    expect(cfg.targets[0].name).toBe("prod");
  });

  it("addTarget creates new target", () => {
    addTarget({ name: "grafana", url: "http://localhost:14318" });
    const targets = listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe("grafana");
  });

  it("addTarget updates existing target by name", () => {
    addTarget({ name: "grafana", url: "http://old:1234" });
    addTarget({ name: "grafana", url: "http://new:5678" });
    const targets = listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].url).toBe("http://new:5678");
  });

  it("addTarget preserves other targets", () => {
    addTarget({ name: "a", url: "http://a" });
    addTarget({ name: "b", url: "http://b" });
    expect(listTargets()).toHaveLength(2);
  });

  it("addTarget stores token", () => {
    addTarget({ name: "prod", url: "http://prod", token: "secret" });
    const targets = listTargets();
    expect(targets[0].token).toBe("secret");
  });

  it("removeTarget removes by name", () => {
    addTarget({ name: "a", url: "http://a" });
    addTarget({ name: "b", url: "http://b" });
    expect(removeTarget("a")).toBe(true);
    const targets = listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe("b");
  });

  it("removeTarget returns false for unknown name", () => {
    addTarget({ name: "a", url: "http://a" });
    expect(removeTarget("nope")).toBe(false);
    expect(listTargets()).toHaveLength(1);
  });

  it("saves filter config", () => {
    saveSyncConfig({
      targets: [{ name: "t", url: "http://t" }],
      filter: { includeRepos: ["org/*"], excludeRepos: ["org/private"] },
    });
    const cfg = loadSyncConfig();
    expect(cfg.filter?.includeRepos).toEqual(["org/*"]);
    expect(cfg.filter?.excludeRepos).toEqual(["org/private"]);
  });
});
