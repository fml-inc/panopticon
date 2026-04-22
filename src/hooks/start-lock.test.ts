/**
 * Tests for acquireStartLock / reclaimStaleLock — the lock that prevents
 * concurrent hook handlers from both spawning the panopticon server.
 *
 * Critical correctness property: a lock left behind by a SIGKILL'd or
 * crashed handler must not wedge ingest forever. The reclaim path checks
 * the recorded PID for liveness and unlinks the file if the writer is dead.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("start lock", () => {
  let tmpDir: string;
  let lockFile: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-lock-test-"));
    lockFile = path.join(tmpDir, "panopticon.pid.lock");
    savedDataDir = process.env.PANOPTICON_DATA_DIR;
    process.env.PANOPTICON_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedDataDir === undefined) delete process.env.PANOPTICON_DATA_DIR;
    else process.env.PANOPTICON_DATA_DIR = savedDataDir;
  });

  /**
   * Find a PID guaranteed to be unallocated. Spawn a no-op child, capture
   * its PID, wait for it to exit, and reuse the PID. The kernel may
   * eventually recycle it, but for the lifetime of one test it's dead.
   */
  function getDeadPid(): number {
    const child = spawnSync("node", ["-e", ""], { stdio: "ignore" });
    if (child.pid == null) throw new Error("could not spawn child");
    return child.pid;
  }

  describe("reclaimStaleLock", () => {
    it("returns false when the lock file does not exist", async () => {
      const { reclaimStaleLock } = await import("./handler.js");
      expect(reclaimStaleLock(lockFile)).toBe(false);
    });

    it("returns false when the holder is alive (this process)", async () => {
      const { reclaimStaleLock } = await import("./handler.js");
      // Use a real, definitely-alive PID — but not our own (the function
      // refuses to reclaim its own PID for safety).
      // We can't easily get another live PID portably, so we simulate with
      // the parent process if available, else PID 1.
      const aliveOtherPid =
        process.ppid && process.ppid !== process.pid ? process.ppid : 1; // init/launchd is always alive
      fs.writeFileSync(lockFile, String(aliveOtherPid));
      expect(reclaimStaleLock(lockFile)).toBe(false);
      // Lock file must still exist — we didn't reclaim.
      expect(fs.existsSync(lockFile)).toBe(true);
    });

    it("returns false when the lock holds our own PID (don't kill ourselves)", async () => {
      const { reclaimStaleLock } = await import("./handler.js");
      fs.writeFileSync(lockFile, String(process.pid));
      expect(reclaimStaleLock(lockFile)).toBe(false);
      expect(fs.existsSync(lockFile)).toBe(true);
    });

    it("reclaims and unlinks when the holder is dead", async () => {
      const { reclaimStaleLock } = await import("./handler.js");
      fs.writeFileSync(lockFile, String(getDeadPid()));
      expect(reclaimStaleLock(lockFile)).toBe(true);
      expect(fs.existsSync(lockFile)).toBe(false);
    });

    it("returns false when the lock file is corrupt (non-numeric)", async () => {
      const { reclaimStaleLock } = await import("./handler.js");
      fs.writeFileSync(lockFile, "not-a-pid");
      expect(reclaimStaleLock(lockFile)).toBe(false);
      // Conservative: don't reclaim what we can't parse.
      expect(fs.existsSync(lockFile)).toBe(true);
    });

    it("returns false when the lock file is empty", async () => {
      const { reclaimStaleLock } = await import("./handler.js");
      // The narrow window between O_EXCL create and PID write: file exists
      // but is empty. parseInt("") is NaN, so we don't reclaim.
      fs.writeFileSync(lockFile, "");
      expect(reclaimStaleLock(lockFile)).toBe(false);
      expect(fs.existsSync(lockFile)).toBe(true);
    });

    it("returns false for negative or zero PIDs", async () => {
      const { reclaimStaleLock } = await import("./handler.js");
      fs.writeFileSync(lockFile, "0");
      expect(reclaimStaleLock(lockFile)).toBe(false);
      fs.writeFileSync(lockFile, "-1");
      expect(reclaimStaleLock(lockFile)).toBe(false);
    });
  });

  describe("acquireStartLock", () => {
    it("returns true when no lock file exists", async () => {
      const { acquireStartLock } = await import("./handler.js");
      expect(acquireStartLock(lockFile)).toBe(true);
      expect(fs.existsSync(lockFile)).toBe(true);
      // Our PID should be inside.
      expect(fs.readFileSync(lockFile, "utf-8").trim()).toBe(
        String(process.pid),
      );
    });

    it("returns false when a live holder owns the lock", async () => {
      const { acquireStartLock } = await import("./handler.js");
      // Our own PID counts as "live and not us", but reclaimStaleLock
      // refuses self-reclaim, so this returns false.
      fs.writeFileSync(lockFile, String(process.pid));
      expect(acquireStartLock(lockFile)).toBe(false);
    });

    it("reclaims a stale lock and acquires", async () => {
      const { acquireStartLock } = await import("./handler.js");
      fs.writeFileSync(lockFile, String(getDeadPid()));
      expect(acquireStartLock(lockFile)).toBe(true);
      // After reclaim, the lock now holds our PID.
      expect(fs.readFileSync(lockFile, "utf-8").trim()).toBe(
        String(process.pid),
      );
    });

    it("does not retry indefinitely if a fresh holder grabs the lock", async () => {
      // Simulating a true race is hard; cover the "second EEXIST" path by
      // verifying the function caps at one reclaim attempt. We can't easily
      // induce a race here, but we can confirm the loop terminates fast.
      const { acquireStartLock } = await import("./handler.js");
      fs.writeFileSync(lockFile, String(process.pid));
      const start = Date.now();
      expect(acquireStartLock(lockFile)).toBe(false);
      expect(Date.now() - start).toBeLessThan(100);
    });
  });
});
