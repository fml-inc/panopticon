import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "panopticon");

export const logPaths = {
  otlp: path.join(LOG_DIR, "otlp-receiver.log"),
  sync: path.join(LOG_DIR, "sync.log"),
  mcp: path.join(LOG_DIR, "mcp-server.log"),
  web: path.join(LOG_DIR, "web.log"),
} as const;

export type DaemonName = keyof typeof logPaths;

export const DAEMON_NAMES = Object.keys(logPaths) as DaemonName[];

/**
 * Open a log file in append mode, returning the fd.
 * Pass the fd to spawn's stdio array: ["ignore", fd, fd]
 * Close the fd after spawn — the child inherits its own copy.
 */
export function openLogFd(daemon: DaemonName): number {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  return fs.openSync(logPaths[daemon], "a");
}
