import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("api util server liveness", () => {
  let tmpDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-api-util-"));
    savedDataDir = process.env.PANOPTICON_DATA_DIR;
    process.env.PANOPTICON_DATA_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedDataDir === undefined) delete process.env.PANOPTICON_DATA_DIR;
    else process.env.PANOPTICON_DATA_DIR = savedDataDir;
    vi.restoreAllMocks();
  });

  it("reports a live pid separately from health", async () => {
    const { config } = await import("../config.js");
    const { checkServerHealth, getServerProcessStatus } = await import(
      "./util.js"
    );

    fs.writeFileSync(config.serverPidFile, String(process.pid));

    const processStatus = getServerProcessStatus();
    const health = await checkServerHealth(9, 50);

    expect(processStatus).toMatchObject({
      pidFileExists: true,
      pid: process.pid,
      processRunning: true,
      stalePidFileRemoved: false,
    });
    expect(health.healthy).toBe(false);
    expect(health.statusCode).toBeNull();
    expect(health.error).toBeTruthy();
  });

  it("returns healthy only when the health endpoint responds successfully", async () => {
    const { checkServerHealth } = await import("./util.js");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp server address");
    }

    try {
      const health = await checkServerHealth(address.port, 500);
      expect(health).toMatchObject({
        healthy: true,
        statusCode: 200,
        error: null,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
