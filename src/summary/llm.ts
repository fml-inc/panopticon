import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../log.js";

const LLM_TIMEOUT_MS = 180_000;

let _claudePath: string | null | undefined;

/**
 * Detect whether the `claude` CLI is available on this machine.
 * Result is cached for the lifetime of the process.
 */
export function detectAgent(): string | null {
  if (_claudePath !== undefined) return _claudePath;
  try {
    _claudePath = execFileSync("which", ["claude"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    _claudePath = null;
  }
  return _claudePath;
}

/**
 * Build a clean env that won't trigger recursive hooks or proxy loops.
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE") continue;
    if (k.startsWith("CLAUDE_CODE_")) continue;
    if (k === "ANTHROPIC_BASE_URL") continue;
    env[k] = v;
  }
  return env;
}

/** Get the path to the panopticon MCP server script. */
function getMcpServerPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // In the built dist/, summary code is in a chunk at dist/ level,
  // and mcp/server.js is at dist/mcp/server.js (same level)
  return path.resolve(dir, "mcp", "server.js");
}

/**
 * Invoke Claude CLI with a prompt and optional MCP server.
 * Returns the trimmed output text, or null on any failure.
 */
export function invokeLlm(
  prompt: string,
  opts: {
    timeoutMs?: number;
    withMcp?: boolean;
    systemPrompt?: string;
    model?: string;
  } = {},
): string | null {
  const claudePath = detectAgent();
  if (!claudePath) return null;

  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;

  const args = [
    claudePath,
    "-p",
    prompt,
    "--output-format",
    "text",
    "--model",
    opts.model ?? "haiku",
    "--no-session-persistence",
    "--permission-mode",
    "auto",
  ];

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  if (opts.withMcp) {
    const mcpPath = getMcpServerPath();
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
      "--allowed-tools",
      "mcp__panopticon__timeline",
      "mcp__panopticon__get",
      "mcp__panopticon__query",
      "mcp__panopticon__search",
      "mcp__panopticon__status",
    );
  } else {
    args.push("--tools", "");
  }

  const result = spawnSync(args[0], args.slice(1), {
    env: cleanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });

  const text = result.stdout?.toString().trim();
  const stderr = result.stderr?.toString().trim();

  if (stderr) log.llm.warn(`stderr: ${stderr.slice(0, 500)}`);
  if (result.signal) {
    log.llm.error(`killed by signal: ${result.signal}`);
    return null;
  }
  log.llm.info(`exit=${result.status} stdout=${text?.length ?? 0} chars`);

  // Accept output even with non-zero exit (hooks may cause exit code 1
  // after successful response)
  return text || null;
}
