import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
  const dataDir = `/tmp/panopticon-room-test-${process.pid}`;
  return { dataDir, dbPath: `${dataDir}/panopticon.db` };
});

vi.mock("../config.js", () => ({
  config: { dataDir: testPaths.dataDir, dbPath: testPaths.dbPath },
}));

import { closeDb, getDb } from "../db/schema.js";
import { upsertInstance } from "../presence/store.js";
import { resolveRoom, roomForSession } from "./room.js";

describe("bus room resolution", () => {
  beforeEach(() => {
    fs.mkdirSync(testPaths.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  });

  it("resolveRoom returns null for empty input", () => {
    expect(resolveRoom(null)).toBeNull();
    expect(resolveRoom(undefined)).toBeNull();
    expect(resolveRoom("")).toBeNull();
  });

  it("roomForSession reads the room recorded by presence", () => {
    upsertInstance({
      session_id: "s1",
      pid: process.pid,
      room: "fml-inc/panopticon",
      last_seen_ms: 1000,
    });
    expect(roomForSession("s1")).toBe("fml-inc/panopticon");
  });

  it("roomForSession returns null for an unknown or roomless session", () => {
    expect(roomForSession("nope")).toBeNull();
    upsertInstance({ session_id: "s2", pid: process.pid, last_seen_ms: 1000 });
    expect(roomForSession("s2")).toBeNull();
  });
});
