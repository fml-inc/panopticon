import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionSummaryRunnerName } from "../config.js";
import { config } from "../config.js";
import { log } from "../log.js";

const LLM_TIMEOUT_MS = 180_000;
const DEFAULT_RUNNER: SessionSummaryRunnerName = "claude";
const CLAUDE_HEADLESS_CWD_NAME = "claude-headless";
const CODEX_HEADLESS_CWD_NAME = "codex-headless";
const CODEX_OUTPUT_FILE_PREFIX = "last-message";
const MCP_ALLOWED_TOOLS = [
  "mcp__panopticon__timeline",
  "mcp__panopticon__get",
  "mcp__panopticon__query",
  "mcp__panopticon__search",
  "mcp__panopticon__status",
] as const;

const _agentPaths = new Map<SessionSummaryRunnerName, string | null>();

/**
 * Detect whether the requested CLI is available on this machine.
 * Result is cached for the lifetime of the process, so installing or removing
 * a runner mid-process requires a restart before detection changes.
 */
export function detectAgent(
  runner: SessionSummaryRunnerName = DEFAULT_RUNNER,
): string | null {
  const cached = _agentPaths.get(runner);
  if (cached !== undefined) return cached;
  try {
    const binary = runner === "codex" ? "codex" : "claude";
    const detected = execFileSync("which", [binary], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    _agentPaths.set(runner, detected);
  } catch {
    _agentPaths.set(runner, null);
  }
  return _agentPaths.get(runner) ?? null;
}

/**
 * Build a clean env that won't trigger recursive hooks or proxy loops.
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE") continue;
    if (k === "ANTHROPIC_BASE_URL" && shouldStripAnthropicBaseUrl(v)) continue;
    env[k] = v;
  }
  return env;
}

function shouldStripAnthropicBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      return false;
    }
    return url.pathname === "/proxy/anthropic";
  } catch {
    return false;
  }
}

function shouldUseBareMode(env: Record<string, string>): boolean {
  return (
    !!env.ANTHROPIC_API_KEY ||
    !!env.CLAUDE_CODE_USE_BEDROCK ||
    !!env.CLAUDE_CODE_USE_VERTEX ||
    !!env.CLAUDE_CODE_USE_FOUNDRY
  );
}

function getHeadlessCwd(runner: SessionSummaryRunnerName): string {
  const dir = path.join(
    config.dataDir,
    runner === "codex" ? CODEX_HEADLESS_CWD_NAME : CLAUDE_HEADLESS_CWD_NAME,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCodexOutputPath(cwd: string): string {
  return path.join(
    cwd,
    `${CODEX_OUTPUT_FILE_PREFIX}-${process.pid}-${Date.now()}-${randomUUID()}.txt`,
  );
}

function removeCodexOutputFile(outputPath: string, phase: string): void {
  try {
    fs.rmSync(outputPath, { force: true });
  } catch (error) {
    log.llm.debug(
      `runner=codex failed removing ${phase} output-last-message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Get the path to the panopticon MCP server script. */
function getMcpServerPath(): string | null {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "dist", "mcp", "server.js"),
    path.resolve(dir, "..", "..", "dist", "mcp", "server.js"),
    path.resolve(dir, "..", "mcp", "server.js"),
    path.resolve(dir, "mcp", "server.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

type ClaudePrintJson = {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
};

export function parseClaudePrintJson(rawText: string): {
  ok: boolean;
  result: string | null;
  reason: string;
} {
  const text = rawText.trim();
  if (!text) {
    return {
      ok: false,
      result: null,
      reason: "empty stdout",
    };
  }

  let parsed: ClaudePrintJson;
  try {
    parsed = JSON.parse(text) as ClaudePrintJson;
  } catch {
    return {
      ok: false,
      result: null,
      reason: "invalid json",
    };
  }

  if (parsed.type !== "result") {
    return {
      ok: false,
      result: null,
      reason: `unexpected payload type: ${String(parsed.type)}`,
    };
  }

  if (parsed.is_error === true) {
    const message =
      typeof parsed.result === "string" && parsed.result.trim().length > 0
        ? parsed.result.trim()
        : "unknown Claude CLI error";
    return {
      ok: false,
      result: null,
      reason: message,
    };
  }

  if (typeof parsed.result !== "string" || parsed.result.trim().length === 0) {
    return {
      ok: false,
      result: null,
      reason: "missing result text",
    };
  }

  return {
    ok: true,
    result: parsed.result.trim(),
    reason: "ok",
  };
}

/**
 * Invoke a supported CLI with a prompt and optional MCP server.
 * Returns the trimmed output text, or null on any failure.
 */
export function invokeLlm(
  prompt: string,
  opts: {
    runner?: SessionSummaryRunnerName;
    timeoutMs?: number;
    withMcp?: boolean;
    systemPrompt?: string;
    model?: string | null;
  } = {},
): string | null {
  const runner = opts.runner ?? DEFAULT_RUNNER;
  const agentPath = detectAgent(runner);
  if (!agentPath) return null;

  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  const env = cleanEnv();
  const cwd = getHeadlessCwd(runner);

  if (runner === "codex") {
    return invokeCodexLlm(prompt, {
      binaryPath: agentPath,
      cwd,
      env,
      timeoutMs,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
    });
  }

  return invokeClaudeLlm(prompt, {
    binaryPath: agentPath,
    cwd,
    env,
    timeoutMs,
    withMcp: opts.withMcp,
    systemPrompt: opts.systemPrompt,
    model: opts.model,
  });
}

function invokeClaudeLlm(
  prompt: string,
  opts: {
    binaryPath: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    withMcp?: boolean;
    systemPrompt?: string;
    model?: string | null;
  },
): string | null {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    opts.model ?? "haiku",
    "--no-session-persistence",
    "--permission-mode",
    "default",
    "--disable-slash-commands",
    "--setting-sources",
    "user",
    "--tools",
    "",
  ];

  if (shouldUseBareMode(opts.env)) {
    args.push("--bare");
  }

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  if (opts.withMcp) {
    const mcpPath = getMcpServerPath();
    if (!mcpPath) {
      log.llm.warn("panopticon MCP server not found for Claude headless run");
      return null;
    }
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          panopticon: {
            command: "node",
            args: [mcpPath],
          },
        },
      }),
      "--allowedTools",
      MCP_ALLOWED_TOOLS.join(" "),
    );
  }

  const result = spawnSync(opts.binaryPath, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString().trim();

  if (stderr) log.llm.warn(`stderr: ${stderr.slice(0, 500)}`);
  if (result.error) {
    log.llm.error(`spawn failed: ${result.error.message}`);
    return null;
  }
  if (result.signal) {
    log.llm.error(`killed by signal: ${result.signal}`);
    return null;
  }

  const parsed = parseClaudePrintJson(stdout);
  const summary = `runner=claude exit=${result.status} stdout=${stdout.trim().length} chars`;
  if (!parsed.ok) {
    log.llm.warn(`${summary} error=${parsed.reason}`);
    return null;
  }

  if (result.status !== 0) {
    log.llm.warn(
      `${summary} accepted structured success despite non-zero exit`,
    );
  } else {
    log.llm.debug(summary);
  }

  return parsed.result;
}

function invokeCodexLlm(
  prompt: string,
  opts: {
    binaryPath: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    systemPrompt?: string;
    model?: string | null;
  },
): string | null {
  const outputPath = getCodexOutputPath(opts.cwd);
  removeCodexOutputFile(outputPath, "stale");

  const fullPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n${prompt}`
    : prompt;
  const args = [
    "exec",
    fullPrompt,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--output-last-message",
    outputPath,
  ];
  if (opts.model) {
    args.push("--model", opts.model);
  }

  const result = spawnSync(opts.binaryPath, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });

  const stdout = result.stdout?.toString().trim();
  const stderr = result.stderr?.toString().trim();
  if (stderr) log.llm.warn(`stderr: ${stderr.slice(0, 500)}`);
  if (result.error) {
    log.llm.error(`spawn failed: ${result.error.message}`);
    return null;
  }
  if (result.signal) {
    log.llm.error(`killed by signal: ${result.signal}`);
    return null;
  }
  if (result.status !== 0) {
    log.llm.warn(
      `runner=codex exit=${result.status} stdout=${stdout?.length ?? 0} chars`,
    );
    return null;
  }
  if (!fs.existsSync(outputPath)) {
    log.llm.warn("runner=codex missing output-last-message file");
    return null;
  }

  try {
    const text = fs.readFileSync(outputPath, "utf-8").trim();
    if (!text) {
      log.llm.warn("runner=codex empty output-last-message file");
      return null;
    }
    log.llm.debug(
      `runner=codex exit=0 stdout=${stdout?.length ?? 0} chars output=${text.length} chars`,
    );
    return text;
  } catch (error) {
    log.llm.warn(
      `runner=codex failed reading output-last-message: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    removeCodexOutputFile(outputPath, "final");
  }
}
