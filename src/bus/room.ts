/**
 * Bus room resolution. A "room" scopes agent-to-agent messages to a shared
 * workspace.
 */

import { getDb } from "../db/schema.js";
import { resolveRepoFromCwd } from "../repo.js";

/**
 * Resolve the bus room key for a working directory. The room is the workspace at
 * REPO granularity — not the worktree — so agents in different worktrees of the
 * same repo (separate branches, separate PRs) still share one room and can
 * coordinate. Returns null when no repo can be resolved.
 *
 * This intentionally returns the same value Layer 0 presence records as
 * `panopticon_instances.room` (both go through repo resolution), so a room
 * derived from a cwd and a room recorded from hook events are the same key.
 */
export function resolveRoom(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return resolveRepoFromCwd(cwd)?.repo ?? null;
}

/**
 * The room a session is currently in, as recorded by instance presence. This is
 * how the bus resolves an "implicit" room: the caller passes its session id and
 * the server looks up the room presence already recorded for it.
 */
export function roomForSession(sessionId: string): string | null {
  const row = getDb()
    .prepare("SELECT room FROM panopticon_instances WHERE session_id = ?")
    .get(sessionId) as { room: string | null } | undefined;
  return row?.room ?? null;
}
