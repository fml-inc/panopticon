import os from "node:os";
import path from "node:path";
import { Database } from "../db/driver.js";
import type { WorkspaceProvider } from "./types.js";

const SUPERSET_MARKER = `${path.sep}.superset${path.sep}`;
const SUPERSET_DB_PATH = path.join(os.homedir(), ".superset", "local.db");

interface WorktreeRow {
  main_repo_path: string;
  branch: string | null;
  github_owner: string | null;
  project_name: string;
}

export class SupersetProvider implements WorkspaceProvider {
  readonly id = "superset";

  private db: Database | null = null;
  private dbFailed = false;

  canResolve(cwd: string): boolean {
    return cwd.includes(SUPERSET_MARKER);
  }

  resolve(
    cwd: string,
  ): { repo?: string; repoDir?: string; branch?: string | null } | null {
    const db = this.getDb();
    if (!db) return null;

    try {
      // Try worktrees table first (for ~/.superset/worktrees/ paths)
      const wt = db
        .prepare(
          `SELECT p.main_repo_path, w.branch, p.github_owner, p.name as project_name
           FROM worktrees w
           JOIN projects p ON w.project_id = p.id
           WHERE ? LIKE w.path || '%'
           ORDER BY LENGTH(w.path) DESC
           LIMIT 1`,
        )
        .get(cwd) as WorktreeRow | undefined;
      if (wt) return this.buildResult(wt);

      // Fall back to projects table (for ~/.superset/projects/ paths)
      const proj = db
        .prepare(
          `SELECT main_repo_path, default_branch AS branch, github_owner, name as project_name
           FROM projects
           WHERE ? LIKE main_repo_path || '%'
           ORDER BY LENGTH(main_repo_path) DESC
           LIMIT 1`,
        )
        .get(cwd) as WorktreeRow | undefined;
      if (proj) return this.buildResult(proj);
    } catch {
      // Schema mismatch, corrupt DB, etc.
    }

    return null;
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
    this.dbFailed = false;
  }

  private buildResult(row: WorktreeRow): {
    repo?: string;
    repoDir?: string;
    branch?: string | null;
  } {
    // Prefer deriving repo name directly from Superset DB (no git needed)
    if (row.github_owner) {
      return {
        repo: `${row.github_owner}/${row.project_name}`,
        branch: row.branch,
      };
    }
    // Fall back to git resolution on the main repo path
    return { repoDir: row.main_repo_path, branch: row.branch };
  }

  private getDb(): Database | null {
    if (this.dbFailed) return null;
    if (this.db) return this.db;
    try {
      this.db = new Database(SUPERSET_DB_PATH, {
        readonly: true,
        fileMustExist: true,
      });
      return this.db;
    } catch {
      this.dbFailed = true;
      return null;
    }
  }
}
