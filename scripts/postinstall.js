import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const scriptPath = fileURLToPath(import.meta.url);

function spawnCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: packageRoot,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
}

export function runPostinstall({
  root = packageRoot,
  existsSync = fs.existsSync,
  runCommand = spawnCommand,
  warn = console.warn,
} = {}) {
  if (!existsSync(path.join(root, "dist"))) {
    return 0;
  }

  const gitResult = runCommand("git", ["--version"], { stdio: "ignore" });
  if (gitResult.status !== 0) {
    warn(
      "warn: git not found; skipping automatic panopticon install. Install Git and run panopticon install, or run panopticon install --disable-sync.",
    );
    return 0;
  }

  const installResult = runCommand(process.execPath, [
    "./bin/panopticon",
    "install",
  ]);
  if (installResult.status !== 0) {
    return installResult.status ?? 1;
  }

  return 0;
}

if (invokedPath === scriptPath) {
  const exitCode = runPostinstall();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
