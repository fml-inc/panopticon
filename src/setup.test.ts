import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_SHELL = process.env.SHELL;
const ORIGINAL_DATA_DIR = process.env.PANOPTICON_DATA_DIR;
const ORIGINAL_TOKEN = process.env.PANOPTICON_AUTH_TOKEN;

function panopticonBlock(content: string): { start: number; end: number } {
  const lines = content.split("\n");
  return {
    start: lines.indexOf("# >>> panopticon >>>"),
    end: lines.indexOf("# <<< panopticon <<<"),
  };
}

function hasCommand(command: string): boolean {
  const pathExt =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  return pathDirs.some((dir) =>
    pathExt.some((ext) => fs.existsSync(path.join(dir, `${command}${ext}`))),
  );
}

describe("configureShellEnv", () => {
  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;

    if (ORIGINAL_SHELL === undefined) delete process.env.SHELL;
    else process.env.SHELL = ORIGINAL_SHELL;

    if (ORIGINAL_DATA_DIR === undefined) delete process.env.PANOPTICON_DATA_DIR;
    else process.env.PANOPTICON_DATA_DIR = ORIGINAL_DATA_DIR;

    if (ORIGINAL_TOKEN === undefined) delete process.env.PANOPTICON_AUTH_TOKEN;
    else process.env.PANOPTICON_AUTH_TOKEN = ORIGINAL_TOKEN;

    vi.resetModules();
  });

  it("keeps proxy env vars inside the managed block on reinstall", async () => {
    const tmpHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-setup-home-"),
    );
    const shellRc = path.join(tmpHome, ".zshrc");
    process.env.HOME = tmpHome;
    process.env.SHELL = "/bin/zsh";

    fs.writeFileSync(
      shellRc,
      [
        "export FOO=1",
        "",
        "# >>> panopticon >>>",
        "export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318",
        "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
        "export OTEL_METRICS_EXPORTER=otlp",
        "export OTEL_LOGS_EXPORTER=otlp",
        "export OTEL_LOG_TOOL_DETAILS=1",
        "export OTEL_LOG_USER_PROMPTS=1",
        "export OTEL_METRIC_EXPORT_INTERVAL=10000",
        "export CLAUDE_CODE_ENABLE_TELEMETRY=1",
        "# <<< panopticon <<<",
        "",
      ].join("\n"),
    );

    const { configureShellEnv } = await import("./setup.js");
    configureShellEnv(
      { target: "claude", proxy: true, force: true },
      { platform: "linux", homeDir: tmpHome, shell: "/bin/zsh" },
    );

    const content = fs.readFileSync(shellRc, "utf-8");
    const lines = content.split("\n");
    const anthLineIndexes = lines.flatMap((line, idx) =>
      line.includes("ANTHROPIC_BASE_URL") ? [idx] : [],
    );
    const block = panopticonBlock(content);

    expect(anthLineIndexes).toHaveLength(1);
    expect(block.start).toBeGreaterThanOrEqual(0);
    expect(block.end).toBeGreaterThan(block.start);
    expect(anthLineIndexes[0]).toBeGreaterThan(block.start);
    expect(anthLineIndexes[0]).toBeLessThan(block.end);
  });

  it("moves stray managed env vars back into the panopticon block", async () => {
    const tmpHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-setup-home-"),
    );
    const shellRc = path.join(tmpHome, ".zshrc");
    process.env.HOME = tmpHome;
    process.env.SHELL = "/bin/zsh";

    fs.writeFileSync(
      shellRc,
      [
        "export FOO=1",
        "",
        "# >>> panopticon >>>",
        "export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318",
        "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
        "export OTEL_METRICS_EXPORTER=otlp",
        "export OTEL_LOGS_EXPORTER=otlp",
        "export OTEL_LOG_TOOL_DETAILS=1",
        "export OTEL_LOG_USER_PROMPTS=1",
        "export OTEL_METRIC_EXPORT_INTERVAL=10000",
        "export CLAUDE_CODE_ENABLE_TELEMETRY=1",
        "# <<< panopticon <<<",
        "export ANTHROPIC_BASE_URL=http://localhost:4318/proxy/anthropic",
        "",
      ].join("\n"),
    );

    const { configureShellEnv } = await import("./setup.js");
    configureShellEnv(
      { target: "claude", proxy: true, force: true },
      { platform: "linux", homeDir: tmpHome, shell: "/bin/zsh" },
    );

    const content = fs.readFileSync(shellRc, "utf-8");
    const lines = content.split("\n");
    const anthLineIndexes = lines.flatMap((line, idx) =>
      line.includes("ANTHROPIC_BASE_URL") ? [idx] : [],
    );
    const block = panopticonBlock(content);

    expect(anthLineIndexes).toHaveLength(1);
    expect(anthLineIndexes[0]).toBeGreaterThan(block.start);
    expect(anthLineIndexes[0]).toBeLessThan(block.end);
  });

  it("writes Windows PowerShell profiles that source env.ps1", async () => {
    const tmpHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-setup-home-win-"),
    );
    const tmpDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-setup-data-win-"),
    );
    process.env.PANOPTICON_AUTH_TOKEN = "test-token-win";

    const { configureShellEnvDetailed } = await import("./setup.js");
    const result = configureShellEnvDetailed(
      { target: "claude", proxy: true, force: true },
      {
        platform: "win32",
        homeDir: tmpHome,
        dataDir: tmpDataDir,
      },
    );

    expect(result.envFiles).toEqual([
      path.join(tmpDataDir, "env.ps1"),
      path.join(tmpDataDir, "env.cmd"),
    ]);
    expect(result.profileUpdates).toEqual([
      {
        action: "added",
        path: path.join(tmpHome, "Documents", "PowerShell", "Profile.ps1"),
      },
      {
        action: "added",
        path: path.join(
          tmpHome,
          "Documents",
          "WindowsPowerShell",
          "Profile.ps1",
        ),
      },
    ]);

    for (const update of result.profileUpdates) {
      const content = fs.readFileSync(update.path, "utf-8");
      expect(content).toContain("# >>> panopticon >>>");
      expect(content).toContain(
        `if (Test-Path '${path.join(tmpDataDir, "env.ps1")}') {`,
      );
      expect(content).toContain(`  . '${path.join(tmpDataDir, "env.ps1")}'`);
      expect(content).toContain("# <<< panopticon <<<");
    }

    const psContent = fs.readFileSync(
      path.join(tmpDataDir, "env.ps1"),
      "utf-8",
    );
    expect(psContent).toContain(
      "$env:OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%20test-token-win'",
    );
    expect(psContent).toContain("$env:CLAUDE_CODE_ENABLE_TELEMETRY = '1'");
    expect(psContent).not.toContain("$env:GEMINI_TELEMETRY_ENABLED");
    expect(psContent).toMatch(
      /\$env:ANTHROPIC_BASE_URL = 'http:\/\/localhost:\d+\/proxy\/anthropic'/,
    );

    const cmdContent = fs.readFileSync(
      path.join(tmpDataDir, "env.cmd"),
      "utf-8",
    );
    expect(cmdContent).toContain(
      'set "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%%20test-token-win"',
    );
    expect(cmdContent).toContain('set "CLAUDE_CODE_ENABLE_TELEMETRY=1"');
    expect(cmdContent).not.toContain('set "GEMINI_TELEMETRY_ENABLED=');
  });

  it("removes panopticon blocks from Windows PowerShell profiles", async () => {
    const tmpHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-setup-home-win-"),
    );
    const tmpDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon-setup-data-win-"),
    );
    process.env.PANOPTICON_AUTH_TOKEN = "test-token-win-cleanup";

    const { configureShellEnvDetailed, removeShellEnvDetailed } = await import(
      "./setup.js"
    );
    const installResult = configureShellEnvDetailed(
      { target: "claude", force: true },
      {
        platform: "win32",
        homeDir: tmpHome,
        dataDir: tmpDataDir,
      },
    );

    const cleanup = removeShellEnvDetailed({
      platform: "win32",
      homeDir: tmpHome,
      dataDir: tmpDataDir,
    });

    expect(cleanup.removedProfilePaths).toEqual(
      installResult.profileUpdates.map((update) => update.path),
    );
    for (const profilePath of cleanup.removedProfilePaths) {
      const content = fs.readFileSync(profilePath, "utf-8");
      expect(content).not.toContain("# >>> panopticon >>>");
      expect(content).not.toContain("# <<< panopticon <<<");
    }
  });

  it("quotes Windows env paths with spaces and apostrophes", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "panopticon O'Brien root "),
    );
    const tmpHome = path.join(tmpRoot, "home with spaces");
    const tmpDataDir = path.join(tmpRoot, "data O'Brien dir");
    const previousAuthToken = process.env.PANOPTICON_AUTH_TOKEN;
    process.env.PANOPTICON_AUTH_TOKEN = "test-token-win-quotes";

    try {
      const { configureShellEnvDetailed } = await import("./setup.js");
      const result = configureShellEnvDetailed(
        { target: "claude", proxy: true, force: true },
        {
          platform: "win32",
          homeDir: tmpHome,
          dataDir: tmpDataDir,
        },
      );

      const envPath = path.join(tmpDataDir, "env.ps1");
      const quotedEnvPath = `'${envPath.replace(/'/g, "''")}'`;

      for (const update of result.profileUpdates) {
        const content = fs.readFileSync(update.path, "utf-8");
        expect(content).toContain(`if (Test-Path ${quotedEnvPath}) {`);
        expect(content).toContain(`  . ${quotedEnvPath}`);
      }
    } finally {
      if (previousAuthToken === undefined) {
        delete process.env.PANOPTICON_AUTH_TOKEN;
      } else {
        process.env.PANOPTICON_AUTH_TOKEN = previousAuthToken;
      }
    }
  });
});

describe("writePanopticonEnvFile", () => {
  afterEach(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.PANOPTICON_DATA_DIR;
    else process.env.PANOPTICON_DATA_DIR = ORIGINAL_DATA_DIR;
    if (ORIGINAL_TOKEN === undefined) delete process.env.PANOPTICON_AUTH_TOKEN;
    else process.env.PANOPTICON_AUTH_TOKEN = ORIGINAL_TOKEN;
    vi.resetModules();
  });

  it("writes a sourcable env.sh including OTEL_EXPORTER_OTLP_HEADERS", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-envsh-"));
    process.env.PANOPTICON_DATA_DIR = tmpDir;
    process.env.PANOPTICON_AUTH_TOKEN = "test-token-abc";

    const { writePanopticonEnvFile } = await import("./setup.js");
    const envFile = writePanopticonEnvFile(false, {
      platform: "linux",
      dataDir: tmpDir,
    });

    expect(envFile).toBe(path.join(tmpDir, "env.sh"));
    const content = fs.readFileSync(envFile, "utf-8");

    // Every required panopticon env var is exported.
    expect(content).toContain("export OTEL_EXPORTER_OTLP_ENDPOINT=");
    expect(content).toContain(
      "export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20test-token-abc",
    );
    expect(content).toContain("export OTEL_METRICS_EXPORTER=otlp");
    expect(content).toContain("export OTEL_LOGS_EXPORTER=otlp");
  });

  it.skipIf(process.platform === "win32")(
    "file is mode 0600 (contains the auth token)",
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "panopticon-envsh-"),
      );
      process.env.PANOPTICON_DATA_DIR = tmpDir;
      process.env.PANOPTICON_AUTH_TOKEN = "test-token-mode";

      const { writePanopticonEnvFile } = await import("./setup.js");
      const envFile = writePanopticonEnvFile(false, {
        platform: "linux",
        dataDir: tmpDir,
      });
      const stat = fs.statSync(envFile);
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(!hasCommand("bash"))(
    "can be sourced by /bin/sh and exports the variables",
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "panopticon-envsh-"),
      );
      process.env.PANOPTICON_DATA_DIR = tmpDir;
      process.env.PANOPTICON_AUTH_TOKEN = "test-token-source";

      const { writePanopticonEnvFile } = await import("./setup.js");
      const envFile = writePanopticonEnvFile(false, {
        platform: "linux",
        dataDir: tmpDir,
      });

      // The whole point of this file is that a non-interactive shell can
      // source it without the bashrc-guard problem. Verify with a real
      // bash subprocess.
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync(
        "bash",
        ["-c", `source "${envFile}" && echo "$OTEL_EXPORTER_OTLP_HEADERS"`],
        { encoding: "utf-8" },
      ).trim();
      expect(out).toBe("Authorization=Bearer%20test-token-source");
    },
  );

  it("writes Windows env.ps1 and env.cmd variants", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-envwin-"));
    process.env.PANOPTICON_AUTH_TOKEN = "test-token-win-files";

    const { writePanopticonEnvFiles } = await import("./setup.js");
    const envFiles = writePanopticonEnvFiles(false, {
      platform: "win32",
      dataDir: tmpDir,
    });

    expect(envFiles).toEqual([
      path.join(tmpDir, "env.ps1"),
      path.join(tmpDir, "env.cmd"),
    ]);
    expect(fs.readFileSync(envFiles[0], "utf-8")).toContain(
      "$env:OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%20test-token-win-files'",
    );
    expect(fs.readFileSync(envFiles[1], "utf-8")).toContain(
      'set "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%%20test-token-win-files"',
    );
  });

  it("filters Unix env.sh to the selected target", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-envsh-"));
    process.env.PANOPTICON_AUTH_TOKEN = "test-token-unix-target";

    const { writePanopticonEnvFile } = await import("./setup.js");
    const envFile = writePanopticonEnvFile(
      true,
      {
        platform: "linux",
        dataDir: tmpDir,
      },
      "claude",
    );

    const content = fs.readFileSync(envFile, "utf-8");
    expect(content).toContain("export CLAUDE_CODE_ENABLE_TELEMETRY=1");
    expect(content).toMatch(
      /export ANTHROPIC_BASE_URL=http:\/\/localhost:\d+\/proxy\/anthropic/,
    );
    expect(content).not.toContain("export GEMINI_TELEMETRY_ENABLED=");
  });

  it("filters Windows env files to the selected target", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-envwin-"));
    process.env.PANOPTICON_AUTH_TOKEN = "test-token-win-target";

    const { writePanopticonEnvFiles } = await import("./setup.js");
    const envFiles = writePanopticonEnvFiles(
      false,
      {
        platform: "win32",
        dataDir: tmpDir,
      },
      "claude",
    );

    const psContent = fs.readFileSync(envFiles[0], "utf-8");
    const cmdContent = fs.readFileSync(envFiles[1], "utf-8");
    expect(psContent).toContain("$env:CLAUDE_CODE_ENABLE_TELEMETRY = '1'");
    expect(psContent).not.toContain("$env:GEMINI_TELEMETRY_ENABLED");
    expect(cmdContent).toContain('set "CLAUDE_CODE_ENABLE_TELEMETRY=1"');
    expect(cmdContent).not.toContain('set "GEMINI_TELEMETRY_ENABLED=');
  });
});
