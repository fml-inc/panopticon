import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
  const dataDir = `/tmp/panopticon-presence-test-${process.pid}`;
  return { dataDir, dbPath: `${dataDir}/panopticon.db` };
});

vi.mock("../config.js", () => ({
  config: { dataDir: testPaths.dataDir, dbPath: testPaths.dbPath },
}));

import { closeDb, getDb } from "../db/schema.js";
import {
  ACTIVE_WINDOW_MS,
  EXITED_ROSTER_WINDOW_MS,
  endInstance,
  isPidAlive,
  pruneExitedInstances,
  readInstances,
  readInstancesResult,
  reapDeadInstances,
  upsertInstance,
} from "./store.js";

/** A pid that is guaranteed dead: spawn a process, let it exit, reuse its pid. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  if (!r.pid) throw new Error("could not spawn child for dead pid");
  return r.pid;
}

const NOW = 1_000_000_000_000;

describe("presence store", () => {
  beforeEach(() => {
    fs.mkdirSync(testPaths.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  });

  it("reports a fresh heartbeat as active", () => {
    upsertInstance({
      session_id: "s1",
      target: "claude",
      pid: process.pid,
      room: "repo:demo",
      last_seen_ms: NOW,
    });
    const [view] = readInstances({ nowMs: NOW });
    expect(view.session_id).toBe("s1");
    expect(view.status).toBe("active");
  });

  it("reports a stale heartbeat with a live pid as idle, not exited", () => {
    upsertInstance({
      session_id: "s1",
      pid: process.pid, // our own process — definitely alive
      last_seen_ms: NOW,
    });
    const [view] = readInstances({ nowMs: NOW + ACTIVE_WINDOW_MS + 1 });
    expect(view.status).toBe("idle");
  });

  it("reports a stale heartbeat with a dead pid as exited", () => {
    upsertInstance({ session_id: "s1", pid: deadPid(), last_seen_ms: NOW });
    const [view] = readInstances({ nowMs: NOW + ACTIVE_WINDOW_MS + 1 });
    expect(view.status).toBe("exited");
  });

  it("reaper marks dead pids exited (pid_dead) and leaves live ones alone", () => {
    upsertInstance({ session_id: "dead", pid: deadPid(), last_seen_ms: NOW });
    upsertInstance({ session_id: "live", pid: process.pid, last_seen_ms: NOW });

    const reaped = reapDeadInstances(NOW + 1);
    expect(reaped).toEqual(["dead"]);

    const rows = readInstances({ nowMs: NOW + 1, includeEnded: true });
    const dead = rows.find((r) => r.session_id === "dead");
    const live = rows.find((r) => r.session_id === "live");
    expect(dead?.status).toBe("exited");
    expect(dead?.ended_reason).toBe("pid_dead");
    expect(live?.ended_at_ms).toBeNull();
  });

  it("endInstance marks a clean session_end exit", () => {
    upsertInstance({ session_id: "s1", pid: process.pid, last_seen_ms: NOW });
    endInstance("s1", "session_end", NOW + 5);
    const [view] = readInstances({ nowMs: NOW + 6, includeEnded: true });
    expect(view.status).toBe("exited");
    expect(view.ended_reason).toBe("session_end");
  });

  it("a later heartbeat revives an instance the reaper wrongly ended", () => {
    upsertInstance({ session_id: "s1", pid: deadPid(), last_seen_ms: NOW });
    reapDeadInstances(NOW + 1);
    // Same session reappears (e.g. false-positive reap) with a live pid.
    upsertInstance({
      session_id: "s1",
      pid: process.pid,
      last_seen_ms: NOW + 10,
    });
    const [view] = readInstances({ nowMs: NOW + 11 });
    expect(view.status).toBe("active");
    expect(view.ended_at_ms).toBeNull();
  });

  it("upsert bumps last_seen and fills metadata without clobbering", () => {
    upsertInstance({ session_id: "s1", pid: process.pid, last_seen_ms: NOW });
    upsertInstance({
      session_id: "s1",
      room: "repo:demo",
      branch: "feat/x",
      last_seen_ms: NOW + 100,
    });
    const [view] = readInstances({ nowMs: NOW + 100 });
    expect(view.pid).toBe(process.pid); // preserved
    expect(view.room).toBe("repo:demo"); // filled
    expect(view.branch).toBe("feat/x");
    expect(view.last_seen_ms).toBe(NOW + 100);
  });

  it("readInstancesResult returns status counts", () => {
    // Recent timestamps so the exited row falls inside the roster window.
    const recent = Date.now();
    upsertInstance({
      session_id: "live",
      pid: process.pid,
      last_seen_ms: recent,
    });
    upsertInstance({
      session_id: "dead",
      pid: deadPid(),
      last_seen_ms: recent,
    });
    endInstance("dead", "pid_dead", recent);
    const result = readInstancesResult({});
    expect(result.counts.total).toBe(2);
    expect(result.counts.exited).toBe(1);
    expect(result.counts.active + result.counts.idle).toBe(1);
  });

  it("default roster drops exited rows older than the window but keeps recent ones", () => {
    const now = Date.now();
    // Exited long ago — outside the roster window.
    upsertInstance({ session_id: "old", pid: deadPid(), last_seen_ms: now });
    endInstance("old", "pid_dead", now - EXITED_ROSTER_WINDOW_MS - 1000);
    // Exited just now — inside the window.
    upsertInstance({ session_id: "fresh", pid: deadPid(), last_seen_ms: now });
    endInstance("fresh", "pid_dead", now);

    const ids = readInstancesResult({}).instances.map((i) => i.session_id);
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("old");

    // includeEnded:false drops all exited rows.
    expect(readInstancesResult({ includeEnded: false }).instances).toHaveLength(
      0,
    );
  });

  it("session_end is terminal — a later event does not revive it", () => {
    upsertInstance({ session_id: "s1", pid: process.pid, last_seen_ms: NOW });
    endInstance("s1", "session_end", NOW + 5);
    // A stray out-of-order event arrives after the clean exit.
    upsertInstance({
      session_id: "s1",
      pid: process.pid,
      last_seen_ms: NOW + 10,
    });
    const [view] = readInstances({ nowMs: NOW + 11, includeEnded: true });
    expect(view.status).toBe("exited");
    expect(view.ended_reason).toBe("session_end");
    // A terminal row stays frozen: the stray event must not advance last_seen
    // past ended_at_ms.
    expect(view.last_seen_ms).toBe(NOW);
    expect(view.ended_at_ms).toBe(NOW + 5);
  });

  it("pruneExitedInstances deletes old exited rows but keeps live and recent", () => {
    const now = Date.now();
    upsertInstance({ session_id: "old", pid: deadPid(), last_seen_ms: now });
    endInstance("old", "pid_dead", now - 2 * 60 * 60_000); // 2h ago
    upsertInstance({ session_id: "recent", pid: deadPid(), last_seen_ms: now });
    endInstance("recent", "pid_dead", now);
    upsertInstance({ session_id: "live", pid: process.pid, last_seen_ms: now });

    const deleted = pruneExitedInstances(now, 60 * 60_000); // 1h TTL
    expect(deleted).toBe(1);

    const ids = readInstances({ nowMs: now, includeEnded: true }).map(
      (i) => i.session_id,
    );
    expect(ids).not.toContain("old");
    expect(ids).toContain("recent");
    expect(ids).toContain("live");
  });

  it("filters by room", () => {
    upsertInstance({
      session_id: "a",
      pid: process.pid,
      room: "repo:one",
      last_seen_ms: NOW,
    });
    upsertInstance({
      session_id: "b",
      pid: process.pid,
      room: "repo:two",
      last_seen_ms: NOW,
    });
    const rows = readInstances({ nowMs: NOW, room: "repo:one" });
    expect(rows.map((r) => r.session_id)).toEqual(["a"]);
  });

  it("isPidAlive is true for self and false for a dead pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(deadPid())).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});
