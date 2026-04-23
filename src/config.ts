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
  return defaultDataDir();
}

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

const DATA_DIR = resolveDataDir();

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const MARKETPLACE_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "claude-plugins",
);

const DEFAULT_PORT_BASE = 4318;

// Offset the default port by the user's uid so two users on the same host
// don't collide on the OTLP/HTTP standard port. PANOPTICON_PORT overrides.
// Mirrored in src/sdk.ts (kept dependency-free, hence the duplication).
function defaultPort(): number {
  const uidOffset = (process.getuid?.() ?? 0) % 100;
  return DEFAULT_PORT_BASE + uidOffset;
}

export const config = {
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, "panopticon.db"),
  // Unified server port — replaces separate OTLP and proxy ports
  port: parseInt(
    process.env.PANOPTICON_PORT ??
      process.env.PANOPTICON_OTLP_PORT ??
      String(defaultPort()),
    10,
  ),
  host: process.env.PANOPTICON_HOST ?? "127.0.0.1",
  serverPidFile: path.join(DATA_DIR, "panopticon.pid"),
  scannerStatusFile: path.join(DATA_DIR, "scanner-status.json"),
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
  enableSessionSummaryProjections: envBool(
    "PANOPTICON_ENABLE_SESSION_SUMMARY_PROJECTIONS",
  ),
  useProjectionSessionSummaryText: envBool(
    "PANOPTICON_USE_PROJECTION_SESSION_SUMMARY_TEXT",
  ),
} as const;

export function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
