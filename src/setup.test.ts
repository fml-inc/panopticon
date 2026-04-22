import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_SHELL = process.env.SHELL;

function panopticonBlock(content: string): { start: number; end: number } {
  const lines = content.split("\n");
  return {
    start: lines.indexOf("# >>> panopticon >>>"),
    end: lines.indexOf("# <<< panopticon <<<"),
  };
}

describe("configureShellEnv", () => {
  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;

    if (ORIGINAL_SHELL === undefined) delete process.env.SHELL;
    else process.env.SHELL = ORIGINAL_SHELL;

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
    configureShellEnv({ target: "claude", proxy: true, force: true });

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
    configureShellEnv({ target: "claude", proxy: true, force: true });

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
});
