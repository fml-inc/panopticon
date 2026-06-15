import { describe, expect, it, vi } from "vitest";

import { isBusyError, withBusyRetry } from "./busy-retry.js";

describe("isBusyError", () => {
  it("matches SQLITE_BUSY lock-contention messages (case-insensitive)", () => {
    expect(isBusyError(new Error("database is locked"))).toBe(true);
    expect(isBusyError(new Error("SqliteError: database is locked"))).toBe(
      true,
    );
    expect(isBusyError(new Error("database is busy"))).toBe(true);
    expect(isBusyError(new Error("SQLITE_BUSY: ..."))).toBe(true);
  });

  it("rejects unrelated errors and non-Errors", () => {
    expect(isBusyError(new Error("no such column: summary"))).toBe(false);
    expect(isBusyError(new Error("UNIQUE constraint failed"))).toBe(false);
    expect(isBusyError("database is locked")).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
  });
});

describe("withBusyRetry", () => {
  it("returns the result when fn succeeds on the first try", () => {
    const fn = vi.fn(() => 42);
    expect(withBusyRetry(fn)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on busy errors and returns once it succeeds", () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      if (calls < 3) throw new Error("database is locked");
      return "ok";
    });
    expect(withBusyRetry(fn, { baseDelayMs: 0 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows non-busy errors immediately without retrying", () => {
    const fn = vi.fn(() => {
      throw new Error("UNIQUE constraint failed");
    });
    expect(() => withBusyRetry(fn, { baseDelayMs: 0 })).toThrow(
      "UNIQUE constraint failed",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows the busy error after exhausting maxRetries", () => {
    const fn = vi.fn(() => {
      throw new Error("database is locked");
    });
    expect(() => withBusyRetry(fn, { maxRetries: 3, baseDelayMs: 0 })).toThrow(
      "database is locked",
    );
    // initial attempt + 3 retries
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
