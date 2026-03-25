import { loadUnifiedConfig, saveUnifiedConfig } from "../unified-config.js";
import type { SyncFilter, SyncTarget } from "./types.js";

export interface SyncConfig {
  targets: SyncTarget[];
  filter?: SyncFilter;
}

export function loadSyncConfig(): SyncConfig {
  const cfg = loadUnifiedConfig();
  return { targets: cfg.sync.targets, filter: cfg.sync.filter };
}

export function saveSyncConfig(syncCfg: SyncConfig): void {
  const cfg = loadUnifiedConfig();
  cfg.sync.targets = syncCfg.targets;
  cfg.sync.filter = syncCfg.filter;
  saveUnifiedConfig(cfg);
}

export function addTarget(target: SyncTarget): void {
  const cfg = loadUnifiedConfig();
  const existing = cfg.sync.targets.findIndex((t) => t.name === target.name);
  if (existing >= 0) {
    cfg.sync.targets[existing] = target;
  } else {
    cfg.sync.targets.push(target);
  }
  saveUnifiedConfig(cfg);
}

export function removeTarget(name: string): boolean {
  const cfg = loadUnifiedConfig();
  const before = cfg.sync.targets.length;
  cfg.sync.targets = cfg.sync.targets.filter((t) => t.name !== name);
  if (cfg.sync.targets.length === before) return false;
  saveUnifiedConfig(cfg);
  return true;
}

export function listTargets(): SyncTarget[] {
  return loadUnifiedConfig().sync.targets;
}
