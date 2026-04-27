import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeRepoFilePath,
  canUseLocalPathApis,
  detectObservedPathStyle,
  looksLikeWindowsPath,
  resolveCanonicalFilePath,
  resolveFilePathFromCwd,
  resolveGitRoot,
  resolveRepositoryRootForPath,
} from "./paths.js";

describe("paths", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Windows-style paths", () => {
    expect(looksLikeWindowsPath("C:\\repo\\src")).toBe(true);
    expect(looksLikeWindowsPath("\\\\server\\share\\repo")).toBe(true);
    expect(looksLikeWindowsPath("/tmp/repo")).toBe(false);
  });

  it("detects observed path style", () => {
    expect(detectObservedPathStyle("C:\\repo\\src")).toBe("windows");
    expect(detectObservedPathStyle("/tmp/repo")).toBe("posix");
    expect(detectObservedPathStyle("relative/path")).toBeNull();
  });

  it("guards local path APIs for foreign absolute paths", () => {
    if (process.platform === "win32") {
      expect(canUseLocalPathApis("C:\\repo")).toBe(true);
      expect(canUseLocalPathApis("/tmp/repo")).toBe(false);
      return;
    }
    expect(canUseLocalPathApis("C:\\repo")).toBe(false);
    expect(canUseLocalPathApis("/tmp/repo")).toBe(true);
  });

  it("resolves relative paths against local POSIX cwd", () => {
    expect(resolveFilePathFromCwd("src/index.ts", "/repo")).toBe(
      "/repo/src/index.ts",
    );
  });

  it("resolves relative paths against observed Windows cwd", () => {
    expect(resolveFilePathFromCwd("src/index.ts", "C:\\repo")).toBe(
      "C:\\repo\\src\\index.ts",
    );
    expect(resolveFilePathFromCwd("src\\index.ts", "C:\\repo")).toBe(
      "C:\\repo\\src\\index.ts",
    );
  });

  it("preserves already-absolute paths", () => {
    expect(resolveFilePathFromCwd("/repo/src/index.ts", "/repo")).toBe(
      "/repo/src/index.ts",
    );
    expect(resolveFilePathFromCwd("C:\\repo\\src\\index.ts", "/repo")).toBe(
      "C:\\repo\\src\\index.ts",
    );
  });

  it("canonicalizes repo files to repo-relative paths when a root is known", () => {
    expect(
      canonicalizeRepoFilePath("/repo/src/index.ts", {
        repositoryRoot: "/repo",
        allowNonGitRepositoryRoot: true,
      }),
    ).toBe("src/index.ts");
    expect(
      canonicalizeRepoFilePath("src/index.ts", {
        repositoryRoot: "/repo",
        allowNonGitRepositoryRoot: true,
      }),
    ).toBe("src/index.ts");
  });

  it("keeps files outside the repository root absolute", () => {
    expect(
      canonicalizeRepoFilePath("/tmp/plan.md", {
        repositoryRoot: "/repo",
        allowNonGitRepositoryRoot: true,
      }),
    ).toBe("/tmp/plan.md");
  });

  it("resolves canonical repo-relative paths back to absolute paths", () => {
    expect(
      resolveCanonicalFilePath("src/index.ts", {
        repositoryRoot: "/repo",
      }),
    ).toBe("/repo/src/index.ts");
  });

  it("infers the git root from an absolute file path when available", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-paths-"));
    tempDirs.push(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const file = path.join(repo, "src", "index.ts");
    fs.writeFileSync(file, "export const x = 1;\n");
    const realRepo = fs.realpathSync(repo);

    expect(resolveGitRoot(path.dirname(file))).toBe(realRepo);
    expect(
      resolveRepositoryRootForPath({
        filePath: file,
      }),
    ).toBe(realRepo);
    expect(canonicalizeRepoFilePath(file)).toBe("src/index.ts");
  });
});
