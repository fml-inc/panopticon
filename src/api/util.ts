/**
 * Shared utilities for communicating with the panopticon server.
 * Extracted from hooks/handler.ts so both the hook handler and the
 * API client can reuse them.
 */
import { config } from "../config.js";
import { readServerStatus, waitForServerHealth } from "../server-control.js";

/** Check if the panopticon server responds to its health endpoint. */
export async function isServerRunning(port = config.port): Promise<boolean> {
  return (await readServerStatus({ port })).health.ok;
}

/** Poll the server until it responds or timeout (default 3s). */
export async function waitForServer(
  port: number,
  timeoutMs = 3000,
): Promise<boolean> {
  return (await waitForServerHealth({ port, timeoutMs })).ok;
}
