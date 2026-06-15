import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENRICHMENT_FLAG =
  process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT;
const ORIGINAL_LOG_ROTATE_BYTES = process.env.PANOPTICON_LOG_ROTATE_BYTES;
const ORIGINAL_LOG_ROTATE_FILES = process.env.PANOPTICON_LOG_ROTATE_FILES;
const ORIGINAL_ENABLE_FRENEMY = process.env.PANOPTICON_ENABLE_FRENEMY;
const ORIGINAL_FRENEMY_RUNNER = process.env.PANOPTICON_FRENEMY_RUNNER;
const ORIGINAL_FRENEMY_MODEL = process.env.PANOPTICON_FRENEMY_MODEL;
const ORIGINAL_FRENEMY_SETTLE_MS = process.env.PANOPTICON_FRENEMY_SETTLE_MS;
const ORIGINAL_SESSION_SUMMARY_CLAUDE_MODEL =
  process.env.PANOPTICON_SESSION_SUMMARY_CLAUDE_MODEL;
const ORIGINAL_SESSION_SUMMARY_CODEX_MODEL =
  process.env.PANOPTICON_SESSION_SUMMARY_CODEX_MODEL;

async function loadConfigWithEnrichmentFlag(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) {
    delete process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT;
  } else {
    process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT = value;
  }
  return (await import("./config.js")).config;
}

async function loadConfigWithLogRotation(opts: {
  bytes?: string;
  files?: string;
}) {
  vi.resetModules();
  if (opts.bytes === undefined) delete process.env.PANOPTICON_LOG_ROTATE_BYTES;
  else process.env.PANOPTICON_LOG_ROTATE_BYTES = opts.bytes;
  if (opts.files === undefined) delete process.env.PANOPTICON_LOG_ROTATE_FILES;
  else process.env.PANOPTICON_LOG_ROTATE_FILES = opts.files;
  return (await import("./config.js")).config;
}

async function loadConfigWithFrenemyEnv(opts: {
  enabled?: string;
  runner?: string;
  model?: string;
  settleMs?: string;
  summaryClaudeModel?: string;
  summaryCodexModel?: string;
}) {
  vi.resetModules();
  if (opts.enabled === undefined) delete process.env.PANOPTICON_ENABLE_FRENEMY;
  else process.env.PANOPTICON_ENABLE_FRENEMY = opts.enabled;
  if (opts.runner === undefined) delete process.env.PANOPTICON_FRENEMY_RUNNER;
  else process.env.PANOPTICON_FRENEMY_RUNNER = opts.runner;
  if (opts.model === undefined) delete process.env.PANOPTICON_FRENEMY_MODEL;
  else process.env.PANOPTICON_FRENEMY_MODEL = opts.model;
  if (opts.settleMs === undefined)
    delete process.env.PANOPTICON_FRENEMY_SETTLE_MS;
  else process.env.PANOPTICON_FRENEMY_SETTLE_MS = opts.settleMs;
  if (opts.summaryClaudeModel === undefined) {
    delete process.env.PANOPTICON_SESSION_SUMMARY_CLAUDE_MODEL;
  } else {
    process.env.PANOPTICON_SESSION_SUMMARY_CLAUDE_MODEL =
      opts.summaryClaudeModel;
  }
  if (opts.summaryCodexModel === undefined) {
    delete process.env.PANOPTICON_SESSION_SUMMARY_CODEX_MODEL;
  } else {
    process.env.PANOPTICON_SESSION_SUMMARY_CODEX_MODEL = opts.summaryCodexModel;
  }
  return (await import("./config.js")).config;
}

describe("config", () => {
  afterEach(() => {
    vi.resetModules();
    if (ORIGINAL_ENRICHMENT_FLAG === undefined) {
      delete process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT;
    } else {
      process.env.PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT =
        ORIGINAL_ENRICHMENT_FLAG;
    }
    if (ORIGINAL_LOG_ROTATE_BYTES === undefined) {
      delete process.env.PANOPTICON_LOG_ROTATE_BYTES;
    } else {
      process.env.PANOPTICON_LOG_ROTATE_BYTES = ORIGINAL_LOG_ROTATE_BYTES;
    }
    if (ORIGINAL_LOG_ROTATE_FILES === undefined) {
      delete process.env.PANOPTICON_LOG_ROTATE_FILES;
    } else {
      process.env.PANOPTICON_LOG_ROTATE_FILES = ORIGINAL_LOG_ROTATE_FILES;
    }
    if (ORIGINAL_ENABLE_FRENEMY === undefined) {
      delete process.env.PANOPTICON_ENABLE_FRENEMY;
    } else {
      process.env.PANOPTICON_ENABLE_FRENEMY = ORIGINAL_ENABLE_FRENEMY;
    }
    if (ORIGINAL_FRENEMY_RUNNER === undefined) {
      delete process.env.PANOPTICON_FRENEMY_RUNNER;
    } else {
      process.env.PANOPTICON_FRENEMY_RUNNER = ORIGINAL_FRENEMY_RUNNER;
    }
    if (ORIGINAL_FRENEMY_MODEL === undefined) {
      delete process.env.PANOPTICON_FRENEMY_MODEL;
    } else {
      process.env.PANOPTICON_FRENEMY_MODEL = ORIGINAL_FRENEMY_MODEL;
    }
    if (ORIGINAL_FRENEMY_SETTLE_MS === undefined) {
      delete process.env.PANOPTICON_FRENEMY_SETTLE_MS;
    } else {
      process.env.PANOPTICON_FRENEMY_SETTLE_MS = ORIGINAL_FRENEMY_SETTLE_MS;
    }
    if (ORIGINAL_SESSION_SUMMARY_CLAUDE_MODEL === undefined) {
      delete process.env.PANOPTICON_SESSION_SUMMARY_CLAUDE_MODEL;
    } else {
      process.env.PANOPTICON_SESSION_SUMMARY_CLAUDE_MODEL =
        ORIGINAL_SESSION_SUMMARY_CLAUDE_MODEL;
    }
    if (ORIGINAL_SESSION_SUMMARY_CODEX_MODEL === undefined) {
      delete process.env.PANOPTICON_SESSION_SUMMARY_CODEX_MODEL;
    } else {
      process.env.PANOPTICON_SESSION_SUMMARY_CODEX_MODEL =
        ORIGINAL_SESSION_SUMMARY_CODEX_MODEL;
    }
  });

  it("enables session summary enrichment by default", async () => {
    const config = await loadConfigWithEnrichmentFlag(undefined);

    expect(config.enableSessionSummaryEnrichment).toBe(true);
  });

  it("allows session summary enrichment to be disabled explicitly", async () => {
    const config = await loadConfigWithEnrichmentFlag("0");

    expect(config.enableSessionSummaryEnrichment).toBe(false);
  });

  it("allows log rotation to be disabled with zero values", async () => {
    const config = await loadConfigWithLogRotation({ bytes: "0", files: "0" });

    expect(config.logRotateBytes).toBe(0);
    expect(config.logRotateFiles).toBe(0);
  });

  it("keeps daemon frenemy disabled by default", async () => {
    const config = await loadConfigWithFrenemyEnv({});

    expect(config.enableFrenemy).toBe(false);
    expect(config.frenemyRunner).toBe("claude");
    expect(config.frenemyModel).toBeNull();
  });

  it("parses daemon frenemy settings from env", async () => {
    const config = await loadConfigWithFrenemyEnv({
      enabled: "1",
      runner: "codex",
      model: "opus",
      settleMs: "8000",
    });

    expect(config.enableFrenemy).toBe(true);
    expect(config.frenemyRunner).toBe("codex");
    expect(config.frenemyModel).toBe("opus");
    expect(config.frenemySettleMs).toBe(8000);
  });

  it("lets daemon frenemy inherit an explicit Claude enrichment model", async () => {
    const config = await loadConfigWithFrenemyEnv({
      runner: "claude",
      summaryClaudeModel: "sonnet",
    });

    expect(config.sessionSummaryRunnerModels.claude).toBe("sonnet");
    expect(config.frenemyRunner).toBe("claude");
    expect(config.frenemyModel).toBe("sonnet");
  });

  it("lets daemon frenemy inherit an explicit Codex enrichment model", async () => {
    const config = await loadConfigWithFrenemyEnv({
      runner: "codex",
      summaryCodexModel: "gpt-5-codex",
    });

    expect(config.sessionSummaryRunnerModels.codex).toBe("gpt-5-codex");
    expect(config.frenemyRunner).toBe("codex");
    expect(config.frenemyModel).toBe("gpt-5-codex");
  });

  it("keeps the frenemy model override ahead of shared enrichment config", async () => {
    const config = await loadConfigWithFrenemyEnv({
      runner: "claude",
      model: "opus",
      summaryClaudeModel: "sonnet",
    });

    expect(config.frenemyModel).toBe("opus");
  });
});
