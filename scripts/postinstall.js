#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
const scriptPath = fileURLToPath(import.meta.url);

function spawnCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: packageRoot,
    stdio: "inherit",
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

  const installResult = runCommand(process.execPath, [
    "./bin/panopticon",
    "install",
  ]);
  if (installResult.status !== 0) {
    return installResult.status ?? 1;
  }

  const pluginRef = "panopticon@local-plugins";
  const pluginInstall = runCommand("claude", ["plugin", "install", pluginRef], {
    stdio: "ignore",
  });
  if (pluginInstall.status === 0) {
    return 0;
  }

  const pluginUpdate = runCommand("claude", ["plugin", "update", pluginRef], {
    stdio: "ignore",
  });
  if (pluginUpdate.status === 0) {
    return 0;
  }

  warn(
    `warn: claude CLI not found, run 'claude plugin install ${pluginRef}' manually`,
  );
  return 0;
}

if (invokedPath === scriptPath) {
  const exitCode = runPostinstall();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
