import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runPostinstall } from "./postinstall.js";

describe("runPostinstall", () => {
  it("skips install when dist is missing", () => {
    const runCommand = vi.fn();

    const exitCode = runPostinstall({
      root: "/tmp/panopticon",
      existsSync: () => false,
      runCommand,
    });

    expect(exitCode).toBe(0);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("runs install and skips warning when plugin install succeeds", () => {
    const runCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });
    const warn = vi.fn();

    const exitCode = runPostinstall({
      root: "/tmp/panopticon",
      existsSync: (target) => target === path.join("/tmp/panopticon", "dist"),
      runCommand,
      warn,
    });

    expect(exitCode).toBe(0);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      ["./bin/panopticon", "install"],
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "claude",
      ["plugin", "install", "panopticon@local-plugins"],
      { stdio: "ignore" },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and succeeds when Claude CLI is unavailable", () => {
    const runCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: null })
      .mockReturnValueOnce({ status: null });
    const warn = vi.fn();

    const exitCode = runPostinstall({
      root: "/tmp/panopticon",
      existsSync: () => true,
      runCommand,
      warn,
    });

    expect(exitCode).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "warn: claude CLI not found, run 'claude plugin install panopticon@local-plugins' manually",
    );
  });

  it("returns the panopticon install failure code", () => {
    const runCommand = vi.fn().mockReturnValue({ status: 23 });

    const exitCode = runPostinstall({
      root: "/tmp/panopticon",
      existsSync: () => true,
      runCommand,
    });

    expect(exitCode).toBe(23);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
