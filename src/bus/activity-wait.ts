/**
 * Server-side long-poll for room activity. Lets a watcher (e.g. the frenemy
 * reviewer) block until something happens in a room instead of fixed-interval
 * polling — so it does no work and makes no model calls while the room is idle,
 * and wakes promptly when an agent acts.
 *
 * A waiter resolves when a hook event newer than its `sinceMs` lands in the room
 * (noteRoomActivity), or with null after a timeout. If activity newer than
 * `sinceMs` already happened, the wait resolves immediately — which closes the
 * race where an event lands between a watcher's passes.
 *
 * State is an in-process singleton: this works precisely because /hooks ingestion
 * (which calls noteRoomActivity) and the wait_for_activity endpoint share one
 * server process. Moving ingestion off the server, or running a second server,
 * would silently break wakeups — they'd need a shared signal (DB poll, pub/sub).
 */

const roomWatermark = new Map<string, number>();

interface Waiter {
  sinceMs: number;
  resolve: (ts: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
}
const waiters = new Map<string, Set<Waiter>>();

/** Record that a hook event landed in a room and wake any matching waiters. */
export function noteRoomActivity(room: string, timestampMs: number): void {
  const prev = roomWatermark.get(room) ?? 0;
  if (timestampMs > prev) roomWatermark.set(room, timestampMs);

  const set = waiters.get(room);
  if (!set) return;
  for (const w of [...set]) {
    if (timestampMs > w.sinceMs) {
      clearTimeout(w.timer);
      set.delete(w);
      w.resolve(timestampMs);
    }
  }
  if (set.size === 0) waiters.delete(room);
}

/**
 * Resolve with the newest room-activity timestamp once it exceeds `sinceMs`, or
 * null after `timeoutMs`. Resolves immediately if such activity already exists.
 */
export function waitForRoomActivity(
  room: string,
  sinceMs: number,
  timeoutMs: number,
): Promise<number | null> {
  const current = roomWatermark.get(room) ?? 0;
  if (current > sinceMs) return Promise.resolve(current);

  return new Promise<number | null>((resolve) => {
    const set = waiters.get(room) ?? new Set<Waiter>();
    waiters.set(room, set);
    const waiter: Waiter = {
      sinceMs,
      resolve,
      timer: setTimeout(() => {
        set.delete(waiter);
        if (set.size === 0) waiters.delete(room);
        resolve(null);
      }, timeoutMs),
    };
    if (typeof waiter.timer.unref === "function") waiter.timer.unref();
    set.add(waiter);
  });
}

/** Test seam: drop all watermarks and reject nothing (clears state). */
export function _resetActivityWait(): void {
  for (const set of waiters.values()) {
    for (const w of set) clearTimeout(w.timer);
  }
  waiters.clear();
  roomWatermark.clear();
}
