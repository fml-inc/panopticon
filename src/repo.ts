import { execFileSync } from "node:child_process";

// Cache: cwd → "org/repo" | null
const repoCache = new Map<string, string | null>();

/**
 * Resolve the GitHub "org/repo" for a working directory by inspecting the
 * git remote origin URL.  Results are cached for the lifetime of the process.
 */
export function resolveRepoFromCwd(cwd: string): string | null {
  if (repoCache.has(cwd)) return repoCache.get(cwd)!;

  let repo: string | null = null;
  try {
    const url = execFileSync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    // SSH: git@github.com:org/repo.git
    const sshMatch = url.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) {
      repo = sshMatch[1];
    } else {
      // HTTPS: https://github.com/org/repo.git
      const httpsMatch = url.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
      if (httpsMatch) {
        repo = httpsMatch[1];
      }
    }
  } catch {
    // Not a git repo, no remote, etc.
  }

  repoCache.set(cwd, repo);
  return repo;
}
