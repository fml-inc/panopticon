/**
 * Presence reaper — periodically probes the pid of every live instance and marks
 * dead ones `exited (pid_dead)`. This is the authoritative liveness signal:
 * SessionEnd catches clean exits, but kills / crashes / closed terminals never
 * fire it, and a heartbeat going stale only means "idle", not "gone".
 */

import { log } from "../log.js";
import { reapDeadInstances } from "./store.js";

export const DEFAULT_REAP_INTERVAL_MS = 7_000;

export interface ReaperOptions {
  intervalMs?: number;
  /** Wall clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Notified with the session ids reaped on each pass (e.g. to expire leases). */
  onReap?: (sessionIds: string[]) => void;
}

export interface ReaperHandle {
  start: () => void;
  stop: () => void;
  /** Run a single reap pass synchronously; returns reaped session ids. */
  runOnce: () => string[];
}

export function createReaperLoop(opts: ReaperOptions = {}): ReaperHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  function runOnce(): string[] {
    try {
      const reaped = reapDeadInstances(now());
      if (reaped.length > 0) {
        log.presence.debug(
          `Reaped ${reaped.length} dead instance(s): ${reaped.join(", ")}`,
        );
        opts.onReap?.(reaped);
      }
      return reaped;
    } catch (err) {
      log.presence.error("Reaper pass failed:", err);
      return [];
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(runOnce, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce,
  };
}
