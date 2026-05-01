#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const defaults = {
  cwd: process.cwd(),
  event: "SessionStart",
  iterations: 1,
  delayMs: 2000,
  mode: "shell-config",
  windowsHide: false,
  port: 4318,
};

function usage() {
  return `Usage: node scripts/hook-handler-flash-repro.mjs [options]

Invokes the installed Panopticon hook handler with a minimal hook JSON payload.
This removes Codex itself while preserving the real hook command and stdin shape.

Options:
  --cwd <path>           Payload cwd and child process cwd (default: current cwd)
  --event <name>         Hook event name (default: ${defaults.event})
  --iterations <n>       Repeat selected invocation (default: ${defaults.iterations})
  --delay-ms <ms>        Delay between runs so flashes are visible (default: ${defaults.delayMs})
  --mode <name>          shell-config | direct | both (default: ${defaults.mode})
  --windows-hide <bool>  true | false for child processes (default: false)
  --port <n>             Panopticon port for direct mode (default: ${defaults.port})
  --help                 Show this help
`;
}

function parseArgs(argv) {
  const opts = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      case "--cwd":
        opts.cwd = next();
        break;
      case "--event":
        opts.event = next();
        break;
      case "--iterations":
        opts.iterations = parsePositiveInt(next(), arg);
        break;
      case "--delay-ms":
        opts.delayMs = parsePositiveInt(next(), arg);
        break;
      case "--mode":
        opts.mode = next();
        if (!["shell-config", "direct", "both"].includes(opts.mode)) {
          throw new Error("--mode must be one of: shell-config, direct, both");
        }
        break;
      case "--windows-hide": {
        const value = next().toLowerCase();
        if (value !== "true" && value !== "false") {
          throw new Error("--windows-hide must be true or false");
        }
        opts.windowsHide = value === "true";
        break;
      }
      case "--port":
        opts.port = parsePositiveInt(next(), arg);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  opts.cwd = path.resolve(opts.cwd);
  return opts;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function codexHome() {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function readHookCommand(event) {
  const hooksPath = path.join(codexHome(), "hooks.json");
  const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
  const entries = hooks.hooks?.[event] ?? hooks.hooks?.SessionStart;
  const command = entries?.[0]?.hooks?.[0]?.command;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`No command found for ${event} in ${hooksPath}`);
  }
  return { hooksPath, command };
}

function defaultHookHandlerBin() {
  const appData =
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(
    appData,
    "npm",
    "node_modules",
    "@fml-inc",
    "panopticon",
    "bin",
    "hook-handler",
  );
}

function makePayload(opts) {
  return {
    session_id: `hook-flash-repro-${process.pid}-${Date.now()}`,
    hook_event_name: opts.event,
    cwd: opts.cwd,
    source: "codex",
    target: "codex",
    permission_mode: "never",
    model: "gpt-5.5",
  };
}

function summarize(result) {
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    error: result.error
      ? {
          name: result.error.name,
          code: result.error.code,
          errno: result.error.errno,
          syscall: result.error.syscall,
          path: result.error.path,
          message: result.error.message,
        }
      : null,
    stdout: result.stdout?.toString("utf-8").trim() ?? "",
    stderr: result.stderr?.toString("utf-8").trim() ?? "",
  };
}

function runShellConfig(opts, payload) {
  const { hooksPath, command } = readHookCommand(opts.event);
  const result = spawnSync(command, {
    cwd: opts.cwd,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    shell: true,
    windowsHide: opts.windowsHide,
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { hooksPath, command, result: summarize(result) };
}

function runDirect(opts, payload) {
  const file = process.execPath;
  const args = [defaultHookHandlerBin(), "codex", String(opts.port)];
  const result = spawnSync(file, args, {
    cwd: opts.cwd,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    windowsHide: opts.windowsHide,
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { file, args, result: summarize(result) };
}

function modes(mode) {
  return mode === "both" ? ["shell-config", "direct"] : [mode];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.cwd)) {
    throw new Error(`cwd does not exist: ${opts.cwd}`);
  }

  console.log(
    JSON.stringify(
      {
        cwd: opts.cwd,
        event: opts.event,
        mode: opts.mode,
        iterations: opts.iterations,
        delayMs: opts.delayMs,
        windowsHide: opts.windowsHide,
        platform: process.platform,
        note: "Watch the screen after each [run] line.",
      },
      null,
      2,
    ),
  );

  for (let iteration = 1; iteration <= opts.iterations; iteration += 1) {
    for (const mode of modes(opts.mode)) {
      const payload = makePayload(opts);
      console.log(`[run] iteration=${iteration} mode=${mode}`);
      const started = Date.now();
      const output =
        mode === "shell-config"
          ? runShellConfig(opts, payload)
          : runDirect(opts, payload);
      console.log(
        JSON.stringify(
          {
            elapsedMs: Date.now() - started,
            payload,
            output,
          },
          null,
          2,
        ),
      );
      sleep(opts.delayMs);
    }
  }
}

main();
