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
  needsClaimsRebuild: vi.fn(() => false),
  needsRawDataResync: vi.fn(() => false),
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
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
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
  getEventCount: vi.fn(() => 0),
  insertMessages: vi.fn(),
  insertScannerEvents: vi.fn(),
  insertTurns: vi.fn(),
  linkSubagentSessions: vi.fn(() => 0),
  readArchivedSize: vi.fn(() => 0),
  readFileWatermark: vi.fn(() => ({ byteOffset: 0 })),
  readSessionIdByScannerFile: vi.fn(() => undefined),
  resetFileForReparse: vi.fn(),
  restoreSyncIds: vi.fn(),
  // Pure function — keep the real implementation so the loop's
  // file-rotation guard exercises real logic.
  shouldResetWatermark: (fileSize: number, watermarkOffset: number) =>
    watermarkOffset > 0 && fileSize < watermarkOffset,
  updateSessionTotals: vi.fn(),
  upsertSession: vi.fn(),
  writeArchivedSize: vi.fn(),
  writeFileWatermark: vi.fn(),
}));

vi.mock("./status.js", () => ({
  clearScannerStatus: vi.fn(),
  writeScannerStatus: vi.fn(),
}));

vi.mock("./claims-rebuild.js", () => ({
  rebuildClaimsDerivedState: vi.fn(),
}));

import { captureException } from "../sentry.js";
import { scanOnce } from "./loop.js";
import {
  insertMessages,
  insertTurns,
  readFileWatermark,
  readSessionIdByScannerFile,
  upsertSession,
  writeFileWatermark,
} from "./store.js";

describe("scanOnce progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverMock.mockReset();
    parseFileMock.mockReset();
    vi.mocked(readFileWatermark).mockReturnValue({ byteOffset: 0 });
    vi.mocked(readSessionIdByScannerFile).mockReturnValue(undefined);
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

  it("rehydrates incremental chunks from the existing session row", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-loop-test-"));
    const filePath = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(filePath, "fixture");

    discoverMock.mockReturnValue([{ filePath }]);
    vi.mocked(readFileWatermark).mockReturnValue({
      byteOffset: 7,
      sessionId: "session-1",
    });
    parseFileMock.mockReturnValue({
      turns: [
        {
          sessionId: "",
          turnIndex: 0,
          timestampMs: 10,
          role: "assistant",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
      ],
      events: [
        {
          sessionId: "",
          eventType: "agent_message",
          timestampMs: 11,
        },
      ],
      messages: [
        {
          sessionId: "",
          ordinal: 0,
          role: "assistant",
          content: "hello",
          timestampMs: 12,
          hasThinking: false,
          hasToolUse: false,
          isSystem: false,
          contentLength: 5,
          hasContextTokens: false,
          hasOutputTokens: false,
          toolCalls: [],
          toolResults: new Map(),
        },
      ],
      newByteOffset: 42,
    });

    const result = scanOnce();

    expect(result.filesScanned).toBe(1);
    expect(vi.mocked(upsertSession)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      filePath,
      "fake",
    );
    expect(vi.mocked(insertTurns)).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          sessionId: "session-1",
          turnIndex: 0,
        }),
      ],
      "fake",
    );
    expect(vi.mocked(insertMessages)).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          sessionId: "session-1",
          ordinal: 1,
        }),
      ],
      undefined,
    );
    expect(vi.mocked(readSessionIdByScannerFile)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileWatermark)).toHaveBeenCalledWith(
      filePath,
      42,
      "session-1",
    );
  });

  it("falls back to the existing session row when the watermark has no session id", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-loop-test-"));
    const filePath = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(filePath, "fixture");

    discoverMock.mockReturnValue([{ filePath }]);
    vi.mocked(readFileWatermark).mockReturnValue({ byteOffset: 7 });
    vi.mocked(readSessionIdByScannerFile).mockReturnValue("session-2");
    parseFileMock.mockReturnValue({
      turns: [],
      events: [],
      messages: [],
      newByteOffset: 42,
    });

    scanOnce();

    expect(vi.mocked(readSessionIdByScannerFile)).toHaveBeenCalledWith(
      filePath,
      "fake",
    );
    expect(vi.mocked(writeFileWatermark)).toHaveBeenCalledWith(
      filePath,
      42,
      "session-2",
    );
  });

  it("reports incremental chunks that still have no session metadata", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-loop-test-"));
    const filePath = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(filePath, "fixture");

    discoverMock.mockReturnValue([{ filePath }]);
    vi.mocked(readFileWatermark).mockReturnValue({ byteOffset: 7 });
    vi.mocked(readSessionIdByScannerFile).mockReturnValue(undefined);
    parseFileMock.mockReturnValue({
      turns: [],
      events: [],
      messages: [],
      newByteOffset: 42,
    });

    const result = scanOnce();

    expect(result.filesScanned).toBe(1);
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        component: "scanner",
        file_path: filePath,
        source: "fake",
        byte_offset: 7,
        new_byte_offset: 42,
      }),
    );
    expect(vi.mocked(writeFileWatermark)).toHaveBeenCalledWith(
      filePath,
      42,
      undefined,
    );
    expect(vi.mocked(upsertSession)).not.toHaveBeenCalled();
  });
});
