/**
 * Shared utilities for communicating with the panopticon server.
 * Extracted from hooks/handler.ts so both the hook handler and the
 * API client can reuse them.
 */
import fs from "node:fs";
import http from "node:http";
import { config } from "../config.js";

export interface ServerProcessStatus {
  pidFileExists: boolean;
  pid: number | null;
  processRunning: boolean;
  stalePidFileRemoved: boolean;
  error: string | null;
}

export interface ServerHealthStatus {
  healthy: boolean;
  statusCode: number | null;
  elapsedMs: number;
  error: string | null;
}

export function getServerProcessStatus(): ServerProcessStatus {
  if (!fs.existsSync(config.serverPidFile)) {
    return {
      pidFileExists: false,
      pid: null,
      processRunning: false,
      stalePidFileRemoved: false,
      error: null,
    };
  }

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(config.serverPidFile, "utf-8").trim(), 10);
  } catch (error) {
    return {
      pidFileExists: true,
      pid: null,
      processRunning: false,
      stalePidFileRemoved: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      pidFileExists: true,
      pid: null,
      processRunning: false,
      stalePidFileRemoved: false,
      error: `invalid pid: ${pid}`,
    };
  }

  try {
    process.kill(pid, 0);
    return {
      pidFileExists: true,
      pid,
      processRunning: true,
      stalePidFileRemoved: false,
      error: null,
    };
  } catch (error) {
    let stalePidFileRemoved = false;
    try {
      fs.unlinkSync(config.serverPidFile);
      stalePidFileRemoved = true;
    } catch {}
    return {
      pidFileExists: true,
      pid,
      processRunning: false,
      stalePidFileRemoved,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Check if the server process is running via PID file. */
export function isServerRunning(): boolean {
  return getServerProcessStatus().processRunning;
}

export async function checkServerHealth(
  port: number,
  timeoutMs = 500,
): Promise<ServerHealthStatus> {
  const start = Date.now();
  try {
    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/health",
          method: "GET",
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
    });
    return {
      healthy: statusCode >= 200 && statusCode < 300,
      statusCode,
      elapsedMs: Date.now() - start,
      error: null,
    };
  } catch (error) {
    return {
      healthy: false,
      statusCode: null,
      elapsedMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Poll the server until it responds or timeout (default 3s). */
export async function waitForServer(
  port: number,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  const interval = 50;
  while (Date.now() - start < timeoutMs) {
    const health = await checkServerHealth(port, 500);
    if (health.healthy) {
      return true;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}
