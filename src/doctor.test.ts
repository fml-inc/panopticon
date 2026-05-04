import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-doctor");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
      port: 4318,
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

vi.mock("./targets/index.js", () => ({
  allTargets: () => [],
}));

import { closeDb, getDb } from "./db/schema.js";
import { readSyncTargetLabel } from "./doctor.js";

function insertSyncedSession(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (
       session_id, sync_seq, derived_sync_seq, machine, relationship_type
     ) VALUES ('session-1', 5, 2, 'test-machine', 'standalone')`,
  ).run();
  db.prepare(
    `INSERT INTO target_session_sync (
       session_id, target, confirmed, sync_seq, synced_seq,
       derived_synced_seq, wm_messages
     ) VALUES ('session-1', 'fml', 1, 5, 5, 2, 1)`,
  ).run();
}

describe("readSyncTargetLabel", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(os.tmpdir(), "panopticon-test-doctor"), {
      recursive: true,
    });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(path.join(os.tmpdir(), "panopticon-test-doctor"), {
      recursive: true,
      force: true,
    });
  });

  it("reports pending rows from target_session_sync watermarks", () => {
    const db = getDb();
    insertSyncedSession();
    db.prepare(
      `INSERT INTO messages (id, session_id, ordinal, role, content, sync_id)
       VALUES (1, 'session-1', 1, 'assistant', 'one', 'msg-1'),
              (2, 'session-1', 2, 'assistant', 'two', 'msg-2')`,
    ).run();

    expect(readSyncTargetLabel("fml")).toBe(
      "1 session confirmed, 1 row pending",
    );
  });

  it("reports pending session-level derived state", () => {
    const db = getDb();
    insertSyncedSession();
    db.prepare(
      "UPDATE target_session_sync SET derived_synced_seq = 1, wm_messages = 2",
    ).run();

    expect(readSyncTargetLabel("fml")).toBe(
      "1 session confirmed, 1 session pending",
    );
  });
});
