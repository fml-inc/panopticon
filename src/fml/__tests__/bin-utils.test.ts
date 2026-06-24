import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quoteWinArg, resolveBin } from "../bin-utils.js";

describe("resolveBin", () => {
  const IS_WIN = process.platform === "win32";
  // Windows: bare filenames aren't executable; we need an extension that's in
  // PATHEXT. Use lowercase so the returned path (built from `name + ext`)
  // matches what we wrote.
  const BIN_NAME = IS_WIN ? "panopticon.cmd" : "panopticon";
  let tmpDir: string;
  let origPath: string | undefined;
  let origPathExt: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fml-resolve-"));
    origPath = process.env.PATH;
    origPathExt = process.env.PATHEXT;
    if (IS_WIN) {
      process.env.PATHEXT = ".com;.exe;.bat;.cmd";
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    if (origPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = origPathExt;
  });

  it("finds a binary on PATH", () => {
    const target = path.join(tmpDir, BIN_NAME);
    fs.writeFileSync(target, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    process.env.PATH = `${tmpDir}${path.delimiter}/nonexistent`;

    expect(resolveBin("panopticon")).toBe(target);
  });

  it("returns null when the binary is missing", () => {
    process.env.PATH = tmpDir;
    expect(resolveBin("nope-not-here")).toBeNull();
  });

  it("ignores empty PATH segments", () => {
    process.env.PATH = `${path.delimiter}${path.delimiter}${tmpDir}`;
    const target = path.join(tmpDir, BIN_NAME);
    fs.writeFileSync(target, "x", { mode: 0o755 });
    expect(resolveBin("panopticon")).toBe(target);
  });

  // The Windows code path probes PATHEXT extensions. We can't change
  // process.platform mid-test, so only run the assertion on Windows.
  it.runIf(IS_WIN)("probes PATHEXT extensions on Windows", () => {
    const target = path.join(tmpDir, "panopticon.cmd");
    fs.writeFileSync(target, "@echo off\r\necho hi\r\n");
    process.env.PATH = tmpDir;
    process.env.PATHEXT = ".com;.exe;.bat;.cmd";
    expect(resolveBin("panopticon")).toBe(target);
  });

  it("uses the extension as-is when the name already includes one", () => {
    const target = path.join(tmpDir, "panopticon.cmd");
    fs.writeFileSync(target, "x", { mode: 0o755 });
    process.env.PATH = tmpDir;
    // Even on Windows with PATHEXT set, an explicit extension is honored
    // directly rather than being appended to (no panopticon.cmd.cmd probe).
    expect(resolveBin("panopticon.cmd")).toBe(target);
  });
});

describe("quoteWinArg", () => {
  it("leaves bare-word args untouched", () => {
    expect(quoteWinArg("install")).toBe("install");
    expect(quoteWinArg("@fml-inc/panopticon@latest")).toBe(
      "@fml-inc/panopticon@latest",
    );
    expect(quoteWinArg("fml@local-plugins")).toBe("fml@local-plugins");
    expect(quoteWinArg("--version")).toBe("--version");
  });

  it("returns empty quotes for empty string", () => {
    expect(quoteWinArg("")).toBe('""');
  });

  it("quotes args containing spaces", () => {
    // Wrapped quotes are themselves cmd-escaped with ^.
    expect(quoteWinArg("hello world")).toBe('^"hello world^"');
  });

  it("escapes embedded double quotes (CRT layer)", () => {
    // " → \", and the surrounding quotes get cmd-escaped to ^"
    expect(quoteWinArg('say "hi"')).toBe('^"say \\^"hi\\^"^"');
  });

  it("escapes cmd.exe metacharacters", () => {
    // & must not be interpreted by cmd as a command separator.
    const out = quoteWinArg("a & b");
    expect(out.startsWith('^"')).toBe(true);
    expect(out.endsWith('^"')).toBe(true);
    expect(out).toContain("^&");
  });

  it("doubles trailing backslashes before the closing quote", () => {
    // Without doubling, the closing " would be escaped by the trailing \.
    expect(quoteWinArg("path\\")).toBe('^"path\\\\^"');
  });
});
