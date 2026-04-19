import { describe, expect, it } from "vitest";
import {
  canUseLocalPathApis,
  detectObservedPathStyle,
  looksLikeWindowsPath,
  resolveFilePathFromCwd,
} from "./paths.js";

describe("paths", () => {
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
});
