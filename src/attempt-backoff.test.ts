import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("./config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-attempt-backoff");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import {
  applyAttemptBackoffJitter,
  clearAttemptBackoff,
  computeAttemptBackoffDelayMs,
  getAttemptBackoff,
  isAttemptBackoffActive,
  recordAttemptBackoffFailure,
} from "./attempt-backoff.js";
import { closeDb, getDb } from "./db/schema.js";

describe("attempt backoff", () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(os.tmpdir(), "panopticon-test-attempt-backoff"), {
      recursive: true,
    });
    getDb();
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM attempt_backoffs").run();
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(path.join(os.tmpdir(), "panopticon-test-attempt-backoff"), {
      recursive: true,
      force: true,
    });
  });

  it("uses the capped exponential schedule for blocked attempts", () => {
    expect(computeAttemptBackoffDelayMs(0)).toBe(0);
    expect(computeAttemptBackoffDelayMs(1)).toBe(60_000);
    expect(computeAttemptBackoffDelayMs(2)).toBe(2 * 60_000);
    expect(computeAttemptBackoffDelayMs(6)).toBe(32 * 60_000);
    expect(computeAttemptBackoffDelayMs(7)).toBe(60 * 60_000);
    expect(computeAttemptBackoffDelayMs(8)).toBe(2 * 60 * 60_000);
    expect(computeAttemptBackoffDelayMs(9)).toBe(4 * 60 * 60_000);
    expect(computeAttemptBackoffDelayMs(10)).toBe(6 * 60 * 60_000);
    expect(computeAttemptBackoffDelayMs(99)).toBe(6 * 60 * 60_000);
  });

  it("applies bounded jitter around the base backoff delay", () => {
    expect(applyAttemptBackoffJitter(0, () => 0.5)).toBe(0);
    expect(applyAttemptBackoffJitter(60_000, () => 0)).toBe(54_000);
    expect(applyAttemptBackoffJitter(60_000, () => 0.5)).toBe(60_000);
    expect(applyAttemptBackoffJitter(60_000, () => 1)).toBe(66_000);
  });

  it("persists and clears backoff state by scope", () => {
    recordAttemptBackoffFailure(
      "sync-target",
      "fml",
      "HTTP 503",
      1_000,
      () => 0.5,
    );
    expect(isAttemptBackoffActive("sync-target", "fml", 59_999)).toBe(true);
    expect(isAttemptBackoffActive("sync-target", "fml", 61_000)).toBe(false);

    const row = getAttemptBackoff("sync-target", "fml");
    expect(row).toMatchObject({
      scope_kind: "sync-target",
      scope_key: "fml",
      failure_count: 1,
      last_error: "HTTP 503",
      last_attempted_at_ms: 1_000,
      next_attempt_at_ms: 61_000,
    });

    recordAttemptBackoffFailure(
      "sync-target",
      "fml",
      "HTTP 503",
      61_000,
      () => 0.5,
    );
    expect(getAttemptBackoff("sync-target", "fml")?.failure_count).toBe(2);
    expect(getAttemptBackoff("sync-target", "fml")?.next_attempt_at_ms).toBe(
      61_000 + 2 * 60_000,
    );

    clearAttemptBackoff("sync-target", "fml");
    expect(getAttemptBackoff("sync-target", "fml")).toBeNull();
  });
});
