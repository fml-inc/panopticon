import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { WorkspaceProvider } from "./types.js";

const SUPERSET_MARKER = `${path.sep}.superset${path.sep}`;
const SUPERSET_DB_PATH = path.join(os.homedir(), ".superset", "local.db");

interface WorktreeRow {
  main_repo_path: string;
  branch: string | null;
}

export class SupersetProvider implements WorkspaceProvider {
  readonly id = "superset";

  private db: Database.Database | null = null;
  private dbFailed = false;

  canResolve(cwd: string): boolean {
    return cwd.includes(SUPERSET_MARKER);
  }

  resolve(cwd: string): { repoDir: string; branch?: string | null } | null {
    const db = this.getDb();
    if (!db) return null;

    try {
      // Try worktrees table first (for ~/.superset/worktrees/ paths)
      const wt = db
        .prepare(
          `SELECT p.main_repo_path, w.branch
           FROM worktrees w
           JOIN projects p ON w.project_id = p.id
           WHERE ? LIKE w.path || '%'
           ORDER BY LENGTH(w.path) DESC
           LIMIT 1`,
        )
        .get(cwd) as WorktreeRow | undefined;
      if (wt) return { repoDir: wt.main_repo_path, branch: wt.branch };

      // Fall back to projects table (for ~/.superset/projects/ paths)
      const proj = db
        .prepare(
          `SELECT main_repo_path, default_branch AS branch
           FROM projects
           WHERE ? LIKE main_repo_path || '%'
           ORDER BY LENGTH(main_repo_path) DESC
           LIMIT 1`,
        )
        .get(cwd) as WorktreeRow | undefined;
      if (proj) return { repoDir: proj.main_repo_path, branch: proj.branch };
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

  private getDb(): Database.Database | null {
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
