import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolve a CLI binary by walking process.env.PATH. On Windows, probe each
 * process.env.PATHEXT extension. Returns an absolute path or null.
 *
 * Pass the bare command name (e.g. "npm", not "npm.cmd"); the extension is
 * applied via PATHEXT on Windows. If the caller does include an extension,
 * it's used as-is.
 *
 * Replaces `which`/`where`: avoids spawning a child process and works the
 * same on macOS, Linux, and Windows.
 */
export function resolveBin(name: string): string | null {
  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const hasExt = path.extname(name) !== "";
  const exts =
    !IS_WIN || hasExt
      ? [""]
      : (process.env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean);

  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

/** True for Windows shell shims that execFile cannot run directly. */
function isWinShim(bin: string): boolean {
  return IS_WIN && /\.(cmd|bat)$/i.test(bin);
}

/**
 * Quote a single argument for safe inclusion in a Windows command line that
 * will be parsed by cmd.exe and then re-parsed by a CRT program.
 *
 * Two layers:
 *   1. CRT (CommandLineToArgvW): wrap in `"`, escape internal `"` as `\"`,
 *      double any backslashes that precede a quote.
 *   2. cmd.exe: escape its metacharacters with `^` so they aren't expanded
 *      before the CRT layer sees them. `%` and `!` (delayed expansion) are
 *      the dangerous ones inside quotes; the rest are safest belt-and-braces.
 */
export function quoteWinArg(arg: string): string {
  if (arg.length === 0) return '""';

  // Fast path: bare-word args that need no quoting at all.
  // Backslash is intentionally excluded so `path\` and similar still go
  // through the trailing-backslash doubling logic below.
  if (/^[A-Za-z0-9@\-_+=:/.,]+$/.test(arg)) return arg;

  // CRT layer: double backslashes before quotes, escape quotes, double trailing backslashes.
  const crt = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  const quoted = `"${crt}"`;

  // cmd.exe layer: escape metacharacters (including the surrounding quotes)
  // so cmd's first pass passes them through verbatim.
  return quoted.replace(/([()%!^<>&|"])/g, "^$1");
}

export interface ExecBinOptions {
  timeout?: number;
  encoding?: BufferEncoding;
  stdio?: "pipe" | "inherit" | "ignore";
}

/**
 * Run a resolved binary path with the given args, handling Windows .cmd/.bat
 * shims correctly. Throws on non-zero exit (matching execFileSync).
 */
export function execBinSync(
  bin: string,
  args: string[],
  opts: ExecBinOptions = {},
): string {
  const { timeout = 10_000, encoding = "utf-8", stdio = "pipe" } = opts;

  if (isWinShim(bin)) {
    // CVE-2024-27980: Node refuses to spawn .cmd/.bat without shell: true.
    // Build the command string ourselves so we control the quoting.
    const command = [bin, ...args].map(quoteWinArg).join(" ");
    return execSync(command, { timeout, encoding, stdio });
  }

  return execFileSync(bin, args, { timeout, encoding, stdio });
}
