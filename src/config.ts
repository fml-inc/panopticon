import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "panopticon",
      );
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "panopticon",
      );
    default:
      return path.join(os.homedir(), ".local", "share", "panopticon");
  }
}

function resolveDataDir(): string {
  if (process.env.PANOPTICON_DATA_DIR) return process.env.PANOPTICON_DATA_DIR;

  const dataDir = defaultDataDir();
  const legacyDir = path.join(os.homedir(), ".local", "share", "panopticon");

  // Migrate from legacy XDG path on non-Linux platforms
  if (
    dataDir !== legacyDir &&
    fs.existsSync(path.join(legacyDir, "data.db")) &&
    !fs.existsSync(path.join(dataDir, "data.db"))
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    for (const file of fs.readdirSync(legacyDir)) {
      fs.renameSync(path.join(legacyDir, file), path.join(dataDir, file));
    }
    try {
      fs.rmdirSync(legacyDir);
    } catch {}
  }

  return dataDir;
}

const DATA_DIR = resolveDataDir();

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const MARKETPLACE_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "claude-plugins",
);

const DEFAULT_PORT = 4318;

export const config = {
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, "data.db"),
  // Unified server port — replaces separate OTLP and proxy ports
  port: parseInt(
    process.env.PANOPTICON_PORT ??
      process.env.PANOPTICON_OTLP_PORT ??
      String(DEFAULT_PORT),
    10,
  ),
  host: process.env.PANOPTICON_HOST ?? "127.0.0.1",
  serverPidFile: path.join(DATA_DIR, "panopticon.pid"),
  // Legacy — kept for backward compat during transition
  pidFile: path.join(DATA_DIR, "otlp-receiver.pid"),
  otlpPort: parseInt(process.env.PANOPTICON_OTLP_PORT ?? "4318", 10),
  otlpHost: process.env.PANOPTICON_OTLP_HOST ?? "0.0.0.0",
  marketplaceDir: MARKETPLACE_DIR,
  marketplaceManifest: path.join(
    MARKETPLACE_DIR,
    ".claude-plugin",
    "marketplace.json",
  ),
  pluginCacheDir: path.join(
    CLAUDE_DIR,
    "plugins",
    "cache",
    "local-plugins",
    "panopticon",
  ),
  proxyPort: parseInt(process.env.PANOPTICON_PROXY_PORT ?? "4320", 10),
  proxyHost: process.env.PANOPTICON_PROXY_HOST ?? "127.0.0.1",
  proxyPidFile: path.join(DATA_DIR, "proxy.pid"),
  proxyIdleSessionMs: 30 * 60 * 1000,
} as const;

export function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

// ── Event logging config ────────────────────────────────────────────────────

import { ALL_EVENTS, type CanonicalEvent } from "./targets/types.js";

export type EventConfig = Record<CanonicalEvent, boolean>;

const EVENT_CONFIG_PATH = path.join(DATA_DIR, "event-config.json");

/** Cached config — null means not yet loaded. */
let cachedEventConfig: EventConfig | null = null;

function defaultEventConfig(): EventConfig {
  const cfg = {} as EventConfig;
  for (const e of ALL_EVENTS) cfg[e] = true;
  return cfg;
}

/**
 * Load event logging config from disk.
 * Missing keys default to true (enabled).
 */
export function loadEventConfig(): EventConfig {
  if (cachedEventConfig) return cachedEventConfig;

  const defaults = defaultEventConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(EVENT_CONFIG_PATH, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const key of Object.keys(raw)) {
        if (key in defaults && typeof raw[key] === "boolean") {
          defaults[key as CanonicalEvent] = raw[key];
        }
      }
    }
  } catch {
    // File doesn't exist or is invalid — use all-enabled defaults.
  }
  cachedEventConfig = defaults;
  return cachedEventConfig;
}

/** Write event config to disk and refresh cache. */
export function saveEventConfig(cfg: EventConfig): void {
  ensureDataDir();
  fs.writeFileSync(EVENT_CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  cachedEventConfig = cfg;
}

/** Check whether a specific event type should be logged. */
export function isEventEnabled(eventType: string): boolean {
  const cfg = loadEventConfig();
  // Unknown event types (e.g. from other targets) are always logged.
  if (!(eventType in cfg)) return true;
  return cfg[eventType as CanonicalEvent];
}

/** Force re-read from disk on next access. */
export function _resetEventConfigCache(): void {
  cachedEventConfig = null;
}
