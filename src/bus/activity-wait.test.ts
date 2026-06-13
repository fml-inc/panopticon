import { afterEach, describe, expect, it } from "vitest";

import {
  _resetActivityWait,
  noteRoomActivity,
  waitForRoomActivity,
} from "./activity-wait.js";

afterEach(() => _resetActivityWait());

describe("waitForRoomActivity", () => {
  it("resolves immediately if newer activity already happened", async () => {
    noteRoomActivity("r", 100);
    await expect(waitForRoomActivity("r", 50, 1000)).resolves.toBe(100);
  });

  it("blocks, then resolves when newer activity arrives", async () => {
    const p = waitForRoomActivity("r", 50, 1000);
    noteRoomActivity("r", 60);
    await expect(p).resolves.toBe(60);
  });

  it("ignores activity not strictly newer than sinceMs (times out)", async () => {
    const p = waitForRoomActivity("r", 100, 40);
    noteRoomActivity("r", 100); // == sinceMs, not newer
    await expect(p).resolves.toBeNull();
  });

  it("resolves null on timeout when idle", async () => {
    await expect(waitForRoomActivity("r", 0, 30)).resolves.toBeNull();
  });

  it("is room-scoped — activity in another room does not wake it", async () => {
    const p = waitForRoomActivity("r1", 0, 40);
    noteRoomActivity("r2", 50);
    await expect(p).resolves.toBeNull();
  });

  it("wakes every waiter in a room", async () => {
    const a = waitForRoomActivity("r", 0, 1000);
    const b = waitForRoomActivity("r", 0, 1000);
    noteRoomActivity("r", 5);
    expect(await Promise.all([a, b])).toEqual([5, 5]);
  });
});
