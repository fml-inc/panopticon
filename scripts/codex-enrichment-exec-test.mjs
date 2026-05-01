#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const defaults = {
  timeoutMs: 90_000,
  model: null,
  sessionId: null,
  disableHooks: false,
  trivialHooks: false,
  importPanopticonHooks: false,
};

function usage() {
  return `Usage: node scripts/codex-enrichment-exec-test.mjs --session <id> [options]

Runs one direct codex exec enrichment prompt. This does not restart Panopticon,
does not dirty DB rows, and does not trigger the scanner/daemon enrichment path.

Options:
  --session <id>     Target Panopticon session id
  --model <model>    Optional Codex model override
  --timeout-ms <ms>  Process timeout (default ${defaults.timeoutMs})
  --disable-hooks    Use a temporary CODEX_HOME with Panopticon MCP but no hooks
  --trivial-hooks    Use a temporary CODEX_HOME with hooks that immediately return {}
  --import-panopticon-hooks
                    Use hooks that import Panopticon's handler module, then return {}
  --help             Show this help
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
      case "--":
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        return opts;
      case "--session":
        opts.sessionId = next();
        break;
      case "--model":
        opts.model = next();
        break;
      case "--timeout-ms":
        opts.timeoutMs = parsePositiveInt(next(), arg);
        break;
      case "--disable-hooks":
        opts.disableHooks = true;
        break;
      case "--trivial-hooks":
        opts.trivialHooks = true;
        break;
      case "--import-panopticon-hooks":
        opts.importPanopticonHooks = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.sessionId) throw new Error("--session is required");
  const hookModeCount = [
    opts.disableHooks,
    opts.trivialHooks,
    opts.importPanopticonHooks,
  ].filter(Boolean).length;
  if (hookModeCount > 1) {
    throw new Error(
      "--disable-hooks, --trivial-hooks, and --import-panopticon-hooks are mutually exclusive",
    );
  }
  return opts;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function dataDir() {
  if (process.env.PANOPTICON_DATA_DIR) return process.env.PANOPTICON_DATA_DIR;
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "panopticon",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "panopticon",
  );
}

function detectCodex() {
  const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
  const detected = execFileSync(lookupCommand, ["codex"], {
    encoding: "utf-8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!detected) throw new Error("codex not found on PATH");
  return normalizeCodexPath(detected);
}

function normalizeCodexPath(detected) {
  if (
    process.platform !== "win32" ||
    path.extname(detected) ||
    !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(detected)
  ) {
    return detected;
  }
  for (const extension of [".cmd", ".exe", ".bat", ".ps1"]) {
    const candidate = `${detected}${extension}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return detected;
}

function codexHomeEnvName() {
  return "CODEX_HOME";
}

function defaultCodexHome() {
  return process.env[codexHomeEnvName()] ?? path.join(os.homedir(), ".codex");
}

function readPanopticonMcpArgs() {
  const configPath = path.join(defaultCodexHome(), "config.toml");
  try {
    const text = fs.readFileSync(configPath, "utf-8");
    const sectionMatch = text.match(
      /\[mcp_servers\.panopticon\]([\s\S]*?)(?:\n\[|$)/,
    );
    const section = sectionMatch?.[1] ?? "";
    const command = section.match(/^\s*command\s*=\s*"([^"]+)"/m)?.[1];
    const argsRaw = section.match(/^\s*args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
    const args = [...argsRaw.matchAll(/"((?:\\.|[^"])*)"/g)].map((match) =>
      match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\"),
    );
    if (command && args.length > 0) return { command, args };
  } catch {}

  return {
    command: "node",
    args: [
      path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "npm",
        "node_modules",
        "@fml-inc",
        "panopticon",
        "bin",
        "mcp-server",
      ),
    ],
  };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function writeNoHookCodexHome(root) {
  const mcp = readPanopticonMcpArgs();
  fs.mkdirSync(root, { recursive: true });
  for (const fileName of ["auth.json", "cap_sid", "installation_id"]) {
    const source = path.join(defaultCodexHome(), fileName);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(root, fileName));
    }
  }
  fs.writeFileSync(
    path.join(root, "config.toml"),
    [
      "suppress_unstable_features_warning = true",
      "",
      "[mcp_servers.panopticon]",
      `command = ${tomlString(mcp.command)}`,
      `args = [ ${mcp.args.map(tomlString).join(", ")} ]`,
      'default_tools_approval_mode = "approve"',
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeHookCodexHome(root, scriptLines) {
  writeNoHookCodexHome(root);
  const hookScript = path.join(root, "trivial-hook.js");
  fs.writeFileSync(hookScript, scriptLines.join("\n"), "utf-8");
  const nodeCommand =
    process.platform === "win32" && fs.existsSync("C:\\Progra~1\\nodejs\\node.exe")
      ? "C:\\Progra~1\\nodejs\\node.exe"
      : JSON.stringify(process.execPath);
  const command = `${nodeCommand} ${JSON.stringify(hookScript)}`;
  const hook = {
    hooks: [
      {
        hooks: [{ type: "command", command, timeout: 10 }],
      },
    ],
  };
  fs.writeFileSync(
    path.join(root, "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: hook.hooks,
          UserPromptSubmit: hook.hooks,
          PreToolUse: hook.hooks,
          PermissionRequest: hook.hooks,
          PostToolUse: hook.hooks,
          Stop: hook.hooks,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeTrivialHookCodexHome(root) {
  writeHookCodexHome(root, [
    "const chunks = [];",
    "process.stdin.on('data', (chunk) => chunks.push(chunk));",
    "process.stdin.on('end', () => process.stdout.write('{}'));",
    "process.stdin.resume();",
    "",
  ]);
}

function writeImportPanopticonHookCodexHome(root) {
  const handlerPath = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "npm",
    "node_modules",
    "@fml-inc",
    "panopticon",
    "dist",
    "hooks",
    "handler.js",
  );
  writeHookCodexHome(root, [
    `await import(${JSON.stringify(pathToFileUrl(handlerPath))});`,
    "const chunks = [];",
    "process.stdin.on('data', (chunk) => chunks.push(chunk));",
    "process.stdin.on('end', () => process.stdout.write('{}'));",
    "process.stdin.resume();",
    "",
  ]);
}

function pathToFileUrl(filePath) {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  return `file:///${normalized.replace(/^([A-Za-z]):/, "$1:")}`;
}

function resolveWindowsCmdShim(binaryPath, args) {
  if (process.platform !== "win32" || !/\.cmd$/i.test(binaryPath)) {
    return { file: binaryPath, args };
  }
  const shim = fs.readFileSync(binaryPath, "utf-8");
  const match = shim.match(/"%dp0%\\([^"]+?\.js)"/i);
  if (!match) return { file: binaryPath, args };
  const scriptPath = path.join(path.dirname(binaryPath), match[1]);
  if (!fs.existsSync(scriptPath)) return { file: binaryPath, args };
  return { file: process.execPath, args: [scriptPath, ...args] };
}

function promptForSession(sessionId) {
  return `You are enriching a per-session coding summary for retrieval.

Use Panopticon MCP tools to inspect only this target session id:
${sessionId}

Prefer session_summary_detail first, then timeline if you need message or tool-call detail. You may use any Panopticon MCP tool if useful, but do not inspect unrelated sessions unless required to understand child-session context for this exact session.

Write exactly one paragraph of 2-3 short sentences, max 140 words total. Lead with the main outcome or highest-value finding. For review sessions, emphasize findings, severity, and whether fixes landed. For implementation or debugging sessions, emphasize what changed and how it was verified. If no code changed, say that explicitly.

Do not mention the model, agent, message count, timestamps, absolute local paths, database paths, prompt engineering, validation batches, or investigation mechanics. Output ONLY the summary text.`;
}

function runCodex(opts) {
  const cwd = path.join(dataDir(), "codex-headless-direct-test");
  fs.mkdirSync(cwd, { recursive: true });
  const tempCodexHome =
    opts.disableHooks || opts.trivialHooks || opts.importPanopticonHooks
    ? fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-codex-no-hooks-"))
    : null;
  if (tempCodexHome) {
    if (opts.trivialHooks) writeTrivialHookCodexHome(tempCodexHome);
    else if (opts.importPanopticonHooks) {
      writeImportPanopticonHookCodexHome(tempCodexHome);
    }
    else writeNoHookCodexHome(tempCodexHome);
  }
  const outputPath = path.join(
    cwd,
    `last-message-direct-${process.pid}-${Date.now()}-${randomUUID()}.txt`,
  );
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-rules",
    "--color",
    "never",
    "--output-last-message",
    outputPath,
  ];
  if (opts.model) args.push("--model", opts.model);
  args.push(promptForSession(opts.sessionId));

  const command = resolveWindowsCmdShim(detectCodex(), args);
  console.log(
    JSON.stringify(
      {
        file: command.file,
        args: command.args.slice(0, -1),
        promptChars: command.args.at(-1).length,
        cwd,
        outputPath,
        codexHome: tempCodexHome ?? defaultCodexHome(),
        hooksEnabled: !opts.disableHooks,
        trivialHooks: opts.trivialHooks,
        importPanopticonHooks: opts.importPanopticonHooks,
      },
      null,
      2,
    ),
  );

  return new Promise((resolve) => {
    const child = spawn(command.file, command.args, {
      cwd,
      env: tempCodexHome
        ? { ...process.env, [codexHomeEnvName()]: tempCodexHome }
        : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(error, null, null);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(
        timedOut && signal
          ? new Error(`Process timed out after ${opts.timeoutMs}ms`)
          : code && code !== 0
            ? new Error(`Process exited with code ${code}`)
            : null,
        code,
        signal,
      );
    });

    function finish(error, code, signal) {
      let output = null;
      if (fs.existsSync(outputPath)) {
        output = fs.readFileSync(outputPath, "utf-8").trim();
      }
      try {
        fs.rmSync(outputPath, { force: true });
      } catch {}
      if (tempCodexHome) {
        try {
          fs.rmSync(tempCodexHome, { recursive: true, force: true });
        } catch {}
      }
      resolve({
        ok: !error,
        code,
        signal,
        error: error?.message ?? null,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
        output,
      });
    }
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runCodex(opts);
  console.log("\n[result]");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
