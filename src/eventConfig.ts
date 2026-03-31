/**
 * Per-event logging configuration.
 *
 * Separated from config.ts to avoid circular imports:
 * config.ts → targets/types.ts → hooks/ingest.ts → config.ts
 */

import fs from "node:fs";
import path from "node:path";
import { config, ensureDataDir } from "./config.js";
import { ALL_EVENTS, type CanonicalEvent } from "./targets/types.js";

export type EventConfig = Record<CanonicalEvent, boolean>;

const EVENT_CONFIG_PATH = path.join(config.dataDir, "event-config.json");

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
