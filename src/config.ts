import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SESSION_SUMMARY_RUNNER_NAMES = ["claude", "codex"] as const;
export type SessionSummaryRunnerName =
  (typeof SESSION_SUMMARY_RUNNER_NAMES)[number];
export const SESSION_SUMMARY_RUNNER_STRATEGIES = [
  "same_as_session",
  "fixed",
] as const;
export type SessionSummaryRunnerStrategy =
  (typeof SESSION_SUMMARY_RUNNER_STRATEGIES)[number];

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

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function envRatio(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : defaultValue;
}

function envIntList(name: string, defaultValue: readonly number[]): number[] {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return [...defaultValue];
  const values = raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? values : [...defaultValue];
}

function parseSessionSummaryRunnerList(
  raw: string | undefined,
  fallback: SessionSummaryRunnerName[],
): SessionSummaryRunnerName[] {
  if (!raw) return fallback;
  const allowed = new Set(SESSION_SUMMARY_RUNNER_NAMES);
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(
      (value): value is SessionSummaryRunnerName =>
        value.length > 0 && allowed.has(value as SessionSummaryRunnerName),
    );
  return values.length > 0 ? [...new Set(values)] : fallback;
}

function parseSessionSummaryRunner(
  raw: string | undefined,
  fallback: SessionSummaryRunnerName,
): SessionSummaryRunnerName {
  const [runner] = parseSessionSummaryRunnerList(raw, []);
  return runner ?? fallback;
}

function parseSessionSummaryRunnerStrategy(
  raw: string | undefined,
): SessionSummaryRunnerStrategy {
  return raw === "fixed" ? "fixed" : "same_as_session";
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
const DEFAULT_SESSION_SUMMARY_ALLOWED_RUNNERS: SessionSummaryRunnerName[] = [
  "claude",
  "codex",
];
const DEFAULT_ATTEMPT_BACKOFF_SCHEDULE_MS = [
  60_000,
  2 * 60_000,
  4 * 60_000,
  8 * 60_000,
  16 * 60_000,
  32 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;
const DEFAULT_ATTEMPT_BACKOFF_JITTER_RATIO = 0.1;
const DEFAULT_SESSION_SUMMARY_ENRICH_CONCURRENCY = 2;

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
  enableSessionSummaryEnrichment: envBool(
    "PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT",
  ),
  sessionSummaryAllowedRunners: parseSessionSummaryRunnerList(
    process.env.PANOPTICON_SESSION_SUMMARY_ALLOWED_RUNNERS,
    DEFAULT_SESSION_SUMMARY_ALLOWED_RUNNERS,
  ),
  sessionSummaryRunnerStrategy: parseSessionSummaryRunnerStrategy(
    process.env.PANOPTICON_SESSION_SUMMARY_RUNNER_STRATEGY,
  ),
  sessionSummaryFixedRunner: parseSessionSummaryRunner(
    process.env.PANOPTICON_SESSION_SUMMARY_FIXED_RUNNER,
    "claude",
  ),
  sessionSummaryFallbackRunners: parseSessionSummaryRunnerList(
    process.env.PANOPTICON_SESSION_SUMMARY_FALLBACK_RUNNERS,
    DEFAULT_SESSION_SUMMARY_ALLOWED_RUNNERS,
  ),
  sessionSummaryRunnerModels: {
    claude: process.env.PANOPTICON_SESSION_SUMMARY_CLAUDE_MODEL ?? "sonnet",
    codex: process.env.PANOPTICON_SESSION_SUMMARY_CODEX_MODEL ?? null,
  },
  sessionSummaryEnrichLimit: envInt(
    "PANOPTICON_SESSION_SUMMARY_ENRICH_LIMIT",
    5,
  ),
  sessionSummaryEnrichConcurrency: envInt(
    "PANOPTICON_SESSION_SUMMARY_ENRICH_CONCURRENCY",
    DEFAULT_SESSION_SUMMARY_ENRICH_CONCURRENCY,
  ),
  sessionSummaryScannerEnrichLimit: envInt(
    "PANOPTICON_SESSION_SUMMARY_SCANNER_ENRICH_LIMIT",
    DEFAULT_SESSION_SUMMARY_ENRICH_CONCURRENCY,
  ),
  sessionSummaryProjectionDebounceMs: envInt(
    "PANOPTICON_SESSION_SUMMARY_PROJECTION_DEBOUNCE_MS",
    30_000,
  ),
  sessionSummaryEnrichTimeoutMs: envInt(
    "PANOPTICON_SESSION_SUMMARY_ENRICH_TIMEOUT_MS",
    90_000,
  ),
  attemptBackoffScheduleMs: envIntList(
    "PANOPTICON_ATTEMPT_BACKOFF_SCHEDULE_MS",
    DEFAULT_ATTEMPT_BACKOFF_SCHEDULE_MS,
  ),
  attemptBackoffJitterRatio: envRatio(
    "PANOPTICON_ATTEMPT_BACKOFF_JITTER_RATIO",
    DEFAULT_ATTEMPT_BACKOFF_JITTER_RATIO,
  ),
} as const;

export function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
