import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const dir = _fs.mkdtempSync(
    _path.join(_os.tmpdir(), "pano-reparse-derived-test-"),
  );
  return {
    config: {
      dataDir: dir,
      dbPath: _path.join(dir, "panopticon.db"),
      scannerStatusFile: _path.join(dir, "scanner-status.json"),
      port: 14318,
      host: "127.0.0.1",
      serverPidFile: "",
      enableSessionSummaryProjections: false,
    },
    ensureDataDir: () => _fs.mkdirSync(dir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { insertHookEvent, upsertSession } from "../db/store.js";
import { buildMessageSyncId } from "../db/sync-ids.js";
import {
  rebuildDerivedStateFromRaw,
  rewindTargetSessionSyncForScannerReparse,
} from "./reparse.js";

beforeEach(() => {
  closeDb();
  try {
    fs.unlinkSync(config.dbPath);
  } catch {}
  try {
    fs.unlinkSync(`${config.dbPath}-wal`);
  } catch {}
  try {
    fs.unlinkSync(`${config.dbPath}-shm`);
  } catch {}
});

afterEach(() => {
  closeDb();
});

describe("rebuildDerivedStateFromRaw", () => {
  it("rebuilds hook-derived intents and edits idempotently", () => {
    const db = getDb();
    const sessionId = "hook-reparse-session";
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pano-reparse-derived-scratch-"),
    );
    const filePath = path.join(scratchDir, "hook-edit.ts");
    fs.writeFileSync(filePath, "new text");

    upsertSession({
      session_id: sessionId,
      target: "claude",
      started_at_ms: 1_700_000_000_000,
      first_prompt: "change file",
      has_hooks: 1,
    });

    db.prepare(
      `INSERT INTO messages (session_id, ordinal, role, content, timestamp_ms, is_system, sync_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      0,
      "user",
      "change file",
      1_700_000_000_000,
      0,
      buildMessageSyncId(sessionId, 0),
    );

    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1_700_000_000_000,
      cwd: scratchDir,
      repository: scratchDir,
      target: "claude-code",
      payload: { prompt: "change file", session_id: sessionId },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1_700_000_000_100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      target: "claude-code",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: filePath,
          old_string: "old text",
          new_string: "new text",
        },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "Stop",
      timestamp_ms: 1_700_000_000_200,
      cwd: scratchDir,
      repository: scratchDir,
      target: "claude-code",
      payload: { session_id: sessionId },
    });

    const first = rebuildDerivedStateFromRaw();
    const countsAfterFirst = db
      .prepare(
        `SELECT COUNT(DISTINCT iu.id) AS intents,
                COUNT(ie.id) AS edits,
                SUM(CASE WHEN ie.landed = 1 THEN 1 ELSE 0 END) AS landed_edits
         FROM intent_units iu
         LEFT JOIN intent_edits ie ON ie.intent_unit_id = iu.id
         WHERE iu.session_id = ?`,
      )
      .get(sessionId) as {
      intents: number;
      edits: number;
      landed_edits: number | null;
    };

    expect(first.hookPrompts).toBe(1);
    expect(first.hookEdits).toBe(1);
    expect(first.projectedIntents).toBe(1);
    expect(first.projectedEdits).toBe(1);
    expect(countsAfterFirst).toEqual({
      intents: 1,
      edits: 1,
      landed_edits: 1,
    });

    const second = rebuildDerivedStateFromRaw();
    const countsAfterSecond = db
      .prepare(
        `SELECT COUNT(DISTINCT iu.id) AS intents,
                COUNT(ie.id) AS edits,
                SUM(CASE WHEN ie.landed = 1 THEN 1 ELSE 0 END) AS landed_edits
         FROM intent_units iu
         LEFT JOIN intent_edits ie ON ie.intent_unit_id = iu.id
         WHERE iu.session_id = ?`,
      )
      .get(sessionId) as {
      intents: number;
      edits: number;
      landed_edits: number | null;
    };

    expect(second.projectedIntents).toBe(1);
    expect(second.projectedEdits).toBe(1);
    expect(countsAfterSecond).toEqual(countsAfterFirst);

    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
});

describe("rewindTargetSessionSyncForScannerReparse", () => {
  it("rewinds only scanner-owned session sync state", () => {
    const db = getDb();

    db.prepare(
      `INSERT INTO sessions (session_id, sync_seq, has_scanner, has_hooks, machine, relationship_type)
       VALUES (?, ?, ?, ?, 'local', 'standalone')`,
    ).run("scanner-session", 5, 1, 1);
    db.prepare(
      `INSERT INTO sessions (session_id, sync_seq, has_scanner, has_hooks, machine, relationship_type)
       VALUES (?, ?, ?, ?, 'local', 'standalone')`,
    ).run("hooks-only-session", 7, 0, 1);

    db.prepare(
      `INSERT INTO target_session_sync (
         session_id, target, confirmed, sync_seq, synced_seq,
         wm_messages, wm_tool_calls, wm_scanner_turns, wm_scanner_events,
         wm_hook_events, wm_otel_logs, wm_otel_metrics, wm_otel_spans
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "scanner-session",
      "fml",
      99,
      99,
      101,
      102,
      103,
      104,
      205,
      206,
      207,
      208,
    );
    db.prepare(
      `INSERT INTO target_session_sync (
         session_id, target, confirmed, sync_seq, synced_seq,
         wm_messages, wm_tool_calls, wm_scanner_turns, wm_scanner_events,
         wm_hook_events, wm_otel_logs, wm_otel_metrics, wm_otel_spans
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "hooks-only-session",
      "fml",
      88,
      88,
      111,
      112,
      113,
      114,
      215,
      216,
      217,
      218,
    );

    const rewound = rewindTargetSessionSyncForScannerReparse(db);
    expect(rewound.rewoundRows).toBe(1);

    const scannerRow = db
      .prepare("SELECT * FROM target_session_sync WHERE session_id = ?")
      .get("scanner-session") as {
      sync_seq: number;
      synced_seq: number;
      wm_messages: number;
      wm_tool_calls: number;
      wm_scanner_turns: number;
      wm_scanner_events: number;
      wm_hook_events: number;
      wm_otel_logs: number;
      wm_otel_metrics: number;
      wm_otel_spans: number;
    };
    expect(scannerRow).toMatchObject({
      sync_seq: 4,
      synced_seq: 4,
      wm_messages: 0,
      wm_tool_calls: 0,
      wm_scanner_turns: 0,
      wm_scanner_events: 0,
      wm_hook_events: 205,
      wm_otel_logs: 206,
      wm_otel_metrics: 207,
      wm_otel_spans: 208,
    });

    const hooksOnlyRow = db
      .prepare("SELECT * FROM target_session_sync WHERE session_id = ?")
      .get("hooks-only-session") as {
      sync_seq: number;
      synced_seq: number;
      wm_messages: number;
      wm_tool_calls: number;
      wm_scanner_turns: number;
      wm_scanner_events: number;
      wm_hook_events: number;
      wm_otel_logs: number;
      wm_otel_metrics: number;
      wm_otel_spans: number;
    };
    expect(hooksOnlyRow).toMatchObject({
      sync_seq: 88,
      synced_seq: 88,
      wm_messages: 111,
      wm_tool_calls: 112,
      wm_scanner_turns: 113,
      wm_scanner_events: 114,
      wm_hook_events: 215,
      wm_otel_logs: 216,
      wm_otel_metrics: 217,
      wm_otel_spans: 218,
    });
  });
});
