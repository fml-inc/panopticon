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
  /** Whether panopticon hooks are installed (plugin mode). When true, OTLP sync
   *  filters out body types that hooks already cover to avoid double-counting. */
  hooksInstalled?: boolean;
  /** Sentry DSN for error reporting. When set, uncaught exceptions and key
   *  error paths are reported to Sentry. */
  sentryDsn?: string;
  sync: {
    /** Whether remote sync loops should run. Defaults to true. */
    enabled?: boolean;
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
  return {
    sync: { enabled: true, targets: [] },
    retention: { ...DEFAULT_RETENTION },
  };
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
    hooksInstalled: raw.hooksInstalled,
    sentryDsn: raw.sentryDsn,
    sync: { enabled: true, targets: [], ...(raw.sync ?? {}) },
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
  const p = configPath();
  fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

// ── Convenience ──────────────────────────────────────────────────────────────

export function loadRetentionConfig(): RetentionConfig {
  return loadUnifiedConfig().retention;
}
