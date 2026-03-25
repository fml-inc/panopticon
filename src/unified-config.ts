import fs from "node:fs";
import path from "node:path";
import { config, ensureDataDir } from "./config.js";
import type { SyncFilter, SyncTarget } from "./sync/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RetentionConfig {
  maxAgeDays: number;
  maxSizeMb: number;
  /** Delete synced rows older than this many days. Undefined = disabled. */
  syncedMaxAgeDays?: number;
}

export interface UnifiedConfig {
  sync: {
    targets: SyncTarget[];
    filter?: SyncFilter;
  };
  retention: RetentionConfig;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_RETENTION: RetentionConfig = {
  maxAgeDays: 90,
  maxSizeMb: 1000,
};

function defaultConfig(): UnifiedConfig {
  return { sync: { targets: [] }, retention: { ...DEFAULT_RETENTION } };
}

// ── Paths ────────────────────────────────────────────────────────────────────

const CONFIG_FILE = "config.json";

function configPath(): string {
  return path.join(config.dataDir, CONFIG_FILE);
}

// ── Load / Save ──────────────────────────────────────────────────────────────

function mergeDefaults(raw: Partial<UnifiedConfig>): UnifiedConfig {
  const retention: RetentionConfig = {
    ...DEFAULT_RETENTION,
    ...(raw.retention ?? {}),
  };
  return {
    sync: raw.sync ?? { targets: [] },
    retention,
  };
}

export function loadUnifiedConfig(): UnifiedConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    return mergeDefaults(raw);
  } catch {
    return defaultConfig();
  }
}

export function saveUnifiedConfig(cfg: UnifiedConfig): void {
  ensureDataDir();
  fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

// ── Convenience ──────────────────────────────────────────────────────────────

export function loadRetentionConfig(): RetentionConfig {
  return loadUnifiedConfig().retention;
}
