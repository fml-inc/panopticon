import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export interface RepoInfo {
  repo: string;
  branch?: string | null;
}

// Cache: cwd → RepoInfo | null
const repoCache = new Map<string, RepoInfo | null>();

const SUPERSET_MARKER = `${path.sep}.superset${path.sep}`;
const SUPERSET_DB_PATH = path.join(os.homedir(), ".superset", "local.db");

let _supersetDb: Database.Database | null = null;
let _supersetDbFailed = false;

function getSupersetDb(): Database.Database | null {
  if (_supersetDbFailed) return null;
  if (_supersetDb) return _supersetDb;
  try {
    _supersetDb = new Database(SUPERSET_DB_PATH, {
      readonly: true,
      fileMustExist: true,
    });
    return _supersetDb;
  } catch {
    _supersetDbFailed = true;
    return null;
  }
}

interface SupersetWorktreeInfo {
  main_repo_path: string;
  branch: string | null;
}

/**
 * Look up a Superset path in local.db. Checks worktrees first (for
 * ~/.superset/worktrees/ paths), then falls back to projects (for
 * ~/.superset/projects/ paths).
 */
function resolveSupersetWorktree(
  worktreeCwd: string,
): SupersetWorktreeInfo | null {
  const db = getSupersetDb();
  if (!db) return null;
  try {
    // Try worktrees table first (most common case)
    const wt = db
      .prepare(
        `SELECT p.main_repo_path, w.branch
         FROM worktrees w
         JOIN projects p ON w.project_id = p.id
         WHERE ? LIKE w.path || '%'
         ORDER BY LENGTH(w.path) DESC
         LIMIT 1`,
      )
      .get(worktreeCwd) as SupersetWorktreeInfo | undefined;
    if (wt) return wt;

    // Fall back to projects table (for ~/.superset/projects/ paths)
    const proj = db
      .prepare(
        `SELECT main_repo_path, default_branch AS branch
         FROM projects
         WHERE ? LIKE main_repo_path || '%'
         ORDER BY LENGTH(main_repo_path) DESC
         LIMIT 1`,
      )
      .get(worktreeCwd) as SupersetWorktreeInfo | undefined;
    return proj ?? null;
  } catch {
    return null;
  }
}

/** Resolve "org/repo" from a directory's git remote origin URL. */
function resolveGitRemote(dir: string): string | null {
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
 * Falls back to Superset's local DB for worktree paths where the worktree
 * may have been cleaned up but the parent project's repo still exists.
 */
export function resolveRepoFromCwd(cwd: string): RepoInfo | null {
  if (repoCache.has(cwd)) return repoCache.get(cwd)!;

  let result: RepoInfo | null = null;

  const repo = resolveGitRemote(cwd);
  if (repo) {
    result = { repo, branch: resolveGitBranch(cwd) };
  } else if (cwd.includes(SUPERSET_MARKER)) {
    // Fallback: resolve via Superset DB for deleted worktrees
    const wt = resolveSupersetWorktree(cwd);
    if (wt) {
      const fallbackRepo = resolveGitRemote(wt.main_repo_path);
      if (fallbackRepo) {
        result = { repo: fallbackRepo, branch: wt.branch };
      }
    }
  }

  repoCache.set(cwd, result);
  return result;
}

/** Reset caches (for testing). */
export function _resetRepoCache(): void {
  repoCache.clear();
  if (_supersetDb) {
    try {
      _supersetDb.close();
    } catch {}
  }
  _supersetDb = null;
  _supersetDbFailed = false;
}
