import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Repo-scoped file identity uses a canonical write form:
// repo-relative when a repository root is known, absolute otherwise.
// Read paths that need a local file should resolve that canonical form back to
// an absolute path with resolveCanonicalFilePath().

export type ObservedPathStyle = "windows" | "posix";

export function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function detectObservedPathStyle(
  value: string,
): ObservedPathStyle | null {
  if (!value) return null;
  if (looksLikeWindowsPath(value)) return "windows";
  if (path.posix.isAbsolute(value)) return "posix";
  return null;
}

export function isObservedAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value)
  );
}

export function dirnameOfObservedPath(value: string): string {
  const style = detectObservedPathStyle(value);
  if (style === "windows") return path.win32.dirname(value);
  if (style === "posix") return path.posix.dirname(value);
  return path.dirname(value);
}

export function canUseLocalPathApis(value: string): boolean {
  const style = detectObservedPathStyle(value);
  if (!style) return true;
  if (process.platform === "win32") return style === "windows";
  return style === "posix";
}

// Caches indefinitely; daemon restart clears.
const gitRootCache = new Map<string, string | null>();

export function resolveFilePathFromCwd(
  filePath: string,
  cwd: string | null,
): string {
  if (!cwd || filePath.length === 0 || isObservedAbsolutePath(filePath)) {
    return filePath;
  }
  const cwdStyle = detectObservedPathStyle(cwd);
  if (cwdStyle === "windows") {
    return path.win32.resolve(cwd, filePath);
  }
  if (cwdStyle === "posix") {
    return path.posix.resolve(cwd, filePath);
  }
  return path.resolve(cwd, filePath);
}

export function resolveGitRoot(cwd: string): string | null {
  if (!cwd || !isObservedAbsolutePath(cwd) || !canUseLocalPathApis(cwd)) {
    return null;
  }
  const cached = gitRootCache.get(cwd);
  if (cached !== undefined) return cached;

  let root: string | null = null;
  try {
    root =
      execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim() || null;
  } catch {
    root = null;
  }
  gitRootCache.set(cwd, root);
  return root;
}

function relativePathWithinObservedRoot(
  filePath: string,
  root: string,
): string | null {
  if (!root || !isObservedAbsolutePath(root)) return null;
  const rootStyle = detectObservedPathStyle(root);
  if (!rootStyle) return null;

  const resolved = resolveFilePathFromCwd(filePath, root);
  if (!isObservedAbsolutePath(resolved)) return null;

  let rootForCompare = root;
  let resolvedForCompare = resolved;
  if (canUseLocalPathApis(root) && canUseLocalPathApis(resolved)) {
    try {
      rootForCompare = fs.realpathSync.native(root);
    } catch {}
    try {
      resolvedForCompare = fs.realpathSync.native(resolved);
    } catch {}
  }

  const pathApi = rootStyle === "windows" ? path.win32 : path.posix;
  const relative = pathApi.relative(rootForCompare, resolvedForCompare);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    return null;
  }

  return relative.replace(/\\/g, "/");
}

export function resolveRepositoryRootForPath(opts: {
  filePath: string;
  cwd?: string | null;
  repositoryRoot?: string | null;
  allowNonGitRepositoryRoot?: boolean;
}): string | null {
  if (opts.repositoryRoot && isObservedAbsolutePath(opts.repositoryRoot)) {
    if (opts.allowNonGitRepositoryRoot) {
      return opts.repositoryRoot;
    }
    const explicitRoot = resolveGitRoot(opts.repositoryRoot);
    if (explicitRoot) return explicitRoot;
  }

  if (opts.cwd && isObservedAbsolutePath(opts.cwd)) {
    const root = resolveGitRoot(opts.cwd);
    if (root) return root;
  }

  const resolved = resolveFilePathFromCwd(opts.filePath, opts.cwd ?? null);
  if (isObservedAbsolutePath(resolved)) {
    return resolveGitRoot(dirnameOfObservedPath(resolved));
  }

  return null;
}

export function canonicalizeRepoFilePath(
  filePath: string,
  opts?: {
    cwd?: string | null;
    repositoryRoot?: string | null;
    allowNonGitRepositoryRoot?: boolean;
  },
): string {
  const repositoryRoot = resolveRepositoryRootForPath({
    filePath,
    cwd: opts?.cwd ?? null,
    repositoryRoot: opts?.repositoryRoot ?? null,
    allowNonGitRepositoryRoot: opts?.allowNonGitRepositoryRoot ?? false,
  });
  const relative = repositoryRoot
    ? relativePathWithinObservedRoot(filePath, repositoryRoot)
    : null;
  if (relative) return relative;
  return resolveFilePathFromCwd(filePath, opts?.cwd ?? null);
}

export function resolveCanonicalFilePath(
  filePath: string,
  opts?: {
    cwd?: string | null;
    repositoryRoot?: string | null;
  },
): string {
  if (!filePath || isObservedAbsolutePath(filePath)) {
    return filePath;
  }

  const repositoryRoot = resolveRepositoryRootForPath({
    filePath,
    cwd: opts?.cwd ?? null,
    repositoryRoot: opts?.repositoryRoot ?? null,
    allowNonGitRepositoryRoot: true,
  });
  if (repositoryRoot) {
    return resolveFilePathFromCwd(filePath, repositoryRoot);
  }
  return resolveFilePathFromCwd(filePath, opts?.cwd ?? null);
}
