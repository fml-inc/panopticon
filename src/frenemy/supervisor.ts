/**
 * Daemon-owned frenemy supervisor. When enabled, it keeps exactly one frenemy
 * loop running for every room that currently has at least one live primary
 * agent. Frenemy-role sessions do not count, so a room cannot keep itself alive.
 */

import { config } from "../config.js";
import { log } from "../log.js";
import {
  type InstancesResult,
  type InstanceView,
  readInstancesResult,
} from "../presence/store.js";
import {
  createFrenemyLoop,
  FRENEMY_FROM,
  type FrenemyLoopHandle,
  type FrenemyOptions,
} from "./driver.js";

export interface FrenemySupervisorHandle {
  start: () => void;
  stop: () => void;
  runOnce: () => void;
  activeRooms: () => string[];
}

export interface FrenemySupervisorOptions {
  enabled?: boolean;
  runner?: FrenemyOptions["runner"];
  model?: string | null;
  settleMs?: number;
  reconcileMs?: number;
  idleStopMs?: number;
  now?: () => number;
  readRoster?: () => Pick<InstancesResult, "instances">;
  createLoop?: (
    opts: FrenemyOptions & { settleMs: number },
  ) => FrenemyLoopHandle;
}

interface RoomState {
  handle: FrenemyLoopHandle;
  lastPrimarySeenMs: number;
}

function isPrimaryAgent(instance: InstanceView): boolean {
  return (
    instance.status !== "exited" &&
    instance.role !== "frenemy" &&
    instance.session_id !== FRENEMY_FROM &&
    typeof instance.room === "string" &&
    instance.room.length > 0
  );
}

function livePrimaryRooms(instances: InstanceView[]): Set<string> {
  const rooms = new Set<string>();
  for (const instance of instances) {
    if (isPrimaryAgent(instance)) rooms.add(instance.room!);
  }
  return rooms;
}

export function createFrenemySupervisor(
  opts: FrenemySupervisorOptions = {},
): FrenemySupervisorHandle {
  const enabled = opts.enabled ?? config.enableFrenemy;
  const runner = opts.runner ?? config.frenemyRunner;
  const model = opts.model ?? config.frenemyModel;
  const settleMs = opts.settleMs ?? config.frenemySettleMs;
  const reconcileMs = opts.reconcileMs ?? config.frenemyReconcileMs;
  const idleStopMs = opts.idleStopMs ?? config.frenemyIdleStopMs;
  const now = opts.now ?? (() => Date.now());
  const readRoster =
    opts.readRoster ?? (() => readInstancesResult({ includeEnded: false }));
  const createLoop =
    opts.createLoop ??
    ((loopOpts) =>
      createFrenemyLoop({
        ...loopOpts,
        settleMs,
      }));

  const rooms = new Map<string, RoomState>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function startRoom(room: string, nowMs: number): void {
    if (rooms.has(room)) return;
    try {
      const handle = createLoop({ room, runner, model, settleMs });
      rooms.set(room, { handle, lastPrimarySeenMs: nowMs });
      log.server.info(`frenemy supervisor started room "${room}"`);
      void handle.done.then(() => {
        if (rooms.get(room)?.handle === handle) {
          rooms.delete(room);
          log.server.info(`frenemy supervisor room "${room}" stopped`);
        }
      });
    } catch (err) {
      log.server.error(
        `frenemy supervisor failed to start room "${room}":`,
        err,
      );
    }
  }

  function stopRoom(room: string): void {
    const state = rooms.get(room);
    if (!state) return;
    rooms.delete(room);
    state.handle.stop();
    log.server.info(`frenemy supervisor stopped room "${room}"`);
  }

  function reconcile(): void {
    if (!enabled) return;
    const nowMs = now();
    let activeRooms: Set<string>;
    try {
      activeRooms = livePrimaryRooms(readRoster().instances);
    } catch (err) {
      log.server.error("frenemy supervisor roster read failed:", err);
      return;
    }

    for (const room of activeRooms) {
      const state = rooms.get(room);
      if (state) state.lastPrimarySeenMs = nowMs;
      else startRoom(room, nowMs);
    }

    for (const [room, state] of rooms) {
      if (activeRooms.has(room)) continue;
      if (nowMs - state.lastPrimarySeenMs >= idleStopMs) {
        stopRoom(room);
      }
    }
  }

  return {
    start() {
      if (!enabled || timer) return;
      reconcile();
      timer = setInterval(reconcile, reconcileMs);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      for (const room of [...rooms.keys()]) stopRoom(room);
    },
    runOnce: reconcile,
    activeRooms: () => [...rooms.keys()].sort(),
  };
}
