import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function getLogDir(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Logs", "panopticon");
    case "win32":
      return path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
        "panopticon",
        "logs",
      );
    default:
      // Linux and other Unix-like
      return path.join(
        process.env.XDG_STATE_HOME ??
          path.join(os.homedir(), ".local", "state"),
        "panopticon",
        "logs",
      );
  }
}

const LOG_DIR = getLogDir();

export const logPaths = {
  server: path.join(LOG_DIR, "server.log"),
  otlp: path.join(LOG_DIR, "otlp-receiver.log"),
  mcp: path.join(LOG_DIR, "mcp-server.log"),
  proxy: path.join(LOG_DIR, "proxy.log"),
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
