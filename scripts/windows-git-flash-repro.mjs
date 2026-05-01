#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const defaults = {
  cwd: process.cwd(),
  iterations: 1,
  delayMs: 2000,
  mode: "all",
  windowsHide: null,
};

function usage() {
  return `Usage: node scripts/windows-git-flash-repro.mjs [options]

Runs the same plain "git" process shapes that scanner config snapshotting used.
Use this on Windows while watching for terminal/window flashes.

Options:
  --cwd <path>           Working directory for git -C (default: current cwd)
  --iterations <n>       Repeat each selected test (default: ${defaults.iterations})
  --delay-ms <ms>        Delay between tests so flashes are visible (default: ${defaults.delayMs})
  --mode <name>          all | exec | spawn | shell | codex-hook-shell (default: ${defaults.mode})
  --windows-hide <bool>  true | false; omit to run both on Windows
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
      case "--iterations":
        opts.iterations = parsePositiveInt(next(), arg);
        break;
      case "--delay-ms":
        opts.delayMs = parsePositiveInt(next(), arg);
        break;
      case "--mode":
        opts.mode = next();
        if (
          !["all", "exec", "spawn", "shell", "codex-hook-shell"].includes(
            opts.mode,
          )
        ) {
          throw new Error(
            "--mode must be one of: all, exec, spawn, shell, codex-hook-shell",
          );
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

function summarizeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    path: error?.path,
    message: error?.message,
    status: error?.status,
    signal: error?.signal,
  };
}

function testCases(cwd) {
  const localSettings = path.join(cwd, ".claude", "settings.local.json");
  return [
    {
      name: "git rev-parse",
      file: "git",
      args: ["-C", cwd, "rev-parse", "--show-toplevel"],
    },
    {
      name: "git check-ignore",
      file: "git",
      args: ["-C", cwd, "check-ignore", "-q", localSettings],
    },
    {
      name: "git ls-files",
      file: "git",
      args: ["-C", cwd, "ls-files", "--full-name", "*/CLAUDE.md", "CLAUDE.md"],
    },
  ];
}

function runExecFile(test, windowsHide) {
  try {
    const stdout = execFileSync(test.file, test.args, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, error: summarizeError(error) };
  }
}

function runSpawnSync(test, windowsHide) {
  const result = spawnSync(test.file, test.args, {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    error: result.error ? summarizeError(result.error) : null,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function runShell(test, windowsHide) {
  const quotedArgs = test.args.map((arg) => JSON.stringify(arg)).join(" ");
  const command = `${test.file} ${quotedArgs}`;
  const result = spawnSync(command, {
    encoding: "utf-8",
    timeout: 5000,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    error: result.error ? summarizeError(result.error) : null,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function powershellPath() {
  const candidates = [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "powershell.exe";
}

function shellQuotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runCodexHookShell(test, windowsHide) {
  const shellCommand = [test.file, ...test.args.map(shellQuotePowerShell)].join(
    " ",
  );
  const result = spawnSync(
    powershellPath(),
    ["-NoProfile", "-Command", shellCommand],
    {
      cwd: test.cwd ?? process.cwd(),
      input: "{}",
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide,
    },
  );
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    error: result.error ? summarizeError(result.error) : null,
    shellCommand,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function selectedRunners(mode) {
  const runners = [];
  if (mode === "all" || mode === "exec")
    runners.push(["execFileSync", runExecFile]);
  if (mode === "all" || mode === "spawn")
    runners.push(["spawnSync", runSpawnSync]);
  if (mode === "all" || mode === "shell")
    runners.push(["spawnSync shell", runShell]);
  if (mode === "all" || mode === "codex-hook-shell")
    runners.push(["Codex hook shell", runCodexHookShell]);
  return runners;
}

function windowsHideValues(value) {
  if (value !== null) return [value];
  return process.platform === "win32" ? [false, true] : [false];
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
        mode: opts.mode,
        iterations: opts.iterations,
        delayMs: opts.delayMs,
        platform: process.platform,
        note: "Watch the screen after each [run] line.",
      },
      null,
      2,
    ),
  );

  const cases = testCases(opts.cwd);
  const runners = selectedRunners(opts.mode);
  const hideValues = windowsHideValues(opts.windowsHide);

  for (let iteration = 1; iteration <= opts.iterations; iteration += 1) {
    for (const [runnerName, runner] of runners) {
      for (const windowsHide of hideValues) {
        for (const test of cases) {
          console.log(
            `[run] iteration=${iteration} runner=${runnerName} windowsHide=${windowsHide} test="${test.name}"`,
          );
          const started = Date.now();
          const result = runner(test, windowsHide);
          console.log(
            JSON.stringify(
              {
                elapsedMs: Date.now() - started,
                result,
              },
              null,
              2,
            ),
          );
          sleep(opts.delayMs);
        }
      }
    }
  }
}

main();
