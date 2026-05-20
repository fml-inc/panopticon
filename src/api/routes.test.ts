import type http from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  needsResyncMock,
  readDatabaseRebuildStatusMock,
  readScannerStatusMock,
  dispatchToolMock,
  dispatchExecMock,
} = vi.hoisted(() => ({
  needsResyncMock: vi.fn(),
  readDatabaseRebuildStatusMock: vi.fn(),
  readScannerStatusMock: vi.fn(),
  dispatchToolMock: vi.fn(),
  dispatchExecMock: vi.fn(),
}));

vi.mock("../db/schema.js", () => ({
  needsResync: needsResyncMock,
}));

vi.mock("../scanner/status.js", () => ({
  readDatabaseRebuildStatus: readDatabaseRebuildStatusMock,
  readScannerStatus: readScannerStatusMock,
}));

vi.mock("../service/index.js", () => ({
  directPanopticonService: {},
  dispatchExec: dispatchExecMock,
  dispatchTool: dispatchToolMock,
  EXEC_NAMES: ["scan"],
  TOOL_NAMES: ["intent_for_code", "query", "status"],
  isExecName: (name: string) => name === "scan",
  isToolName: (name: string) =>
    name === "intent_for_code" || name === "query" || name === "status",
}));

import { handleApiRequest } from "./routes.js";

function makeReq(
  url: string,
  body: Record<string, unknown>,
): http.IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { url }) as http.IncomingMessage;
}

function makeRes(): http.ServerResponse & {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  const res: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    writeHead: (status: number, headers: Record<string, string>) => unknown;
    end: (chunk?: string) => unknown;
  } = {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    end(chunk?: string) {
      if (chunk) {
        res.body += chunk;
      }
      return res;
    },
  };
  return res as unknown as http.ServerResponse & {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
}

describe("api route resync gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    needsResyncMock.mockReturnValue(false);
    readDatabaseRebuildStatusMock.mockReturnValue(null);
    readScannerStatusMock.mockReturnValue(null);
    dispatchToolMock.mockResolvedValue({ ok: true });
    dispatchExecMock.mockResolvedValue({ ok: true });
  });

  it("returns 503 for derived tools while resync is pending", async () => {
    needsResyncMock.mockReturnValue(true);
    readScannerStatusMock.mockReturnValue({
      phase: "reparse_derive",
      message: "Rebuilding derived state from raw data...",
    });

    const req = makeReq("/api/tool", {
      name: "intent_for_code",
      params: { file_path: "src/server.ts" },
    });
    const res = makeRes();

    await handleApiRequest(req, res);

    expect(res.statusCode).toBe(503);
    expect(dispatchToolMock).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      error: expect.stringMatching(/rebuilding derived state/i),
      phase: "reparse_derive",
      message: "Rebuilding derived state from raw data...",
    });
  });

  it("still allows raw tools while resync is pending", async () => {
    needsResyncMock.mockReturnValue(true);
    dispatchToolMock.mockResolvedValue({ rows: [] });

    const req = makeReq("/api/tool", {
      name: "query",
      params: { sql: "SELECT 1" },
    });
    const res = makeRes();

    await handleApiRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(dispatchToolMock).toHaveBeenCalledWith({}, "query", {
      sql: "SELECT 1",
    });
    expect(JSON.parse(res.body)).toEqual({ rows: [] });
  });

  it("blocks raw tools while the database file is being rebuilt", async () => {
    readDatabaseRebuildStatusMock.mockReturnValue({
      phase: "reparse_finalize",
      message: "Swapping rebuilt database into place...",
      updatedAtMs: Date.now(),
      startedAtMs: Date.now() - 1000,
    });

    const req = makeReq("/api/tool", {
      name: "query",
      params: { sql: "SELECT 1" },
    });
    const res = makeRes();

    await handleApiRequest(req, res);

    expect(res.statusCode).toBe(503);
    expect(dispatchToolMock).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      error: expect.stringMatching(/rebuilding derived state/i),
      phase: "reparse_finalize",
    });
  });

  it("returns scanner status instead of opening db stats during rebuild", async () => {
    readDatabaseRebuildStatusMock.mockReturnValue({
      phase: "reparse_scan",
      message: "Scanning raw session files into temp DB...",
      updatedAtMs: 123,
      startedAtMs: 100,
    });

    const req = makeReq("/api/tool", { name: "status", params: {} });
    const res = makeRes();

    await handleApiRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(dispatchToolMock).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      database_stats_unavailable: true,
      scanner: {
        phase: "reparse_scan",
        message: "Scanning raw session files into temp DB...",
      },
    });
  });
});
