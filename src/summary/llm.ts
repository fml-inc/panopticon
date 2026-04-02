import { execFileSync, spawnSync } from "node:child_process";

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
 * Pattern borrowed from PR #12's /api/v2/analyze endpoint.
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

/**
 * Invoke Claude CLI with a prompt and return the text output.
 * Uses spawnSync via sh -c (PR #12 pattern) to avoid Node.js IPC channel inheritance.
 * Returns the trimmed output text, or null on any failure.
 */
export function invokeLlm(
  prompt: string,
  timeoutMs = LLM_TIMEOUT_MS,
): string | null {
  const claudePath = detectAgent();
  if (!claudePath) return null;

  const args = [
    claudePath,
    "-p",
    prompt,
    "--output-format",
    "text",
    "--model",
    "haiku",
    "--bare",
    "--no-session-persistence",
    "--tools",
    "",
  ];

  // Shell-escape each arg with single quotes (PR #12 pattern)
  const shellCmd = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");

  const result = spawnSync("sh", ["-c", shellCmd], {
    env: cleanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });

  if (result.status !== 0 || result.signal) return null;

  const text = result.stdout?.toString().trim();
  return text || null;
}
