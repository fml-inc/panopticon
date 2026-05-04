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

function insertConfirmedSession(
  target = "fml",
  opts: {
    syncSeq?: number;
    syncedSeq?: number;
    targetSyncSeq?: number;
    derivedSyncSeq?: number;
    derivedSyncedSeq?: number;
    repository?: string | null;
    wmMessages?: number;
  } = {},
): void {
  const db = getDb();
  const syncSeq = opts.syncSeq ?? 1;
  const targetSyncSeq = opts.targetSyncSeq ?? syncSeq;
  const syncedSeq = opts.syncedSeq ?? targetSyncSeq;
  const derivedSyncSeq = opts.derivedSyncSeq ?? 0;
  const derivedSyncedSeq = opts.derivedSyncedSeq ?? derivedSyncSeq;
  const repository =
    "repository" in opts ? opts.repository : "fml-inc/panopticon";
  const wmMessages = opts.wmMessages ?? 1;
  db.prepare(
    `INSERT INTO sessions (
       session_id, sync_seq, derived_sync_seq, machine, relationship_type
     ) VALUES ('session-1', ?, ?, 'test-machine', 'standalone')`,
  ).run(syncSeq, derivedSyncSeq);
  if (repository !== null) {
    db.prepare(
      `INSERT INTO session_repositories (session_id, repository, first_seen_ms)
       VALUES ('session-1', ?, 0)`,
    ).run(repository);
  }
  db.prepare(
    `INSERT INTO target_session_sync (
       session_id, target, confirmed, sync_seq, synced_seq,
       derived_synced_seq, wm_messages
     ) VALUES ('session-1', ?, 1, ?, ?, ?, ?)`,
  ).run(target, targetSyncSeq, syncedSeq, derivedSyncedSeq, wmMessages);
}

describe("readSyncPending", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(os.tmpdir(), "panopticon-test-sync-pending"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(os.tmpdir(), "panopticon-test-sync-pending", "config.json"),
      JSON.stringify({ sync: { filter: { requireRepo: true }, targets: [] } }),
    );
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

  it("counts session rows that still need target confirmation", () => {
    insertConfirmedSession("fml", {
      syncSeq: 2,
      targetSyncSeq: 1,
      syncedSeq: 1,
      wmMessages: 2,
    });

    const result = readSyncPending("fml");

    expect(result.tables.sessions).toEqual({
      total: 1,
      synced: 0,
      pending: 1,
    });
    expect(result.totalPending).toBe(1);
  });

  it("does not count no-repo session rows skipped by the default sync filter", () => {
    insertConfirmedSession("fml", {
      syncSeq: 2,
      targetSyncSeq: 1,
      syncedSeq: 1,
      repository: null,
      wmMessages: 2,
    });

    const result = readSyncPending("fml");

    expect(result.tables.sessions).toBeUndefined();
    expect(result.totalPending).toBe(0);
  });

  it("counts derived session state that still needs sync", () => {
    insertConfirmedSession("fml", {
      derivedSyncSeq: 2,
      derivedSyncedSeq: 1,
      wmMessages: 2,
    });

    const result = readSyncPending("fml");

    expect(result.tables.session_derived_state).toEqual({
      total: 1,
      synced: 0,
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
