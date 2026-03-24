import fs from "node:fs";
import path from "node:path";
import { config, ensureDataDir } from "../config.js";
import type { SyncFilter, SyncTarget } from "./types.js";

export interface SyncConfig {
  targets: SyncTarget[];
  filter?: SyncFilter;
}

const SYNC_CONFIG_FILE = "sync.json";

function syncConfigPath(): string {
  return path.join(config.dataDir, SYNC_CONFIG_FILE);
}

export function loadSyncConfig(): SyncConfig {
  const p = syncConfigPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as SyncConfig;
  } catch {
    return { targets: [] };
  }
}

export function saveSyncConfig(cfg: SyncConfig): void {
  ensureDataDir();
  fs.writeFileSync(syncConfigPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

export function addTarget(target: SyncTarget): void {
  const cfg = loadSyncConfig();
  const existing = cfg.targets.findIndex((t) => t.name === target.name);
  if (existing >= 0) {
    cfg.targets[existing] = target;
  } else {
    cfg.targets.push(target);
  }
  saveSyncConfig(cfg);
}

export function removeTarget(name: string): boolean {
  const cfg = loadSyncConfig();
  const before = cfg.targets.length;
  cfg.targets = cfg.targets.filter((t) => t.name !== name);
  if (cfg.targets.length === before) return false;
  saveSyncConfig(cfg);
  return true;
}

export function listTargets(): SyncTarget[] {
  return loadSyncConfig().targets;
}
