import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const dir = _fs.mkdtempSync(
    _path.join(_os.tmpdir(), "pano-scanner-status-test-"),
  );
  return {
    config: {
      dataDir: dir,
      scannerStatusFile: _path.join(dir, "scanner-status.json"),
    },
    ensureDataDir: () => _fs.mkdirSync(dir, { recursive: true }),
  };
});

import { config } from "../config.js";
import { beginDatabaseRebuildGate } from "../db/rebuild-gate.js";
import {
  clearScannerStatus,
  isDatabaseRebuildPhase,
  readDatabaseRebuildStatus,
  readFreshScannerStatus,
  readScannerStatus,
  writeScannerStatus,
} from "./status.js";

beforeEach(() => {
  clearScannerStatus();
});

afterEach(() => {
  clearScannerStatus();
});

describe("scanner runtime status", () => {
  it("writes and reads scanner progress", () => {
    writeScannerStatus({
      pid: 1234,
      phase: "reparse_scan",
      message: "Scanning raw session files into temp DB...",
      startedAtMs: 100,
      elapsedMs: 1500,
      processedFiles: 25,
      discoveredFiles: 100,
      filesScanned: 25,
      newTurns: 250,
      touchedSessions: 10,
      currentSource: "claude",
    });

    expect(readScannerStatus()).toMatchObject({
      pid: 1234,
      phase: "reparse_scan",
      message: "Scanning raw session files into temp DB...",
      startedAtMs: 100,
      elapsedMs: 1500,
      processedFiles: 25,
      discoveredFiles: 100,
      filesScanned: 25,
      newTurns: 250,
      touchedSessions: 10,
      currentSource: "claude",
    });
  });

  it("clears the status file", () => {
    writeScannerStatus({
      pid: 1234,
      phase: "reparse_copy",
      message: "Copying preserved data...",
      startedAtMs: 100,
      elapsedMs: 2000,
    });

    clearScannerStatus();

    expect(readScannerStatus()).toBeNull();
    expect(config.scannerStatusFile).toBeTruthy();
  });

  it("recognizes fresh database rebuild status", () => {
    const now = Date.now();
    writeScannerStatus({
      pid: process.pid,
      phase: "reparse_finalize",
      message: "Swapping rebuilt database into place...",
      startedAtMs: now - 1000,
      updatedAtMs: now,
      elapsedMs: 1000,
    });

    expect(readFreshScannerStatus()).toMatchObject({
      phase: "reparse_finalize",
    });
    expect(readDatabaseRebuildStatus()).toMatchObject({
      phase: "reparse_finalize",
    });
    expect(isDatabaseRebuildPhase("startup_scan")).toBe(false);
    expect(isDatabaseRebuildPhase("claims_rebuild_projection")).toBe(true);
  });

  it("prefers the parent rebuild gate over scanner status", () => {
    const gate = beginDatabaseRebuildGate({
      phase: "reparse_init",
      message: "Startup scanner worker is running atomic reparse...",
    });

    try {
      expect(readDatabaseRebuildStatus()).toMatchObject({
        source: "parent_gate",
        phase: "reparse_init",
        message: "Startup scanner worker is running atomic reparse...",
      });
    } finally {
      gate.release();
    }

    expect(readDatabaseRebuildStatus()).toBeNull();
  });

  it("keeps stale rebuild status while the owner process is alive", () => {
    const now = Date.now();
    writeScannerStatus({
      pid: process.pid,
      phase: "reparse_scan",
      message: "Scanning raw session files into temp DB...",
      startedAtMs: now - 200_000,
      updatedAtMs: now - 200_000,
      elapsedMs: 200_000,
    });

    expect(readFreshScannerStatus()).toMatchObject({
      phase: "reparse_scan",
    });
    expect(readDatabaseRebuildStatus()).toMatchObject({
      phase: "reparse_scan",
    });
  });

  it("ignores stale rebuild status from a dead process", () => {
    const now = Date.now();
    writeScannerStatus({
      pid: 999999,
      phase: "reparse_scan",
      message: "Scanning raw session files into temp DB...",
      startedAtMs: now - 200_000,
      updatedAtMs: now - 200_000,
      elapsedMs: 200_000,
    });

    expect(readFreshScannerStatus()).toBeNull();
    expect(readDatabaseRebuildStatus()).toBeNull();
  });
});
