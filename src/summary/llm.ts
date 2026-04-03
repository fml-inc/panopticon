import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LLM_TIMEOUT_MS = 30_000;

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
  return path.resolve(dir, "..", "mcp", "server.js");
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
    "haiku",
    "--no-session-persistence",
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
      "--allowedTools",
      "mcp__panopticon__timeline,mcp__panopticon__get,mcp__panopticon__query,mcp__panopticon__search,mcp__panopticon__status",
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

  if (result.signal) {
    console.error(`[llm] killed by signal: ${result.signal}`);
    return null;
  }

  // Accept output even with non-zero exit (hooks may cause exit code 1
  // after successful response)
  return text || null;
}
