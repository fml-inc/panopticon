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

import { config } from "../config.js";
import { Database } from "../db/driver.js";
import {
  closeDb,
  getDb,
  markClaimsRebuildComplete,
  markResyncComplete,
  needsClaimsRebuild,
  needsRawDataResync,
  needsResync,
  SCANNER_DATA_VERSION,
  staleDataComponents,
} from "../db/schema.js";

beforeEach(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${config.dbPath}${suffix}`);
    } catch {}
  }
});

afterEach(() => {
  closeDb();
});

describe("data version registry", () => {
  it("fresh empty DB boots with current component versions", () => {
    getDb();

    expect(needsResync()).toBe(false);
    expect(needsRawDataResync()).toBe(false);
    expect(needsClaimsRebuild()).toBe(false);
    expect(staleDataComponents()).toEqual([]);
  });

  it("treats populated DBs missing data_versions as fully stale", () => {
    const db = getDb();
    db.prepare(`INSERT INTO sessions (session_id) VALUES (?)`).run("session-1");
    closeDb();

    const raw = new Database(config.dbPath);
    raw.prepare(`DELETE FROM data_versions`).run();
    raw.close();

    getDb();

    expect(needsResync()).toBe(true);
    expect(needsRawDataResync()).toBe(true);
    expect(needsClaimsRebuild()).toBe(true);
    expect(staleDataComponents()).toEqual([
      "scanner.raw",
      "intent.from_scanner",
      "intent.from_hooks",
      "intent.landed_from_disk",
      "claims.active",
      "claims.projection",
    ]);
  });

  it("markClaimsRebuildComplete clears claim-component staleness", () => {
    getDb();
    const raw = new Database(config.dbPath);
    const now = Date.now();
    raw
      .prepare(
        `UPDATE data_versions
       SET version = ?, updated_at_ms = ?
       WHERE component IN (?, ?, ?, ?, ?)`,
      )
      .run(
        0,
        now,
        "intent.from_scanner",
        "intent.from_hooks",
        "intent.landed_from_disk",
        "claims.active",
        "claims.projection",
      );
    raw.close();
    closeDb();

    getDb();
    expect(needsClaimsRebuild()).toBe(true);
    expect(needsRawDataResync()).toBe(false);

    markClaimsRebuildComplete();

    expect(needsResync()).toBe(false);
    expect(needsClaimsRebuild()).toBe(false);
    expect(needsRawDataResync()).toBe(false);
  });

  it("markResyncComplete stamps the raw scanner component current", () => {
    getDb();
    const raw = new Database(config.dbPath);
    raw
      .prepare(
        `INSERT INTO data_versions (component, version, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(component) DO UPDATE SET
         version = excluded.version,
         updated_at_ms = excluded.updated_at_ms`,
      )
      .run("scanner.raw", 0, Date.now());
    raw.close();
    closeDb();

    getDb();
    expect(needsRawDataResync()).toBe(true);

    markResyncComplete();

    expect(needsRawDataResync()).toBe(false);
    expect(needsResync()).toBe(false);

    const reopened = new Database(config.dbPath);
    const versionRow = reopened
      .prepare(`SELECT version FROM data_versions WHERE component = ?`)
      .get("scanner.raw") as { version: number };
    reopened.close();

    expect(versionRow.version).toBe(SCANNER_DATA_VERSION);
  });

  it("higher raw component versions do not trigger resync", () => {
    getDb();
    markResyncComplete();
    markClaimsRebuildComplete();
    closeDb();

    const raw = new Database(config.dbPath);
    raw
      .prepare(
        `UPDATE data_versions
       SET version = ?, updated_at_ms = ?
       WHERE component = ?`,
      )
      .run(SCANNER_DATA_VERSION + 10, Date.now(), "scanner.raw");
    raw.close();

    getDb();

    expect(needsRawDataResync()).toBe(false);
    expect(needsResync()).toBe(false);
  });
});
