/**
 * Live instance presence — a generic, panopticon-wide registry of every agent
 * session currently connected to the server, across all targets.
 *
 * Liveness is detected by actively probing the recorded pid, NOT by heartbeat
 * decay: a stale `last_seen_ms` alone cannot distinguish an idle/thinking agent
 * from a killed one. The reaper loop (see ./reaper.ts) probes pids on an interval
 * and marks dead ones `exited (pid_dead)`, which catches SIGKILLs, crashes, and
 * closed terminals that never fire a clean SessionEnd.
 */

import { getDb } from "../db/schema.js";
import { broadcast, hasClients } from "../ui/events.js";

/** A heartbeat is considered "active" within this window; older but still-alive
 *  pids read as `idle`. Death is determined by pid probe, not this window. */
export const ACTIVE_WINDOW_MS = 30_000;

/** Default roster only surfaces instances that exited within this window. Older
 *  exited rows are retained for history but kept out of the live roster so it
 *  doesn't fill with long-dead sessions. */
export const EXITED_ROSTER_WINDOW_MS = 10 * 60_000;

/** Exited rows are physically deleted once they are older than this. Bounds
 *  table growth independently of the size-gated DB prune. */
export const EXITED_PRUNE_TTL_MS = 60 * 60_000;

export type InstanceStatus = "active" | "idle" | "exited";

export interface InstanceUpsert {
  session_id: string;
  target?: string | null;
  role?: string | null;
  pid?: number | null;
  room?: string | null;
  worktree?: string | null;
  branch?: string | null;
  last_seen_ms: number;
}

export interface InstanceRow {
  session_id: string;
  target: string | null;
  role: string | null;
  pid: number | null;
  room: string | null;
  worktree: string | null;
  branch: string | null;
  first_seen_ms: number;
  last_seen_ms: number;
  ended_at_ms: number | null;
  ended_reason: string | null;
}

export interface InstanceView extends InstanceRow {
  status: InstanceStatus;
}

/**
 * Test whether a pid is alive. `process.kill(pid, 0)` sends no signal but throws
 * if the process does not exist (ESRCH). EPERM means the process exists but is
 * owned by another user — still alive. Same-host/same-uid is the panopticon
 * model, so EPERM is rare but handled for correctness.
 *
 * Limitation — pid reuse: this probes the pid number only, not process identity.
 * If an agent dies without SessionEnd and the OS recycles its pid (for an
 * unrelated process) before the reaper's next pass, the instance is pinned
 * `idle` until its heartbeat is otherwise resolved. Low probability on the ~7s
 * reaper timescale; we deliberately don't pay an OS start-time lookup per hook
 * event to close it.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Record or refresh an instance heartbeat. On first sight `first_seen_ms` is
 * seeded; subsequent events only bump `last_seen_ms` and COALESCE-fill metadata.
 * A new event revives a row the reaper previously marked `pid_dead` (guards
 * against a false-positive reap when the agent is in fact still running). A
 * `session_end` exit is terminal, however: it is never revived, so a stray
 * out-of-order event arriving after a clean exit cannot resurrect the session.
 */
export function upsertInstance(row: InstanceUpsert): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO panopticon_instances (
       session_id, target, role, pid, room, worktree, branch,
       first_seen_ms, last_seen_ms, ended_at_ms, ended_reason)
     VALUES (
       @session_id, @target, @role, @pid, @room, @worktree, @branch,
       @last_seen_ms, @last_seen_ms, NULL, NULL)
     ON CONFLICT(session_id) DO UPDATE SET
       target = COALESCE(excluded.target, panopticon_instances.target),
       role = COALESCE(excluded.role, panopticon_instances.role),
       pid = COALESCE(excluded.pid, panopticon_instances.pid),
       room = COALESCE(excluded.room, panopticon_instances.room),
       worktree = COALESCE(excluded.worktree, panopticon_instances.worktree),
       branch = COALESCE(excluded.branch, panopticon_instances.branch),
       -- Keep a session_end-terminal row fully frozen: don't advance last_seen
       -- past its ended_at_ms on a stray post-exit event. Live and pid_dead rows
       -- bump normally (pid_dead is then revived below).
       last_seen_ms = CASE WHEN panopticon_instances.ended_reason = 'session_end'
                           THEN panopticon_instances.last_seen_ms
                           ELSE MAX(panopticon_instances.last_seen_ms, excluded.last_seen_ms) END,
       -- Revive a pid_dead false-positive, but keep session_end terminal.
       ended_at_ms = CASE WHEN panopticon_instances.ended_reason = 'session_end'
                          THEN panopticon_instances.ended_at_ms ELSE NULL END,
       ended_reason = CASE WHEN panopticon_instances.ended_reason = 'session_end'
                           THEN panopticon_instances.ended_reason ELSE NULL END`,
  ).run({
    session_id: row.session_id,
    target: row.target ?? null,
    role: row.role ?? null,
    pid: row.pid ?? null,
    room: row.room ?? null,
    worktree: row.worktree ?? null,
    branch: row.branch ?? null,
    last_seen_ms: row.last_seen_ms,
  });
  broadcastInstance(row.session_id);
}

/** When this session first appeared (its presence join time), or null. */
export function getInstanceFirstSeen(sessionId: string): number | null {
  const row = getDb()
    .prepare(
      "SELECT first_seen_ms FROM panopticon_instances WHERE session_id = ?",
    )
    .get(sessionId) as { first_seen_ms: number } | undefined;
  return row?.first_seen_ms ?? null;
}

/** Mark an instance ended. No-op if it is already ended. */
export function endInstance(
  sessionId: string,
  reason: "session_end" | "pid_dead",
  endedAtMs: number,
): void {
  getDb()
    .prepare(
      `UPDATE panopticon_instances
         SET ended_at_ms = @ended_at_ms, ended_reason = @reason
       WHERE session_id = @session_id AND ended_at_ms IS NULL`,
    )
    .run({ session_id: sessionId, reason, ended_at_ms: endedAtMs });
  broadcastInstance(sessionId);
}

/**
 * Push the current view of one instance to any connected Mission Control client.
 * Skips the read-back entirely when no dashboard is open so the hook-ingest hot
 * path (which upserts on every event) stays free. Never throws into the caller.
 */
function broadcastInstance(sessionId: string): void {
  if (!hasClients()) return;
  try {
    const view = readInstance(sessionId, Date.now());
    if (view) broadcast({ type: "instance", data: view });
  } catch {
    // Presence writes must never fail because a UI listener errored.
  }
}

function deriveStatus(row: InstanceRow, nowMs: number): InstanceStatus {
  if (row.ended_at_ms != null) return "exited";
  if (nowMs - row.last_seen_ms < ACTIVE_WINDOW_MS) return "active";
  if (row.pid != null && isPidAlive(row.pid)) return "idle";
  // Heartbeat is stale and the pid is gone — the reaper will mark this exited on
  // its next pass; report it as exited now so reads are immediately consistent.
  return "exited";
}

export interface ReadInstancesOptions {
  room?: string;
  includeEnded?: boolean;
  nowMs: number;
}

/** Read the roster, newest activity first, with derived status. */
export function readInstances(opts: ReadInstancesOptions): InstanceView[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.room) {
    clauses.push("room = @room");
    params.room = opts.room;
  }
  if (!opts.includeEnded) {
    clauses.push("ended_at_ms IS NULL");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT session_id, target, role, pid, room, worktree,
              branch, first_seen_ms, last_seen_ms, ended_at_ms, ended_reason
         FROM panopticon_instances
         ${where}
         ORDER BY last_seen_ms DESC`,
    )
    .all(params) as InstanceRow[];
  return rows.map((row) => ({ ...row, status: deriveStatus(row, opts.nowMs) }));
}

/** Read a single instance (including ended ones) with derived status. */
export function readInstance(
  sessionId: string,
  nowMs: number,
): InstanceView | null {
  const row = getDb()
    .prepare(
      `SELECT session_id, target, role, pid, room, worktree,
              branch, first_seen_ms, last_seen_ms, ended_at_ms, ended_reason
         FROM panopticon_instances
         WHERE session_id = ?`,
    )
    .get(sessionId) as InstanceRow | undefined;
  return row ? { ...row, status: deriveStatus(row, nowMs) } : null;
}

export interface InstancesResult {
  now_ms: number;
  /** The scope queried: a room key, or null when listing across all rooms. */
  room: string | null;
  counts: { active: number; idle: number; exited: number; total: number };
  instances: InstanceView[];
}

/**
 * Roster view with derived status and status counts, for the MCP tool/CLI.
 * Exited instances are included only if they ended within `exitedWithinMs`
 * (default {@link EXITED_ROSTER_WINDOW_MS}) so the live roster doesn't fill with
 * long-dead sessions; pass `includeEnded: false` to drop exited entirely.
 * Freshly-discovered-dead rows (status exited but not yet persisted by the
 * reaper, so `ended_at_ms` is null) are always shown.
 */
export function readInstancesResult(opts: {
  room?: string;
  includeEnded?: boolean;
  exitedWithinMs?: number;
}): InstancesResult {
  const nowMs = Date.now();
  const includeEnded = opts.includeEnded ?? true;
  const window = opts.exitedWithinMs ?? EXITED_ROSTER_WINDOW_MS;
  const instances = readInstances({
    room: opts.room,
    includeEnded: true,
    nowMs,
  }).filter((i) => {
    if (i.status !== "exited") return true;
    if (!includeEnded) return false;
    return i.ended_at_ms == null || nowMs - i.ended_at_ms <= window;
  });
  const counts = { active: 0, idle: 0, exited: 0, total: instances.length };
  for (const i of instances) counts[i.status]++;
  return { now_ms: nowMs, room: opts.room ?? null, counts, instances };
}

/**
 * Physically delete exited instances older than `ttlMs`. Keeps the table
 * bounded regardless of the size-gated DB prune. Returns the number deleted.
 */
export function pruneExitedInstances(
  nowMs: number,
  ttlMs: number = EXITED_PRUNE_TTL_MS,
): number {
  return getDb()
    .prepare(
      `DELETE FROM panopticon_instances
         WHERE ended_at_ms IS NOT NULL AND ended_at_ms < @cutoff`,
    )
    .run({ cutoff: nowMs - ttlMs }).changes;
}

/**
 * Probe every live instance's pid and mark dead ones exited. Returns the
 * session ids that were reaped (callers can use these to expire downstream
 * leases — e.g. sidequest claims). Rows without a pid are left alone; their
 * liveness is governed by SessionEnd and heartbeat staleness only.
 */
export function reapDeadInstances(nowMs: number): string[] {
  const live = getDb()
    .prepare(
      `SELECT session_id, pid FROM panopticon_instances
         WHERE ended_at_ms IS NULL AND pid IS NOT NULL`,
    )
    .all() as Array<{ session_id: string; pid: number }>;
  const reaped: string[] = [];
  for (const { session_id, pid } of live) {
    if (!isPidAlive(pid)) {
      endInstance(session_id, "pid_dead", nowMs);
      reaped.push(session_id);
    }
  }
  return reaped;
}
