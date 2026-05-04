import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOG_LEVEL_IDS,
  parseLogLevelName,
  rotateLogFileIfNeeded,
  shouldWriteLogAtLevel,
} from "./log.js";

describe("parseLogLevelName", () => {
  it("defaults to info when unset or invalid", () => {
    expect(parseLogLevelName(undefined)).toBe("info");
    expect(parseLogLevelName("")).toBe("info");
    expect(parseLogLevelName("verbose")).toBe("info");
  });

  it("accepts case-insensitive log level names", () => {
    expect(parseLogLevelName("DEBUG")).toBe("debug");
    expect(parseLogLevelName(" Warn ")).toBe("warn");
  });
});

describe("shouldWriteLog", () => {
  it("uses the configured minimum level ordering", () => {
    expect(shouldWriteLogAtLevel("warn", "info")).toBe(false);
    expect(shouldWriteLogAtLevel("warn", "warn")).toBe(true);
    expect(shouldWriteLogAtLevel("warn", "error")).toBe(true);
    expect(LOG_LEVEL_IDS.error).toBeGreaterThan(LOG_LEVEL_IDS.warn);
  });
});

describe("rotateLogFileIfNeeded", () => {
  it("rotates oversized logs and keeps bounded history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-log-test-"));
    try {
      const logPath = path.join(dir, "server.log");
      fs.writeFileSync(logPath, "newest\n");
      fs.writeFileSync(`${logPath}.1`, "older\n");
      fs.writeFileSync(`${logPath}.2`, "oldest\n");

      expect(rotateLogFileIfNeeded(logPath, { maxBytes: 1, maxFiles: 2 })).toBe(
        true,
      );

      expect(fs.existsSync(logPath)).toBe(false);
      expect(fs.readFileSync(`${logPath}.1`, "utf-8")).toBe("newest\n");
      expect(fs.readFileSync(`${logPath}.2`, "utf-8")).toBe("older\n");
      expect(fs.existsSync(`${logPath}.3`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves logs below the rotation threshold untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-log-test-"));
    try {
      const logPath = path.join(dir, "server.log");
      fs.writeFileSync(logPath, "small\n");

      expect(
        rotateLogFileIfNeeded(logPath, { maxBytes: 1024, maxFiles: 2 }),
      ).toBe(false);
      expect(fs.readFileSync(logPath, "utf-8")).toBe("small\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
