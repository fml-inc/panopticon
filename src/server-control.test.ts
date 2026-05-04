import { spawn } from "node:child_process";
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
  assertServerStartBackoffInactive,
  checkServerHealth,
  clearServerStartBackoff,
  formatServerStatus,
  healthCheckHost,
  isPidRunning,
  readPidFileStatus,
  readServerStartBackoffStatus,
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

      fs.writeFileSync(config.serverPidFile, `${process.pid}\n`);
      const alreadyRunning = await startServerDetached({
        serverScript: scriptPath,
        timeoutMs: 3000,
      });
      expect(alreadyRunning).toMatchObject({
        status: "already_running",
        pid: started.pid,
      });
      expect(fs.readFileSync(config.serverPidFile, "utf-8").trim()).toBe(
        String(started.pid),
      );

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
      expect(stopped).toEqual({
        status: process.platform === "win32" ? "stopped" : "killed",
        pid: started.pid,
      });
      await expect(checkServerHealth()).resolves.toMatchObject({ ok: false });
    } finally {
      await stopServer({ killTimeoutMs: 1000, timeoutMs: 100 });
    }
  });

  it("stops an unhealthy PID-file process before starting a replacement", async () => {
    const idleScript = path.join(tmpDir, "idle-process.mjs");
    fs.writeFileSync(
      idleScript,
      [
        "setInterval(() => {}, 1000);",
        'process.on("SIGTERM", () => process.exit(0));',
        "",
      ].join("\n"),
    );
    const idle = spawn(process.execPath, [idleScript], {
      stdio: "ignore",
      windowsHide: true,
    });
    const idleExited = new Promise<boolean>((resolve) => {
      idle.once("exit", () => resolve(true));
    });
    expect(idle.pid).toEqual(expect.any(Number));
    fs.writeFileSync(config.serverPidFile, `${idle.pid}\n`);

    const serverScript = path.join(tmpDir, "replacement-server.mjs");
    fs.writeFileSync(
      serverScript,
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
      serverScript,
      timeoutMs: 3000,
    });
    try {
      expect(started.status).toBe("started");
      await expect(
        Promise.race([
          idleExited,
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 1000),
          ),
        ]),
      ).resolves.toBe(true);
      await expect(checkServerHealth()).resolves.toMatchObject({ ok: true });
    } finally {
      if (idle.pid && isPidRunning(idle.pid)) {
        try {
          process.kill(idle.pid, "SIGKILL");
        } catch {}
      }
      await stopServer({ timeoutMs: 1000 });
    }
  });

  it("leaves an unhealthy PID-file process alone while start backoff is active", async () => {
    const idleScript = path.join(tmpDir, "backoff-idle-process.mjs");
    fs.writeFileSync(
      idleScript,
      [
        "setInterval(() => {}, 1000);",
        'process.on("SIGTERM", () => process.exit(0));',
        "",
      ].join("\n"),
    );
    const idle = spawn(process.execPath, [idleScript], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(idle.pid).toEqual(expect.any(Number));
    fs.writeFileSync(config.serverPidFile, `${idle.pid}\n`);
    fs.writeFileSync(
      config.serverStartBackoffFile,
      `${JSON.stringify({
        attempts: 1,
        lastFailureAtMs: Date.now(),
        nextAllowedAtMs: Date.now() + 60_000,
        lastError: "previous failure",
      })}\n`,
    );

    try {
      await expect(
        startServerDetached({
          serverScript: path.join(tmpDir, "unused-server.mjs"),
          timeoutMs: 200,
        }),
      ).rejects.toThrow(/start backoff active/);
      expect(idle.pid != null && isPidRunning(idle.pid)).toBe(true);
    } finally {
      if (idle.pid && isPidRunning(idle.pid)) {
        try {
          process.kill(idle.pid, "SIGKILL");
        } catch {}
      }
    }
  });

  it("terminates a spawned child that never becomes healthy", async () => {
    const stoppedPath = path.join(tmpDir, "bad-health-stopped");
    const scriptPath = path.join(tmpDir, "bad-health-server.mjs");
    fs.writeFileSync(
      scriptPath,
      [
        'import fs from "node:fs";',
        'import http from "node:http";',
        "const port = Number(process.env.PANOPTICON_PORT);",
        "const stoppedPath = process.env.STOPPED_PATH;",
        "const server = http.createServer((req, res) => {",
        '  if (req.url === "/health") {',
        '    res.writeHead(200, {"content-type":"application/json"});',
        '    res.end(JSON.stringify({status:"starting", port, pid: process.pid}));',
        "    return;",
        "  }",
        "  res.writeHead(404).end();",
        "});",
        'server.listen(port, "127.0.0.1");',
        'process.on("SIGTERM", () => {',
        "  if (stoppedPath) fs.writeFileSync(stoppedPath, 'stopped');",
        "  server.close(() => process.exit(0));",
        "});",
        "",
      ].join("\n"),
    );

    await expect(
      startServerDetached({
        env: { STOPPED_PATH: stoppedPath },
        serverScript: scriptPath,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/did not become healthy/);

    if (process.platform !== "win32") {
      expect(fs.readFileSync(stoppedPath, "utf-8")).toBe("stopped");
    }
  });

  it("treats malformed start backoff files as inactive", () => {
    fs.writeFileSync(config.serverStartBackoffFile, "null\n");
    expect(readServerStartBackoffStatus()).toMatchObject({
      exists: false,
      active: false,
    });
    expect(() => assertServerStartBackoffInactive()).not.toThrow();

    fs.writeFileSync(config.serverStartBackoffFile, "[]\n");
    expect(readServerStartBackoffStatus()).toMatchObject({
      exists: false,
      active: false,
    });
    expect(() => assertServerStartBackoffInactive()).not.toThrow();
  });

  it("records backoff when an unhealthy process cannot be stopped", async () => {
    const err = Object.assign(new Error("denied"), { code: "EPERM" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    try {
      fs.writeFileSync(config.serverPidFile, "12345\n");

      await expect(
        startServerDetached({
          serverScript: path.join(tmpDir, "unused-server.mjs"),
          timeoutMs: 200,
        }),
      ).rejects.toThrow(/permission_denied/);
    } finally {
      kill.mockRestore();
    }

    expect(readServerStartBackoffStatus()).toMatchObject({
      exists: true,
      active: true,
      attempts: 1,
    });
  });

  it("records and respects start failure backoff", async () => {
    const scriptPath = path.join(tmpDir, "crashing-server.mjs");
    fs.writeFileSync(scriptPath, "process.exit(42);\n");

    await expect(
      startServerDetached({ serverScript: scriptPath, timeoutMs: 200 }),
    ).rejects.toThrow(/did not become healthy/);

    const backoff = readServerStartBackoffStatus();
    expect(backoff).toMatchObject({
      exists: true,
      active: true,
      attempts: 1,
    });

    await expect(
      startServerDetached({ serverScript: scriptPath, timeoutMs: 200 }),
    ).rejects.toThrow(/start backoff active/);

    clearServerStartBackoff();
    expect(readServerStartBackoffStatus()).toMatchObject({
      exists: false,
      active: false,
    });
  });
});
