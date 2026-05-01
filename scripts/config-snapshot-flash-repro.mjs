#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaults = {
  cwd: process.cwd(),
  iterations: 1,
  delayMs: 2000,
  mode: "capture",
  windowsHide: false,
};

function usage() {
  return `Usage: node scripts/config-snapshot-flash-repro.mjs [options]

Runs Panopticon config snapshot paths without launching Codex or hooks.
Build first if you changed src: pnpm build

Options:
  --cwd <path>           CWD to pass to readConfig/capture (default: current cwd)
  --iterations <n>       Repeat selected steps (default: ${defaults.iterations})
  --delay-ms <ms>        Delay between steps so flashes are visible (default: ${defaults.delayMs})
  --mode <name>          capture | read-config | legacy-git | capture-legacy | all
  --windows-hide <bool>  true | false for legacy git child processes (default: false)
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
          ![
            "capture",
            "read-config",
            "legacy-git",
            "capture-legacy",
            "all",
          ].includes(opts.mode)
        ) {
          throw new Error(
            "--mode must be one of: capture, read-config, legacy-git, capture-legacy, all",
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

function legacyGitDiscovery(cwd, windowsHide) {
  const localSettings = path.join(cwd, ".claude", "settings.local.json");
  const calls = [
    {
      name: "git rev-parse",
      args: ["-C", cwd, "rev-parse", "--show-toplevel"],
    },
    {
      name: "git check-ignore",
      args: ["-C", cwd, "check-ignore", "-q", localSettings],
    },
    {
      name: "git ls-files",
      args: ["-C", cwd, "ls-files", "--full-name", "*/CLAUDE.md", "CLAUDE.md"],
    },
  ];

  return calls.map((call) => {
    const started = Date.now();
    try {
      const stdout = execFileSync("git", call.args, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide,
      });
      return {
        name: call.name,
        elapsedMs: Date.now() - started,
        ok: true,
        stdout: stdout.trim(),
      };
    } catch (error) {
      return {
        name: call.name,
        elapsedMs: Date.now() - started,
        ok: false,
        error: summarizeError(error),
      };
    }
  });
}

async function loadPanopticon() {
  const distIndex = path.resolve("dist", "index.js");
  if (!fs.existsSync(distIndex)) {
    throw new Error("dist/index.js is missing; run pnpm build first");
  }
  return import(pathToFileURL(distIndex).href);
}

function compactConfig(config) {
  return {
    instructions: config.instructions?.length ?? 0,
    userHooks: config.user?.hooks?.length ?? 0,
    userCommands: config.user?.commands?.length ?? 0,
    userRules: config.user?.rules?.length ?? 0,
    userSkills: config.user?.skills?.length ?? 0,
    enabledPlugins: config.enabledPlugins?.length ?? 0,
    pluginHooks: config.pluginHooks?.length ?? 0,
    memoryScopes: Object.keys(config.memoryFiles ?? {}).length,
  };
}

function selectedSteps(mode) {
  if (mode === "all")
    return ["read-config", "capture", "legacy-git", "legacy-git", "capture"];
  if (mode === "capture-legacy") return ["legacy-git", "capture"];
  return [mode];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.cwd)) {
    throw new Error(`cwd does not exist: ${opts.cwd}`);
  }

  const panopticon = await loadPanopticon();
  if (typeof panopticon.readConfig !== "function") {
    throw new Error("dist/index.js does not export readConfig");
  }
  if (typeof panopticon.captureUserConfigSnapshot !== "function") {
    throw new Error(
      "dist/index.js does not export captureUserConfigSnapshot; rebuild after updating src/index.ts",
    );
  }

  console.log(
    JSON.stringify(
      {
        cwd: opts.cwd,
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
    for (const step of selectedSteps(opts.mode)) {
      console.log(`[run] iteration=${iteration} step=${step}`);
      const started = Date.now();
      let result;
      try {
        if (step === "read-config") {
          result = {
            ok: true,
            config: compactConfig(panopticon.readConfig(opts.cwd)),
          };
        } else if (step === "capture") {
          result = {
            ok: true,
            inserted: panopticon.captureUserConfigSnapshot(opts.cwd),
          };
        } else if (step === "legacy-git") {
          result = {
            ok: true,
            calls: legacyGitDiscovery(opts.cwd, opts.windowsHide),
          };
        } else {
          throw new Error(`Unknown step: ${step}`);
        }
      } catch (error) {
        result = { ok: false, error: summarizeError(error) };
      }
      console.log(
        JSON.stringify({ elapsedMs: Date.now() - started, result }, null, 2),
      );
      sleep(opts.delayMs);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
