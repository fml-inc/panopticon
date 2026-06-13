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

function envNonNegativeInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
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
// Separate from attemptBackoffScheduleMs: daemon start backoff controls local
// process respawn attempts and intentionally does not need fanout jitter.
const DEFAULT_SERVER_START_BACKOFF_SCHEDULE_MS = [
  5_000,
  15_000,
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
] as const;
const DEFAULT_LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_ROTATE_FILES = 5;

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
  serverStartBackoffFile: path.join(DATA_DIR, "server-start-backoff.json"),
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
    true,
  ),
  // Inject bounded recent-history context on SessionStart. Default on;
  // set the env var to a falsy value to disable the injection entirely.
  enableSessionStartHistoryInjection: envBool(
    "PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION",
    true,
  ),
  // Inject prompt-relevant prior-session context on UserPromptSubmit.
  // Default on; disable independently of the SessionStart injection.
  enableUserPromptSubmitContextInjection: envBool(
    "PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION",
    true,
  ),
  // Inject provenanced file context on PreToolUse for Write/Edit/MultiEdit:
  // when Claude is about to edit a file with prior intent/edit history,
  // surface it once per file per session. Default on; disable independently.
  enablePreToolUseFileContextInjection: envBool(
    "PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION",
    true,
  ),
  // Inject read-time file context on PreToolUse for Read. Default on; disable
  // independently when measuring discovery churn or token/noise tradeoffs.
  enablePreToolUseReadContextInjection: envBool(
    "PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION",
    true,
  ),
  // Shadow-only code intelligence enrichment for file_overview. Default off
  // while the code-review-graph integration is being evaluated.
  enableCodeIntelFileOverview: envBool(
    "PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW",
    false,
  ),
  // Agent-to-agent bus delivery: auto-publish hook activity onto the room and
  // drain pending messages into hook additionalContext (Layer 2). Default off;
  // the bus tables and MCP tools work regardless of this flag. Instance presence
  // is always on, independent of this flag.
  enableBusDelivery: envBool("PANOPTICON_ENABLE_BUS_DELIVERY", false),
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
  serverStartBackoffScheduleMs: envIntList(
    "PANOPTICON_SERVER_START_BACKOFF_SCHEDULE_MS",
    DEFAULT_SERVER_START_BACKOFF_SCHEDULE_MS,
  ),
  logRotateBytes: envNonNegativeInt(
    "PANOPTICON_LOG_ROTATE_BYTES",
    DEFAULT_LOG_ROTATE_BYTES,
  ),
  logRotateFiles: envNonNegativeInt(
    "PANOPTICON_LOG_ROTATE_FILES",
    DEFAULT_LOG_ROTATE_FILES,
  ),
} as const;

export function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
