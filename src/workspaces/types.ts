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
   * Resolve repo info for the given CWD.  May return a `repoDir` that
   * differs from `cwd` (e.g. the parent project's main repo path) so
   * the caller can run git against a directory that still exists.
   */
  resolve(cwd: string): { repoDir: string; branch?: string | null } | null;

  /** Clean up resources (DB connections, etc.). */
  close?(): void;
}
