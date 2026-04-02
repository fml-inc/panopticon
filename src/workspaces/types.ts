/**
 * A workspace provider resolves repository and branch info for CWDs that
 * git alone can't handle — e.g. ephemeral worktrees managed by external
 * tools where the directory may no longer exist at scan time.
 */
export interface WorkspaceProvider {
  /** Short identifier for logging/debugging. */
  readonly id: string;

  /** Fast check — does this provider handle paths like `cwd`? */
  canResolve(cwd: string): boolean;

  /**
   * Resolve repo info for the given CWD.
   *
   * Can return either:
   * - `repo`: the GitHub "org/repo" name directly (preferred, no git needed)
   * - `repoDir`: a directory to run git against (fallback)
   */
  resolve(cwd: string): {
    repo?: string;
    repoDir?: string;
    branch?: string | null;
  } | null;

  /** Clean up resources (DB connections, etc.). */
  close?(): void;
}
