import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { originalDataDir, originalHost, originalPort, tmpDir, port } =
  vi.hoisted(() => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/panopticon-test-server-control-${process.pid}`;
    const selectedPort = 32_000 + Math.floor(Math.random() * 1000);
    const originalDataDir = process.env.PANOPTICON_DATA_DIR;
    const originalPort = process.env.PANOPTICON_PORT;
    const originalHost = process.env.PANOPTICON_HOST;
    process.env.PANOPTICON_DATA_DIR = dir;
    process.env.PANOPTICON_PORT = String(selectedPort);
    process.env.PANOPTICON_HOST = "127.0.0.1";
    return {
      originalDataDir,
      originalHost,
      originalPort,
      tmpDir: dir,
      port: selectedPort,
    };
  });

import { config } from "./config.js";
import {
  checkServerHealth,
  formatServerStatus,
  healthCheckHost,
  isPidRunning,
  readPidFileStatus,
  readServerStatus,
  startServerDetached,
  stopServer,
  writeOwnPidFile,
} from "./server-control.js";

describe("server control", () => {
  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.PANOPTICON_DATA_DIR;
    else process.env.PANOPTICON_DATA_DIR = originalDataDir;
    if (originalPort === undefined) delete process.env.PANOPTICON_PORT;
    else process.env.PANOPTICON_PORT = originalPort;
    if (originalHost === undefined) delete process.env.PANOPTICON_HOST;
    else process.env.PANOPTICON_HOST = originalHost;
  });

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("classifies missing, invalid, and live PID files", () => {
    expect(readPidFileStatus()).toMatchObject({
      exists: false,
      valid: false,
      running: false,
      pid: null,
    });

    fs.writeFileSync(config.serverPidFile, "not-a-pid\n");
    expect(readPidFileStatus()).toMatchObject({
      exists: true,
      valid: false,
      running: false,
      pid: null,
    });

    writeOwnPidFile();
    expect(readPidFileStatus()).toMatchObject({
      exists: true,
      valid: true,
      running: true,
      pid: process.pid,
    });
  });

  it("treats EPERM from process probes as running", async () => {
    const err = Object.assign(new Error("denied"), { code: "EPERM" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    try {
      expect(isPidRunning(12_345)).toBe(true);

      fs.writeFileSync(config.serverPidFile, "12345\n");
      await expect(stopServer()).resolves.toEqual({
        status: "permission_denied",
        pid: 12_345,
      });
      expect(fs.existsSync(config.serverPidFile)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it("maps wildcard health-check hosts to loopback addresses", () => {
    expect(healthCheckHost("0.0.0.0")).toBe("127.0.0.1");
    expect(healthCheckHost("::")).toBe("::1");
    expect(healthCheckHost("::1")).toBe("::1");
  });

  it("checks health and includes the server pid", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", port, pid: process.pid }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    try {
      await expect(checkServerHealth()).resolves.toEqual({
        ok: true,
        pid: process.pid,
        port,
      });
      const status = await readServerStatus();
      expect(formatServerStatus(status)).toContain(`PID ${process.pid}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not treat an arbitrary HTTP 200 as panopticon health", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "other" }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    try {
      await expect(checkServerHealth()).resolves.toMatchObject({ ok: false });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("starts a detached server only after health is available, then stops it by health pid", async () => {
    const scriptPath = path.join(tmpDir, "fake-server.mjs");
    fs.writeFileSync(
      scriptPath,
      [
        'import http from "node:http";',
        "const port = Number(process.env.PANOPTICON_PORT);",
        "const server = http.createServer((req, res) => {",
        '  if (req.url === "/health") {',
        '    res.writeHead(200, {"content-type":"application/json"});',
        '    res.end(JSON.stringify({status:"ok", port, pid: process.pid}));',
        "    return;",
        "  }",
        "  res.writeHead(404).end();",
        "});",
        'server.listen(port, "127.0.0.1");',
        'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
        "",
      ].join("\n"),
    );

    const started = await startServerDetached({
      serverScript: scriptPath,
      timeoutMs: 3000,
    });
    try {
      expect(started.status).toBe("started");
      expect(started.pid).toEqual(expect.any(Number));
      await expect(checkServerHealth()).resolves.toMatchObject({ ok: true });

      const stopped = await stopServer({ timeoutMs: 3000 });
      expect(stopped).toEqual({ status: "stopped", pid: started.pid });
      await expect(checkServerHealth()).resolves.toMatchObject({ ok: false });
    } finally {
      await stopServer({ timeoutMs: 1000 });
    }
  });

  it("force kills a server that ignores SIGTERM", async () => {
    const scriptPath = path.join(tmpDir, "stubborn-server.mjs");
    fs.writeFileSync(
      scriptPath,
      [
        'import http from "node:http";',
        "const port = Number(process.env.PANOPTICON_PORT);",
        "const server = http.createServer((req, res) => {",
        '  if (req.url === "/health") {',
        '    res.writeHead(200, {"content-type":"application/json"});',
        '    res.end(JSON.stringify({status:"ok", port, pid: process.pid}));',
        "    return;",
        "  }",
        "  res.writeHead(404).end();",
        "});",
        'server.listen(port, "127.0.0.1");',
        'process.on("SIGTERM", () => {});',
        "",
      ].join("\n"),
    );

    const started = await startServerDetached({
      serverScript: scriptPath,
      timeoutMs: 3000,
    });
    try {
      const stopped = await stopServer({ killTimeoutMs: 3000, timeoutMs: 100 });
      expect(stopped).toEqual({ status: "killed", pid: started.pid });
      await expect(checkServerHealth()).resolves.toMatchObject({ ok: false });
    } finally {
      await stopServer({ killTimeoutMs: 1000, timeoutMs: 100 });
    }
  });
});
