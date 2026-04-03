import { describe, expect, it } from "vitest";
import { TABLE_SYNC_REGISTRY } from "./registry.js";

describe("TABLE_SYNC_REGISTRY", () => {
  it("has exactly 11 table descriptors", () => {
    expect(TABLE_SYNC_REGISTRY).toHaveLength(11);
  });

  it("has unique table names", () => {
    const names = TABLE_SYNC_REGISTRY.map((d) => d.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it("contains the expected tables", () => {
    const names = TABLE_SYNC_REGISTRY.map((d) => d.table);
    expect(names).toContain("sessions");
    expect(names).toContain("messages");
    expect(names).toContain("tool_calls");
    expect(names).toContain("scanner_turns");
    expect(names).toContain("scanner_events");
    expect(names).toContain("hook_events");
    expect(names).toContain("otel_logs");
    expect(names).toContain("otel_metrics");
    expect(names).toContain("otel_spans");
    expect(names).toContain("user_config_snapshots");
    expect(names).toContain("repo_config_snapshots");
  });

  it("all descriptors have required fields", () => {
    for (const desc of TABLE_SYNC_REGISTRY) {
      expect(typeof desc.read).toBe("function");
      expect(typeof desc.table).toBe("string");
      expect(typeof desc.logNoun).toBe("string");
      expect(typeof desc.sessionLinked).toBe("boolean");
    }
  });

  it("session-linked tables are marked correctly", () => {
    const linked = TABLE_SYNC_REGISTRY.filter((d) => d.sessionLinked).map(
      (d) => d.table,
    );
    expect(linked).toContain("sessions");
    expect(linked).toContain("messages");
    expect(linked).toContain("hook_events");
    expect(linked).not.toContain("user_config_snapshots");
    expect(linked).not.toContain("repo_config_snapshots");
  });
});
