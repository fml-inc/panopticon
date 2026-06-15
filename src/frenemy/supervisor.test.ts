import { describe, expect, it, vi } from "vitest";
import type { InstanceView } from "../presence/store.js";
import type { FrenemyLoopHandle, FrenemyOptions } from "./driver.js";
import { createFrenemySupervisor } from "./supervisor.js";

function instance(
  over: Partial<InstanceView> & { session_id: string },
): InstanceView {
  const { session_id, ...rest } = over;
  return {
    session_id,
    target: null,
    role: null,
    pid: null,
    room: "room-a",
    worktree: null,
    branch: null,
    first_seen_ms: 0,
    last_seen_ms: 0,
    ended_at_ms: null,
    ended_reason: null,
    status: "active",
    ...rest,
  };
}

function loopHandle(): FrenemyLoopHandle & { resolveDone: () => void } {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    stop: vi.fn(() => resolveDone()),
    done,
    resolveDone,
  };
}

describe("createFrenemySupervisor", () => {
  it("does nothing when disabled", () => {
    const createLoop = vi.fn();
    const supervisor = createFrenemySupervisor({
      enabled: false,
      readRoster: () => ({
        instances: [instance({ session_id: "p1", room: "room-a" })],
      }),
      createLoop,
    });

    supervisor.runOnce();

    expect(createLoop).not.toHaveBeenCalled();
    expect(supervisor.activeRooms()).toEqual([]);
  });

  it("starts exactly one frenemy per room with live primary agents", () => {
    const handles: FrenemyLoopHandle[] = [];
    const createLoop = vi.fn((_opts: FrenemyOptions & { settleMs: number }) => {
      const handle = loopHandle();
      handles.push(handle);
      return handle;
    });
    const supervisor = createFrenemySupervisor({
      enabled: true,
      runner: "claude",
      model: "opus",
      settleMs: 8,
      readRoster: () => ({
        instances: [
          instance({ session_id: "p1", room: "room-a" }),
          instance({ session_id: "p2", room: "room-a" }),
          instance({ session_id: "p3", room: "room-b", status: "idle" }),
          instance({
            session_id: "reviewer",
            room: "room-c",
            role: "frenemy",
          }),
          instance({ session_id: "dead", room: "room-d", status: "exited" }),
        ],
      }),
      createLoop,
    });

    supervisor.runOnce();
    supervisor.runOnce();

    expect(createLoop).toHaveBeenCalledTimes(2);
    expect(createLoop.mock.calls.map(([opts]) => opts.room).sort()).toEqual([
      "room-a",
      "room-b",
    ]);
    expect(createLoop.mock.calls[0][0]).toMatchObject({
      runner: "claude",
      model: "opus",
      settleMs: 8,
    });
    expect(supervisor.activeRooms()).toEqual(["room-a", "room-b"]);

    supervisor.stop();
    expect(handles.map((handle) => handle.stop)).toEqual([
      expect.any(Function),
      expect.any(Function),
    ]);
  });

  it("stops a room only after it has no primary agents for the idle grace", () => {
    let nowMs = 1_000;
    let instances = [instance({ session_id: "p1", room: "room-a" })];
    const handle = loopHandle();
    const supervisor = createFrenemySupervisor({
      enabled: true,
      idleStopMs: 100,
      now: () => nowMs,
      readRoster: () => ({ instances }),
      createLoop: () => handle,
    });

    supervisor.runOnce();
    expect(supervisor.activeRooms()).toEqual(["room-a"]);

    instances = [];
    nowMs = 1_099;
    supervisor.runOnce();
    expect(supervisor.activeRooms()).toEqual(["room-a"]);
    expect(handle.stop).not.toHaveBeenCalled();

    nowMs = 1_100;
    supervisor.runOnce();
    expect(supervisor.activeRooms()).toEqual([]);
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("resumes a room when a primary agent returns after idle stop", () => {
    let nowMs = 1_000;
    let instances = [instance({ session_id: "p1", room: "room-a" })];
    const handles = [loopHandle(), loopHandle()];
    const createLoop = vi.fn(() => handles.shift()!);
    const supervisor = createFrenemySupervisor({
      enabled: true,
      idleStopMs: 100,
      now: () => nowMs,
      readRoster: () => ({ instances }),
      createLoop,
    });

    supervisor.runOnce();
    expect(supervisor.activeRooms()).toEqual(["room-a"]);

    instances = [];
    nowMs = 1_100;
    supervisor.runOnce();
    expect(supervisor.activeRooms()).toEqual([]);
    expect(createLoop).toHaveBeenCalledTimes(1);

    instances = [instance({ session_id: "p2", room: "room-a" })];
    nowMs = 1_200;
    supervisor.runOnce();

    expect(createLoop).toHaveBeenCalledTimes(2);
    expect(supervisor.activeRooms()).toEqual(["room-a"]);
  });

  it("forgets an exited frenemy loop so the next reconcile can restart it", async () => {
    const handles = [loopHandle(), loopHandle()];
    const createLoop = vi.fn(() => handles.shift()!);
    const supervisor = createFrenemySupervisor({
      enabled: true,
      readRoster: () => ({
        instances: [instance({ session_id: "p1", room: "room-a" })],
      }),
      createLoop,
    });

    supervisor.runOnce();
    expect(supervisor.activeRooms()).toEqual(["room-a"]);

    createLoop.mock.results[0].value.resolveDone();
    await Promise.resolve();

    expect(supervisor.activeRooms()).toEqual([]);
    supervisor.runOnce();
    expect(createLoop).toHaveBeenCalledTimes(2);
    expect(supervisor.activeRooms()).toEqual(["room-a"]);
  });
});
