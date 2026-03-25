import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-sync-prune");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "../config.js";
import {
  closeWatermarkDb,
  watermarkKey,
  writeWatermark,
} from "../sync/watermark.js";
import type { RetentionConfig } from "../unified-config.js";
import { closeDb, getDb } from "./schema.js";
import { minWatermarkForTable, syncAwarePrune } from "./sync-prune.js";

function insertHookEvent(
  id: number,
  timestampMs: number,
  sessionId = "sess-1",
): void {
  const db = getDb();
  const payload = gzipSync(Buffer.from(JSON.stringify({ test: true })));
  db.prepare(
    "INSERT INTO hook_events (id, session_id, event_type, timestamp_ms, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(id, sessionId, "PreToolUse", timestampMs, payload);
  db.prepare("INSERT INTO hook_events_fts (rowid, payload) VALUES (?, ?)").run(
    id,
    JSON.stringify({ test: true }),
  );
}

function insertOtelLog(
  id: number,
  timestampNs: number,
  sessionId = "sess-1",
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO otel_logs (id, timestamp_ns, session_id, body) VALUES (?, ?, ?, ?)",
  ).run(id, timestampNs, sessionId, "claude_code.tool_decision");
}

function insertOtelMetric(
  id: number,
  timestampNs: number,
  sessionId = "sess-1",
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO otel_metrics (id, timestamp_ns, name, value, session_id) VALUES (?, ?, ?, ?, ?)",
  ).run(id, timestampNs, "token_usage", 100, sessionId);
}

function countRows(table: string): number {
  return (
    getDb().prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }
  ).c;
}

const targets = [
  { name: "target-a", url: "http://a" },
  { name: "target-b", url: "http://b" },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const oldMs = now - 14 * DAY_MS; // 14 days ago
const recentMs = now - 2 * DAY_MS; // 2 days ago

describe("sync-prune", () => {
  beforeEach(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    getDb(); // initialize schema
  });

  afterEach(() => {
    closeDb();
    closeWatermarkDb();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  describe("minWatermarkForTable", () => {
    it("returns 0 when no targets", () => {
      expect(minWatermarkForTable("hook_events", [])).toBe(0);
    });

    it("returns 0 when any target has watermark 0", () => {
      writeWatermark(watermarkKey("hook_events", "target-a"), 100);
      // target-b has no watermark (defaults to 0)
      expect(minWatermarkForTable("hook_events", targets)).toBe(0);
    });

    it("returns minimum across targets", () => {
      writeWatermark(watermarkKey("hook_events", "target-a"), 50);
      writeWatermark(watermarkKey("hook_events", "target-b"), 100);
      expect(minWatermarkForTable("hook_events", targets)).toBe(50);
    });

    it("returns the watermark when all targets are equal", () => {
      writeWatermark(watermarkKey("hook_events", "target-a"), 75);
      writeWatermark(watermarkKey("hook_events", "target-b"), 75);
      expect(minWatermarkForTable("hook_events", targets)).toBe(75);
    });
  });

  describe("syncAwarePrune", () => {
    const retention: RetentionConfig = {
      maxAgeDays: 90,
      maxSizeMb: 1000,
      syncedMaxAgeDays: 7,
    };

    it("is a no-op when no targets", () => {
      insertHookEvent(1, oldMs);
      const result = syncAwarePrune([], retention);
      expect(result.hook_events).toBe(0);
      expect(countRows("hook_events")).toBe(1);
    });

    it("is a no-op when syncedMaxAgeDays is undefined", () => {
      insertHookEvent(1, oldMs);
      writeWatermark(watermarkKey("hook_events", "target-a"), 10);
      writeWatermark(watermarkKey("hook_events", "target-b"), 10);
      const result = syncAwarePrune(targets, {
        maxAgeDays: 90,
        maxSizeMb: 1000,
      });
      expect(result.hook_events).toBe(0);
      expect(countRows("hook_events")).toBe(1);
    });

    it("is a no-op when any target has watermark 0", () => {
      insertHookEvent(1, oldMs);
      writeWatermark(watermarkKey("hook_events", "target-a"), 10);
      // target-b has no watermark
      const result = syncAwarePrune(targets, retention);
      expect(result.hook_events).toBe(0);
      expect(countRows("hook_events")).toBe(1);
    });

    it("deletes synced hook_events older than syncedMaxAgeDays", () => {
      insertHookEvent(1, oldMs); // old + synced → delete
      insertHookEvent(2, recentMs); // recent + synced → keep

      writeWatermark(watermarkKey("hook_events", "target-a"), 5);
      writeWatermark(watermarkKey("hook_events", "target-b"), 5);

      const result = syncAwarePrune(targets, retention);
      expect(result.hook_events).toBe(1);
      expect(countRows("hook_events")).toBe(1);
      expect(countRows("hook_events_fts")).toBe(1);
    });

    it("does NOT delete rows with id > minWatermark", () => {
      insertHookEvent(1, oldMs); // synced (id=1 <= wm=1) + old → delete
      insertHookEvent(2, oldMs); // NOT synced (id=2 > wm=1) + old → keep

      writeWatermark(watermarkKey("hook_events", "target-a"), 1);
      writeWatermark(watermarkKey("hook_events", "target-b"), 1);

      const result = syncAwarePrune(targets, retention);
      expect(result.hook_events).toBe(1);
      expect(countRows("hook_events")).toBe(1);
    });

    it("deletes synced otel_logs older than syncedMaxAgeDays", () => {
      const oldNs = oldMs * 1_000_000;
      const recentNs = recentMs * 1_000_000;

      insertOtelLog(1, oldNs); // old + synced → delete
      insertOtelLog(2, recentNs); // recent → keep

      writeWatermark(watermarkKey("otel_logs", "target-a"), 5);
      writeWatermark(watermarkKey("otel_logs", "target-b"), 5);

      const result = syncAwarePrune(targets, retention);
      expect(result.otel_logs).toBe(1);
      expect(countRows("otel_logs")).toBe(1);
    });

    it("deletes synced otel_metrics older than syncedMaxAgeDays", () => {
      const oldNs = oldMs * 1_000_000;
      const recentNs = recentMs * 1_000_000;

      insertOtelMetric(1, oldNs);
      insertOtelMetric(2, recentNs);

      writeWatermark(watermarkKey("otel_metrics", "target-a"), 5);
      writeWatermark(watermarkKey("otel_metrics", "target-b"), 5);

      const result = syncAwarePrune(targets, retention);
      expect(result.otel_metrics).toBe(1);
      expect(countRows("otel_metrics")).toBe(1);
    });

    it("handles all tables independently", () => {
      // hook_events: both targets synced
      insertHookEvent(1, oldMs);
      writeWatermark(watermarkKey("hook_events", "target-a"), 5);
      writeWatermark(watermarkKey("hook_events", "target-b"), 5);

      // otel_logs: only one target synced (wm=0 for target-b)
      const oldNs = oldMs * 1_000_000;
      insertOtelLog(1, oldNs);
      writeWatermark(watermarkKey("otel_logs", "target-a"), 5);
      // target-b has no otel_logs watermark

      const result = syncAwarePrune(targets, retention);
      expect(result.hook_events).toBe(1); // pruned
      expect(result.otel_logs).toBe(0); // NOT pruned — target-b hasn't synced
      expect(countRows("otel_logs")).toBe(1);
    });
  });
});
