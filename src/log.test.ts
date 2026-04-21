import { describe, expect, it } from "vitest";
import {
  LOG_LEVEL_IDS,
  parseLogLevelName,
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
