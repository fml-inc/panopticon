import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-sync-pending");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { closeDb, getDb } from "../db/schema.js";
import { readSyncPending } from "./pending.js";
import { watermarkKey, writeWatermark } from "./watermark.js";

function insertConfirmedSession(target = "fml"): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (session_id, sync_seq, machine, relationship_type)
     VALUES ('session-1', 1, 'test-machine', 'standalone')`,
  ).run();
  db.prepare(
    `INSERT INTO target_session_sync (
       session_id, target, confirmed, sync_seq, synced_seq, wm_messages
     ) VALUES ('session-1', ?, 1, 1, 1, 1)`,
  ).run(target);
}

describe("readSyncPending", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(os.tmpdir(), "panopticon-test-sync-pending"), {
      recursive: true,
    });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(path.join(os.tmpdir(), "panopticon-test-sync-pending"), {
      recursive: true,
      force: true,
    });
  });

  it("counts session-linked rows using target_session_sync watermarks", () => {
    const db = getDb();
    insertConfirmedSession();
    db.prepare(
      `INSERT INTO messages (id, session_id, ordinal, role, content, sync_id)
       VALUES (1, 'session-1', 1, 'assistant', 'one', 'msg-1'),
              (2, 'session-1', 2, 'assistant', 'two', 'msg-2')`,
    ).run();

    const result = readSyncPending("fml");

    expect(result.tables.messages).toEqual({
      total: 2,
      synced: 1,
      pending: 1,
    });
    expect(result.totalPending).toBe(1);
  });

  it("counts non-session tables using global watermarks", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO user_config_snapshots (
         id, device_name, snapshot_at_ms, content_hash
       ) VALUES (1, 'test-device', 0, 'hash-1'),
                (2, 'test-device', 1, 'hash-2')`,
    ).run();
    writeWatermark(watermarkKey("user_config_snapshots", "fml"), 1);

    const result = readSyncPending("fml");

    expect(result.tables.user_config_snapshots).toEqual({
      total: 2,
      synced: 1,
      pending: 1,
    });
    expect(result.totalPending).toBe(1);
  });
});
