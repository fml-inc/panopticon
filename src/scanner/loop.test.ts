import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const discoverMock = vi.fn();
const parseFileMock = vi.fn();

vi.mock("../archive/index.js", () => ({
  getArchiveBackend: () => ({ putSync: vi.fn() }),
}));

vi.mock("../db/schema.js", () => ({
  getDb: vi.fn(() => ({ transaction: (fn: () => void) => fn })),
  markResyncComplete: vi.fn(),
  needsResync: vi.fn(() => false),
}));

vi.mock("../db/store.js", () => ({
  updateSessionMessageCounts: vi.fn(),
}));

vi.mock("../intent/asserters/from_scanner.js", () => ({
  rebuildIntentClaimsFromScanner: vi.fn(() => ({ intents: 0, edits: 0 })),
}));

vi.mock("../intent/asserters/landed_from_disk.js", () => ({
  reconcileLandedClaimsFromDisk: vi.fn(() => ({
    checked: 0,
    activeLoadMs: 0,
    activeIntentsLoaded: 0,
    activeEditsLoaded: 0,
  })),
}));

vi.mock("../intent/project.js", () => ({
  rebuildIntentProjection: vi.fn(() => ({
    intents: 0,
    edits: 0,
    sessionSummaries: 0,
    memberships: 0,
    provenance: 0,
    activeLoadMs: 0,
    activeIntentsLoaded: 0,
    activeEditsLoaded: 0,
  })),
}));

vi.mock("../log.js", () => ({
  log: {
    scanner: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock("../summary/index.js", () => ({
  generateSummariesOnce: vi.fn(),
}));

vi.mock("../targets/registry.js", () => ({
  allTargets: () => [
    {
      id: "fake",
      scanner: {
        discover: discoverMock,
        parseFile: parseFileMock,
        normalizeToolCategory: () => "fake",
      },
    },
  ],
}));

vi.mock("../targets/claude.js", () => ({}));
vi.mock("../targets/codex.js", () => ({}));
vi.mock("../targets/gemini.js", () => ({}));

vi.mock("./store.js", () => ({
  getMaxOrdinal: vi.fn(() => 0),
  getTurnCount: vi.fn(() => 0),
  insertMessages: vi.fn(),
  insertScannerEvents: vi.fn(),
  insertTurns: vi.fn(),
  linkSubagentSessions: vi.fn(() => 0),
  readArchivedSize: vi.fn(() => 0),
  readFileWatermark: vi.fn(() => 0),
  resetFileForReparse: vi.fn(),
  restoreSyncIds: vi.fn(),
  updateSessionTotals: vi.fn(),
  upsertSession: vi.fn(),
  writeArchivedSize: vi.fn(),
  writeFileWatermark: vi.fn(),
}));

vi.mock("./status.js", () => ({
  clearScannerStatus: vi.fn(),
  writeScannerStatus: vi.fn(),
}));

import { scanOnce } from "./loop.js";

describe("scanOnce progress", () => {
  beforeEach(() => {
    discoverMock.mockReset();
    parseFileMock.mockReset();
  });

  it("reports progress across discovered files", () => {
    discoverMock.mockReturnValue([
      { filePath: "a.jsonl" },
      { filePath: "b.jsonl" },
    ]);
    parseFileMock.mockReturnValue(null);
    const onProgress = vi.fn();

    const result = scanOnce({
      profileLabel: "reparse scan",
      progressEveryMs: 0,
      onProgress,
    });

    expect(result.filesScanned).toBe(0);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({
      label: "reparse scan",
      processedFiles: 0,
      discoveredFiles: 2,
      filesScanned: 0,
      newTurns: 0,
      touchedSessions: 0,
    });
    expect(onProgress.mock.calls[1]?.[0]).toMatchObject({
      processedFiles: 1,
      discoveredFiles: 2,
      currentSource: "fake",
    });
    expect(onProgress.mock.calls[2]?.[0]).toMatchObject({
      phase: "files",
      processedFiles: 2,
      discoveredFiles: 2,
      currentSource: "fake",
    });
  });

  it("reports touched-session processing after file scanning", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-loop-test-"));
    const filePath = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(filePath, "fixture");

    discoverMock.mockReturnValue([{ filePath }]);
    parseFileMock.mockReturnValue({
      meta: { sessionId: "session-1" },
      turns: [],
      events: [],
      messages: [],
      newByteOffset: 7,
    });
    const onProgress = vi.fn();

    const result = scanOnce({
      profileLabel: "scan",
      progressEveryMs: 0,
      onProgress,
    });

    expect(result.filesScanned).toBe(1);
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      label: "scan",
      phase: "sessions",
      processedFiles: 1,
      discoveredFiles: 1,
      processedSessions: 1,
      totalSessions: 1,
      currentSessionId: "session-1",
    });
  });
});
