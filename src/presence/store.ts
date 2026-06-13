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

/** A heartbeat is considered "active" within this window; older but still-alive
 *  pids read as `idle`. Death is determined by pid probe, not this window. */
export const ACTIVE_WINDOW_MS = 30_000;

export type InstanceStatus = "active" | "idle" | "exited";

export interface InstanceUpsert {
  session_id: string;
  target?: string | null;
  role?: string | null;
  pid?: number | null;
  pid_start_hint?: string | null;
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
  pid_start_hint: string | null;
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
 * A new event also revives a row the reaper previously marked exited (guards
 * against a false-positive reap when the agent is in fact still running).
 */
export function upsertInstance(row: InstanceUpsert): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO panopticon_instances (
       session_id, target, role, pid, pid_start_hint, room, worktree, branch,
       first_seen_ms, last_seen_ms, ended_at_ms, ended_reason)
     VALUES (
       @session_id, @target, @role, @pid, @pid_start_hint, @room, @worktree, @branch,
       @last_seen_ms, @last_seen_ms, NULL, NULL)
     ON CONFLICT(session_id) DO UPDATE SET
       target = COALESCE(excluded.target, panopticon_instances.target),
       role = COALESCE(excluded.role, panopticon_instances.role),
       pid = COALESCE(excluded.pid, panopticon_instances.pid),
       pid_start_hint = COALESCE(excluded.pid_start_hint, panopticon_instances.pid_start_hint),
       room = COALESCE(excluded.room, panopticon_instances.room),
       worktree = COALESCE(excluded.worktree, panopticon_instances.worktree),
       branch = COALESCE(excluded.branch, panopticon_instances.branch),
       last_seen_ms = MAX(panopticon_instances.last_seen_ms, excluded.last_seen_ms),
       ended_at_ms = NULL,
       ended_reason = NULL`,
  ).run({
    session_id: row.session_id,
    target: row.target ?? null,
    role: row.role ?? null,
    pid: row.pid ?? null,
    pid_start_hint: row.pid_start_hint ?? null,
    room: row.room ?? null,
    worktree: row.worktree ?? null,
    branch: row.branch ?? null,
    last_seen_ms: row.last_seen_ms,
  });
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
      `SELECT session_id, target, role, pid, pid_start_hint, room, worktree,
              branch, first_seen_ms, last_seen_ms, ended_at_ms, ended_reason
         FROM panopticon_instances
         ${where}
         ORDER BY last_seen_ms DESC`,
    )
    .all(params) as InstanceRow[];
  return rows.map((row) => ({ ...row, status: deriveStatus(row, opts.nowMs) }));
}

export interface InstancesResult {
  now_ms: number;
  counts: { active: number; idle: number; exited: number; total: number };
  instances: InstanceView[];
}

/** Roster view with derived status and status counts, for the MCP tool/CLI. */
export function readInstancesResult(opts: {
  room?: string;
  includeEnded?: boolean;
}): InstancesResult {
  const nowMs = Date.now();
  const instances = readInstances({
    room: opts.room,
    // Default to showing recently-exited instances too — the roster's value is
    // partly in seeing who just died.
    includeEnded: opts.includeEnded ?? true,
    nowMs,
  });
  const counts = { active: 0, idle: 0, exited: 0, total: instances.length };
  for (const i of instances) counts[i.status]++;
  return { now_ms: nowMs, counts, instances };
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
