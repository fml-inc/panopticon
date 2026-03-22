import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR =
  process.env.PANOPTICON_DATA_DIR ??
  path.join(os.homedir(), ".local", "share", "panopticon");

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const GEMINI_DIR = path.join(os.homedir(), ".gemini");
const MARKETPLACE_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "claude-plugins",
);

export const config = {
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, "data.db"),
  pidFile: path.join(DATA_DIR, "otlp-receiver.pid"),
  otlpPort: parseInt(process.env.PANOPTICON_OTLP_PORT ?? "4318", 10),
  otlpHost: process.env.PANOPTICON_OTLP_HOST ?? "0.0.0.0",
  claudeDir: CLAUDE_DIR,
  claudeSettingsPath: path.join(CLAUDE_DIR, "settings.json"),
  geminiDir: GEMINI_DIR,
  geminiSettingsPath: path.join(GEMINI_DIR, "settings.json"),
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
  autoMaxSizeMb: 1000,
  autoMaxAgeDays: 90,
} as const;

export function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
