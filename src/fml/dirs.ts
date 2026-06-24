/**
 * Platform-native directories for FML runtime data.
 *
 * macOS:   ~/Library/Application Support/fml   + ~/Library/Logs/fml
 * Linux:   ~/.local/share/fml                  + ~/.local/state/fml/log
 * Windows: %APPDATA%/fml                       + %APPDATA%/fml/logs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();

function dataDir(): string {
  // Override (tests, eval replays, sandboxes) so they never touch a real
  // user's auth/config in the platform-default location.
  if (process.env.FML_DATA_DIR) return process.env.FML_DATA_DIR;
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "fml");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        "fml",
      );
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        "fml",
      );
  }
}

function logDir(): string {
  if (process.env.FML_LOG_DIR) return process.env.FML_LOG_DIR;
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Logs", "fml");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        "fml",
        "logs",
      );
    default:
      return path.join(
        process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
        "fml",
        "log",
      );
  }
}

/** Runtime data — auth tokens, env config, PID files */
export const FML_DATA_DIR = dataDir();

/** Log files — daemon logs, MCP logs */
export const FML_LOG_DIR = logDir();

/** Ensure both directories exist (called once at startup). */
export function ensureDirs(): void {
  fs.mkdirSync(FML_DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(FML_LOG_DIR, { recursive: true, mode: 0o700 });
}
