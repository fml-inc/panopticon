/**
 * Integration tests for unified config + sync-aware retention.
 *
 * These exercise the full flow: config loading/migration, data ingest via
 * the real store module, watermark advancement, and sync-aware pruning —
 * all against real SQLite databases in a temp directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-integration");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { config } from "./config.js";
import { pruneEstimate } from "./db/prune.js";
import { closeDb, getDb } from "./db/schema.js";
import {
  insertHookEvent,
  insertOtelLogs,
  insertOtelMetrics,
  upsertSessionCwd,
  upsertSessionRepository,
} from "./db/store.js";
import { syncAwarePrune } from "./db/sync-prune.js";
import {
  addTarget,
  listTargets,
  loadSyncConfig,
  removeTarget,
} from "./sync/config.js";
import { watermarkKey, writeWatermark } from "./sync/watermark.js";
import {
  loadRetentionConfig,
  loadUnifiedConfig,
  saveUnifiedConfig,
} from "./unified-config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

function countRows(table: string): number {
  return (
    getDb().prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as {
      c: number;
    }
  ).c;
}

function seedSession(
  sessionId: string,
  ageMs: number,
  opts: { tools?: string[]; repository?: string } = {},
): void {
  const ts = now - ageMs;
  const tsNs = ts * 1_000_000;
  const repo = opts.repository ?? "org/repo";
  const tools = opts.tools ?? ["Bash", "Read", "Edit"];

  // Hook events: one per tool
  for (const tool of tools) {
    insertHookEvent({
      session_id: sessionId,
      event_type: "PreToolUse",
      timestamp_ms: ts,
      cwd: "/workspace",
      repository: repo,
      tool_name: tool,
      payload: { tool_name: tool, tool_input: { command: "echo hello" } },
    });
  }

  // OTLP logs for the session
  insertOtelLogs([
    {
      timestamp_ns: tsNs,
      session_id: sessionId,
      body: "claude_code.tool_decision",
      severity_text: "INFO",
      attributes: { tool_name: tools[0] },
      resource_attributes: { "repository.full_name": repo },
    },
    {
      timestamp_ns: tsNs + 1_000_000,
      session_id: sessionId,
      body: "claude_code.user_prompt",
      severity_text: "INFO",
      attributes: { prompt: "do something" },
      resource_attributes: { "repository.full_name": repo },
    },
  ]);

  // OTLP metrics
  insertOtelMetrics([
    {
      timestamp_ns: tsNs,
      name: "claude_code_token_usage_tokens",
      value: 1500,
      metric_type: "gauge",
      session_id: sessionId,
      attributes: { type: "input" },
      resource_attributes: { "repository.full_name": repo },
    },
  ]);

  // Session metadata
  upsertSessionRepository(sessionId, repo, ts);
  upsertSessionCwd(sessionId, "/workspace", ts);
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

describe("integration: unified config + sync-aware retention", () => {
  beforeEach(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    getDb(); // initialize schema
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  // ── Unified config ──────────────────────────────────────────────────────

  describe("unified config", () => {
    it("sync CLI commands work through unified config", () => {
      // Simulate user running: panopticon sync add grafana http://grafana:14318
      addTarget({ name: "grafana", url: "http://grafana:14318", token: "tok" });
      addTarget({ name: "datadog", url: "http://dd:4318" });

      // Verify via both APIs
      const targets = listTargets();
      expect(targets).toHaveLength(2);
      const syncCfg = loadSyncConfig();
      expect(syncCfg.targets).toHaveLength(2);
      const unified = loadUnifiedConfig();
      expect(unified.sync.targets).toHaveLength(2);
      expect(unified.retention.maxAgeDays).toBe(90); // defaults present

      // Verify config.json was written
      const raw = JSON.parse(
        fs.readFileSync(path.join(config.dataDir, "config.json"), "utf-8"),
      );
      expect(raw.sync.targets[0].name).toBe("grafana");
      expect(raw.retention.maxAgeDays).toBe(90);

      // Remove a target
      removeTarget("datadog");
      expect(listTargets()).toHaveLength(1);
      expect(loadUnifiedConfig().sync.targets).toHaveLength(1);
    });

    it("retention config round-trips through unified config", () => {
      const cfg = loadUnifiedConfig();
      cfg.retention.syncedMaxAgeDays = 7;
      saveUnifiedConfig(cfg);

      const ret = loadRetentionConfig();
      expect(ret.maxAgeDays).toBe(90);
      expect(ret.maxSizeMb).toBe(1000);
      expect(ret.syncedMaxAgeDays).toBe(7);
    });
  });

  // ── Sync-aware retention ────────────────────────────────────────────────

  describe("sync-aware retention", () => {
    const targets = [
      { name: "grafana", url: "http://grafana:14318" },
      { name: "datadog", url: "http://dd:4318" },
    ];

    it("full lifecycle: ingest → sync watermarks → prune synced data", () => {
      // 1. Ingest data for two sessions at different ages
      seedSession("sess-old", 30 * DAY_MS); // 30 days ago
      seedSession("sess-recent", 2 * DAY_MS); // 2 days ago

      expect(countRows("hook_events")).toBe(6); // 3 tools × 2 sessions
      expect(countRows("otel_logs")).toBe(4); // 2 logs × 2 sessions
      expect(countRows("otel_metrics")).toBe(2); // 1 metric × 2 sessions
      expect(countRows("session_repositories")).toBe(2);
      expect(countRows("session_cwds")).toBe(2);

      // 2. Simulate sync completing for all rows (watermark past max id)
      const maxHookId = (
        getDb().prepare("SELECT MAX(id) as m FROM hook_events").get() as {
          m: number;
        }
      ).m;
      const maxLogId = (
        getDb().prepare("SELECT MAX(id) as m FROM otel_logs").get() as {
          m: number;
        }
      ).m;
      const maxMetricId = (
        getDb().prepare("SELECT MAX(id) as m FROM otel_metrics").get() as {
          m: number;
        }
      ).m;

      for (const t of targets) {
        writeWatermark(watermarkKey("hook_events", t.name), maxHookId);
        writeWatermark(watermarkKey("otel_logs", t.name), maxLogId);
        writeWatermark(watermarkKey("otel_metrics", t.name), maxMetricId);
      }

      // 3. Run sync-aware prune with 7-day window
      const result = syncAwarePrune(targets, {
        maxAgeDays: 90,
        maxSizeMb: 1000,
        syncedMaxAgeDays: 7,
      });

      // Old session (30 days) should be pruned — it's synced AND older than 7 days
      expect(result.hook_events).toBe(3);
      expect(result.otel_logs).toBe(2);
      expect(result.otel_metrics).toBe(1);

      // Recent session (2 days) should survive — it's synced but newer than 7 days
      expect(countRows("hook_events")).toBe(3);
      expect(countRows("otel_logs")).toBe(2);
      expect(countRows("otel_metrics")).toBe(1);

      // Session metadata is local-only — not touched by sync-aware prune
      expect(countRows("session_repositories")).toBe(2);
      expect(countRows("session_cwds")).toBe(2);
    });

    it("does not prune when one target is behind", () => {
      seedSession("sess-old", 30 * DAY_MS);

      const maxHookId = (
        getDb().prepare("SELECT MAX(id) as m FROM hook_events").get() as {
          m: number;
        }
      ).m;

      // Only grafana has synced; datadog hasn't started
      writeWatermark(watermarkKey("hook_events", "grafana"), maxHookId);
      // datadog watermark left at 0 (default)

      const result = syncAwarePrune(targets, {
        maxAgeDays: 90,
        maxSizeMb: 1000,
        syncedMaxAgeDays: 7,
      });

      // Nothing pruned — datadog hasn't synced these rows
      expect(result.hook_events).toBe(0);
      expect(countRows("hook_events")).toBe(3);
    });

    it("partial watermark only prunes up to the minimum", () => {
      // Insert 4 hook events at old timestamps
      for (let i = 0; i < 4; i++) {
        insertHookEvent({
          session_id: "sess-1",
          event_type: "PreToolUse",
          timestamp_ms: now - 30 * DAY_MS,
          tool_name: `Tool${i}`,
          payload: { tool_name: `Tool${i}` },
        });
      }
      expect(countRows("hook_events")).toBe(4);

      // grafana synced all 4, datadog only synced first 2
      writeWatermark(watermarkKey("hook_events", "grafana"), 4);
      writeWatermark(watermarkKey("hook_events", "datadog"), 2);

      const result = syncAwarePrune(targets, {
        maxAgeDays: 90,
        maxSizeMb: 1000,
        syncedMaxAgeDays: 7,
      });

      // Only ids 1-2 are safe to prune (min watermark = 2)
      expect(result.hook_events).toBe(2);
      expect(countRows("hook_events")).toBe(2);
    });

    it("regular prune still works as safety net for unsynced data", () => {
      // Seed data older than 90 days with no sync configured
      seedSession("sess-ancient", 100 * DAY_MS);
      expect(countRows("hook_events")).toBe(3);

      // Regular prune should catch this
      const estimate = pruneEstimate(now - 90 * DAY_MS);
      expect(estimate.hook_events).toBe(3);

      // Sync-aware prune is a no-op (no targets)
      const syncResult = syncAwarePrune([], {
        maxAgeDays: 90,
        maxSizeMb: 1000,
        syncedMaxAgeDays: 7,
      });
      expect(syncResult.hook_events).toBe(0);
    });

    it("tables are pruned independently based on their own watermarks", () => {
      seedSession("sess-old", 30 * DAY_MS);

      const maxHookId = (
        getDb().prepare("SELECT MAX(id) as m FROM hook_events").get() as {
          m: number;
        }
      ).m;
      const maxLogId = (
        getDb().prepare("SELECT MAX(id) as m FROM otel_logs").get() as {
          m: number;
        }
      ).m;

      // Both targets synced hook_events and otel_logs, but NOT metrics
      for (const t of targets) {
        writeWatermark(watermarkKey("hook_events", t.name), maxHookId);
        writeWatermark(watermarkKey("otel_logs", t.name), maxLogId);
        // otel_metrics watermark stays at 0
      }

      const result = syncAwarePrune(targets, {
        maxAgeDays: 90,
        maxSizeMb: 1000,
        syncedMaxAgeDays: 7,
      });

      expect(result.hook_events).toBe(3);
      expect(result.otel_logs).toBe(2);
      expect(result.otel_metrics).toBe(0); // not pruned — metrics not synced
      expect(countRows("otel_metrics")).toBe(1);
    });

    it("FTS index stays consistent after sync-aware prune", () => {
      seedSession("sess-old", 30 * DAY_MS);
      seedSession("sess-recent", 2 * DAY_MS);

      const maxId = (
        getDb().prepare("SELECT MAX(id) as m FROM hook_events").get() as {
          m: number;
        }
      ).m;

      for (const t of targets) {
        writeWatermark(watermarkKey("hook_events", t.name), maxId);
      }

      syncAwarePrune(targets, {
        maxAgeDays: 90,
        maxSizeMb: 1000,
        syncedMaxAgeDays: 7,
      });

      // FTS should only have entries for surviving rows
      const ftsCount = countRows("hook_events_fts");
      const hookCount = countRows("hook_events");
      expect(ftsCount).toBe(hookCount);

      // FTS search should still work on remaining rows
      const results = getDb()
        .prepare(
          "SELECT rowid FROM hook_events_fts WHERE payload MATCH '\"echo\"'",
        )
        .all();
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
