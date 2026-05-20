import { describe, expect, it } from "vitest";
import {
  extractCommandPaths,
  isReadOnlyCommand,
} from "./eval-reduction-proxy.js";

describe("isReadOnlyCommand", () => {
  it("accepts pure read verbs and read-only git", () => {
    expect(isReadOnlyCommand("cat src/foo.ts")).toBe(true);
    expect(isReadOnlyCommand("rg 'pattern' src/")).toBe(true);
    expect(isReadOnlyCommand("sed -n '1,40p' src/a.ts")).toBe(true);
    expect(isReadOnlyCommand("git show HEAD:src/a.ts")).toBe(true);
    expect(isReadOnlyCommand("cd src && cat a.ts")).toBe(true);
    expect(isReadOnlyCommand("cat a.ts | grep foo | head -5")).toBe(true);
  });

  it("rejects writers, runners, and redirections", () => {
    expect(isReadOnlyCommand("cat a.ts > b.ts")).toBe(false);
    expect(isReadOnlyCommand("echo hi | tee out.txt")).toBe(false);
    expect(isReadOnlyCommand("pnpm test")).toBe(false);
    expect(isReadOnlyCommand("git commit -m x")).toBe(false);
    expect(isReadOnlyCommand("rm -rf dist")).toBe(false);
    expect(isReadOnlyCommand("sudo cat /etc/hosts")).toBe(false);
    expect(isReadOnlyCommand("cat a.ts && pnpm build")).toBe(false);
    expect(isReadOnlyCommand("")).toBe(false);
    expect(isReadOnlyCommand(null)).toBe(false);
  });
});

describe("extractCommandPaths", () => {
  it("pulls path-like tokens, skipping flags and ranges", () => {
    expect(extractCommandPaths("sed -n '1,40p' src/a.ts")).toEqual([
      "src/a.ts",
    ]);
    expect(extractCommandPaths("cat src/a.ts src/b.tsx")).toEqual([
      "src/a.ts",
      "src/b.tsx",
    ]);
    expect(extractCommandPaths("rg --hidden pattern src/")).toEqual(["src/"]);
  });

  it("ignores globs, regexes, and bare words", () => {
    expect(extractCommandPaths("rg 'foo.*bar' .")).toEqual([]);
    expect(extractCommandPaths("ls -la")).toEqual([]);
    expect(extractCommandPaths("grep -r TODO")).toEqual([]);
  });
});
