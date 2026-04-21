import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger } from "tslog";

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

export const LOG_DIR = getLogDir();

export const logPaths = {
  server: path.join(LOG_DIR, "server.log"),
  otlp: path.join(LOG_DIR, "otlp-receiver.log"),
  mcp: path.join(LOG_DIR, "mcp-server.log"),
  proxy: path.join(LOG_DIR, "proxy.log"),
  hook: path.join(LOG_DIR, "hook-handler.log"),
} as const;

export type DaemonName = keyof typeof logPaths;

export const DAEMON_NAMES = Object.keys(logPaths) as DaemonName[];

export const LOG_LEVEL_IDS = {
  silly: 0,
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
} as const;

export type PanopticonLogLevelName = keyof typeof LOG_LEVEL_IDS;

const DEFAULT_LOG_LEVEL: PanopticonLogLevelName = "info";

function isLogLevelName(value: string): value is PanopticonLogLevelName {
  return Object.hasOwn(LOG_LEVEL_IDS, value);
}

export function parseLogLevelName(
  raw: string | undefined,
): PanopticonLogLevelName {
  const normalizedLevel = raw?.trim().toLowerCase();
  if (!normalizedLevel || !isLogLevelName(normalizedLevel)) {
    return DEFAULT_LOG_LEVEL;
  }
  return normalizedLevel;
}

export const PANOPTICON_LOG_LEVEL = parseLogLevelName(
  process.env.PANOPTICON_LOG_LEVEL,
);

export function shouldWriteLogAtLevel(
  minimumLevel: PanopticonLogLevelName,
  level: PanopticonLogLevelName,
): boolean {
  return LOG_LEVEL_IDS[level] >= LOG_LEVEL_IDS[minimumLevel];
}

export function shouldWriteLog(level: PanopticonLogLevelName): boolean {
  return shouldWriteLogAtLevel(PANOPTICON_LOG_LEVEL, level);
}

/**
 * Open a log file in append mode, returning the fd.
 * Pass the fd to spawn's stdio array: ["ignore", fd, fd]
 * Close the fd after spawn — the child inherits its own copy.
 */
export function openLogFd(daemon: DaemonName): number {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  return fs.openSync(logPaths[daemon], "a");
}

const root = new Logger({
  name: "panopticon",
  minLevel: LOG_LEVEL_IDS[PANOPTICON_LOG_LEVEL],
  type: "pretty",
  prettyLogTimeZone: "UTC",
  stylePrettyLogs: false,
  prettyLogTemplate: "{{dateIsoStr}} [{{name}}] {{logLevelName}}\t",
});

export const log = {
  server: root.getSubLogger({ name: "server" }),
  scanner: root.getSubLogger({ name: "scanner" }),
  sync: root.getSubLogger({ name: "sync" }),
  proxy: root.getSubLogger({ name: "proxy" }),
  llm: root.getSubLogger({ name: "llm" }),
  mcp: root.getSubLogger({ name: "mcp" }),
  otlp: root.getSubLogger({ name: "otlp" }),
  hooks: root.getSubLogger({ name: "hooks" }),
};
