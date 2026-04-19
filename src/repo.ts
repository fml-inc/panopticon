import { execFileSync } from "node:child_process";
import { canUseLocalPathApis } from "./paths.js";
import { SupersetProvider } from "./workspaces/superset.js";
import type { WorkspaceProvider } from "./workspaces/types.js";

export interface RepoInfo {
  repo: string;
  branch?: string | null;
}

// Cache: cwd → RepoInfo | null
const repoCache = new Map<string, RepoInfo | null>();

// Registered workspace providers — checked in order when git fails.
const providers: WorkspaceProvider[] = [new SupersetProvider()];

/** Resolve "org/repo" from a directory's git remote origin URL. */
function resolveGitRemote(dir: string): string | null {
  if (!canUseLocalPathApis(dir)) return null;
  try {
    const url = execFileSync(
      "git",
      ["-C", dir, "remote", "get-url", "origin"],
      {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    // SSH: git@github.com:org/repo.git
    const sshMatch = url.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    // HTTPS: https://github.com/org/repo.git
    const httpsMatch = url.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
  } catch {
    // Not a git repo, no remote, etc.
  }
  return null;
}

/** Resolve the current git branch for a directory. */
function resolveGitBranch(dir: string): string | null {
  if (!canUseLocalPathApis(dir)) return null;
  try {
    return (
      execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * Resolve the GitHub "org/repo" and branch for a working directory.
 * Results are cached for the lifetime of the process.
 *
 * 1. Try git directly on the CWD
 * 2. On failure, ask registered workspace providers (e.g. Superset)
 *    for an alternative repo directory to resolve against
 */
export function resolveRepoFromCwd(cwd: string): RepoInfo | null {
  if (repoCache.has(cwd)) return repoCache.get(cwd)!;

  let result: RepoInfo | null = null;

  const repo = resolveGitRemote(cwd);
  if (repo) {
    result = { repo, branch: resolveGitBranch(cwd) };
  } else {
    // Ask workspace providers for a fallback
    for (const provider of providers) {
      if (!provider.canResolve(cwd)) continue;
      const resolved = provider.resolve(cwd);
      if (!resolved) continue;

      // Provider returned repo name directly (no git needed)
      if (resolved.repo) {
        result = { repo: resolved.repo, branch: resolved.branch };
        break;
      }

      // Provider returned a directory to resolve via git
      if (resolved.repoDir) {
        const fallbackRepo = resolveGitRemote(resolved.repoDir);
        if (fallbackRepo) {
          result = { repo: fallbackRepo, branch: resolved.branch };
          break;
        }
      }
    }
  }

  repoCache.set(cwd, result);
  return result;
}

// Cache: cwd → git identity
const gitIdentityCache = new Map<
  string,
  { name: string | null; email: string | null }
>();

/** Resolve git user.name / user.email for a directory. Cached per-process. */
export function resolveGitIdentity(cwd: string): {
  name: string | null;
  email: string | null;
} {
  const cached = gitIdentityCache.get(cwd);
  if (cached) return cached;

  const result = { name: null as string | null, email: null as string | null };
  if (!canUseLocalPathApis(cwd)) {
    gitIdentityCache.set(cwd, result);
    return result;
  }
  try {
    result.name =
      execFileSync("git", ["-C", cwd, "config", "user.name"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    // no user.name configured
  }
  try {
    result.email =
      execFileSync("git", ["-C", cwd, "config", "user.email"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    // no user.email configured
  }
  gitIdentityCache.set(cwd, result);
  return result;
}

/** Reset caches (for testing). */
export function _resetRepoCache(): void {
  repoCache.clear();
  gitIdentityCache.clear();
  for (const p of providers) p.close?.();
}
