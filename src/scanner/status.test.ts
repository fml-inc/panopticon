import { describe, expect, it, vi } from "vitest";

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
import {
  clearScannerStatus,
  readScannerStatus,
  writeScannerStatus,
} from "./status.js";

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
});
