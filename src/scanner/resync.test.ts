import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const dir = _fs.mkdtempSync(
    _path.join(_os.tmpdir(), "pano-resync-test-cfg-"),
  );
  return {
    config: {
      dataDir: dir,
      dbPath: _path.join(dir, "panopticon.db"),
      port: 14318,
      host: "127.0.0.1",
      serverPidFile: "",
    },
    ensureDataDir: () => _fs.mkdirSync(dir, { recursive: true }),
  };
});

import Database from "better-sqlite3";
import { config } from "../config.js";
import {
  closeDb,
  getDb,
  markResyncComplete,
  needsResync,
  SCANNER_DATA_VERSION,
} from "../db/schema.js";

beforeEach(() => {
  // Reset DB for each test
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

describe("data version", () => {
  it("fresh DB needs resync (user_version = 0)", () => {
    getDb();
    expect(needsResync()).toBe(true);
  });

  it("markResyncComplete stamps version and clears flag", () => {
    const db = getDb();
    expect(needsResync()).toBe(true);

    markResyncComplete();
    expect(needsResync()).toBe(false);

    const v = db.pragma("user_version", { simple: true }) as number;
    expect(v).toBe(SCANNER_DATA_VERSION);
  });

  it("reopening stamped DB does not need resync", () => {
    getDb();
    markResyncComplete();
    closeDb();

    getDb();
    expect(needsResync()).toBe(false);
  });

  it("stale version triggers needsResync", () => {
    getDb();
    markResyncComplete();
    closeDb();

    // Simulate old data version
    const raw = new Database(config.dbPath);
    raw.pragma("user_version = 0");
    raw.close();

    getDb();
    expect(needsResync()).toBe(true);
  });

  it("higher user_version does not trigger resync", () => {
    getDb();
    markResyncComplete();
    closeDb();

    // Simulate a newer build left a higher version
    const raw = new Database(config.dbPath);
    raw.pragma(`user_version = ${SCANNER_DATA_VERSION + 10}`);
    raw.close();

    getDb();
    expect(needsResync()).toBe(false);
  });
});
