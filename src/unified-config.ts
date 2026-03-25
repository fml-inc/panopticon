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
const LEGACY_SYNC_FILE = "sync.json";
const LEGACY_SYNC_BACKUP = "sync.json.bak";

function configPath(): string {
  return path.join(config.dataDir, CONFIG_FILE);
}

function legacySyncPath(): string {
  return path.join(config.dataDir, LEGACY_SYNC_FILE);
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
  const p = configPath();

  // 1. config.json exists → read + merge defaults
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      return mergeDefaults(raw);
    } catch {
      return defaultConfig();
    }
  }

  // 2. Migrate from legacy sync.json
  const legacy = legacySyncPath();
  if (fs.existsSync(legacy)) {
    try {
      const raw = JSON.parse(fs.readFileSync(legacy, "utf-8"));
      const cfg: UnifiedConfig = {
        sync: {
          targets: raw.targets ?? [],
          filter: raw.filter,
        },
        retention: { ...DEFAULT_RETENTION },
      };
      saveUnifiedConfig(cfg);
      fs.renameSync(legacy, path.join(config.dataDir, LEGACY_SYNC_BACKUP));
      return cfg;
    } catch {
      return defaultConfig();
    }
  }

  // 3. Nothing on disk
  return defaultConfig();
}

export function saveUnifiedConfig(cfg: UnifiedConfig): void {
  ensureDataDir();
  fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

// ── Convenience ──────────────────────────────────────────────────────────────

export function loadRetentionConfig(): RetentionConfig {
  return loadUnifiedConfig().retention;
}
