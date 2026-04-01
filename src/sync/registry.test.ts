import { describe, expect, it } from "vitest";
import { TABLE_SYNC_REGISTRY } from "./registry.js";

describe("TABLE_SYNC_REGISTRY", () => {
  it("has exactly 6 table descriptors", () => {
    expect(TABLE_SYNC_REGISTRY).toHaveLength(6);
  });

  it("has unique table names", () => {
    const names = TABLE_SYNC_REGISTRY.map((d) => d.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it("contains the expected tables in order", () => {
    const names = TABLE_SYNC_REGISTRY.map((d) => d.table);
    expect(names).toEqual([
      "hook_events",
      "otel_logs",
      "otel_metrics",
      "scanner_turns",
      "scanner_events",
      "otel_spans",
    ]);
  });

  it("all endpoints start with /v1/", () => {
    for (const desc of TABLE_SYNC_REGISTRY) {
      expect(desc.endpoint).toMatch(/^\/v1\//);
    }
  });

  it("all descriptors have required functions", () => {
    for (const desc of TABLE_SYNC_REGISTRY) {
      expect(typeof desc.read).toBe("function");
      expect(typeof desc.serialize).toBe("function");
      expect(typeof desc.table).toBe("string");
      expect(typeof desc.logNoun).toBe("string");
      expect(typeof desc.endpoint).toBe("string");
    }
  });

  it("hook_events, otel_logs, otel_metrics have extractRepo", () => {
    const withRepo = TABLE_SYNC_REGISTRY.filter((d) => d.extractRepo);
    expect(withRepo.map((d) => d.table)).toEqual([
      "hook_events",
      "otel_logs",
      "otel_metrics",
    ]);
  });

  it("scanner_turns, scanner_events, otel_spans have no extractRepo", () => {
    const withoutRepo = TABLE_SYNC_REGISTRY.filter((d) => !d.extractRepo);
    expect(withoutRepo.map((d) => d.table)).toEqual([
      "scanner_turns",
      "scanner_events",
      "otel_spans",
    ]);
  });
});
