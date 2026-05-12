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

  it("warns and skips automatic install when git is unavailable", () => {
    const runCommand = vi.fn().mockReturnValueOnce({ status: 1 });
    const warn = vi.fn();

    const exitCode = runPostinstall({
      root: "/tmp/panopticon",
      existsSync: () => true,
      runCommand,
      warn,
    });

    expect(exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("git", ["--version"], {
      stdio: "ignore",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("git not found"));
  });

  it("runs install when dist exists and git is available", () => {
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
    expect(runCommand).toHaveBeenNthCalledWith(1, "git", ["--version"], {
      stdio: "ignore",
    });
    expect(runCommand).toHaveBeenNthCalledWith(2, process.execPath, [
      "./bin/panopticon",
      "install",
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not run duplicate plugin install commands", () => {
    const runCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });

    const exitCode = runPostinstall({
      root: "/tmp/panopticon",
      existsSync: () => true,
      runCommand,
    });

    expect(exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("returns the panopticon install failure code", () => {
    const runCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 23 });

    const exitCode = runPostinstall({
      root: "/tmp/panopticon",
      existsSync: () => true,
      runCommand,
    });

    expect(exitCode).toBe(23);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
