/**
 * Shared utilities for communicating with the panopticon server.
 * Extracted from hooks/handler.ts so both the hook handler and the
 * API client can reuse them.
 */
import fs from "node:fs";
import http from "node:http";
import { config } from "../config.js";

/** Check if the server process is running via PID file. */
export function isServerRunning(): boolean {
  if (!fs.existsSync(config.serverPidFile)) return false;
  const pid = parseInt(
    fs.readFileSync(config.serverPidFile, "utf-8").trim(),
    10,
  );
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      fs.unlinkSync(config.serverPidFile);
    } catch {}
    return false;
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
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/health",
            method: "GET",
            timeout: 500,
          },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("timeout"));
        });
        req.end();
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  return false;
}
