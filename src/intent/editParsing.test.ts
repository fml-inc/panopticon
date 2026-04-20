import { describe, expect, it } from "vitest";
import { parseEditEntries, parseEditEntriesFromJson } from "./editParsing.js";

describe("parseEditEntries apply_patch", () => {
  it("parses multi-file add, update, and delete patches with relative paths", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/main.ts",
      "@@",
      "-const value = 0;",
      "+const value = 1;",
      "*** Add File: docs/LOCAL-WORKSTREAMS-V1.md",
      "+# Notes",
      "+",
      "+hello",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ].join("\n");

    const entries = parseEditEntries("apply_patch", { input: patch });
    expect(entries).toHaveLength(3);

    expect(entries[0]).toMatchObject({
      filePath: "src/main.ts",
      newString: "const value = 1;",
      oldStrings: ["const value = 0;"],
      deletedFile: false,
    });
    expect(entries[1]).toMatchObject({
      filePath: "docs/LOCAL-WORKSTREAMS-V1.md",
      newString: "# Notes\n\nhello",
      oldStrings: [],
      deletedFile: false,
    });
    expect(entries[2]).toMatchObject({
      filePath: "src/old.ts",
      newString: "",
      oldStrings: [],
      deletedFile: true,
    });
  });

  it("treats deletion-only hunks as removals, not insertions", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/delete-only.ts",
      "@@",
      "-const removed = true;",
      "*** End Patch",
    ].join("\n");

    const entries = parseEditEntries("apply_patch", { input: patch });
    expect(entries).toEqual([
      {
        filePath: "src/delete-only.ts",
        newString: "",
        oldStrings: ["const removed = true;"],
        multiEditIndex: 0,
        deletedFile: false,
      },
    ]);
  });

  it("preserves rename-only patches as a delete plus add", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      "*** End Patch",
    ].join("\n");

    const entries = parseEditEntries("apply_patch", { input: patch });
    expect(entries).toEqual([
      {
        filePath: "src/old-name.ts",
        newString: "",
        oldStrings: [],
        multiEditIndex: 0,
        deletedFile: true,
      },
      {
        filePath: "src/new-name.ts",
        newString: "",
        oldStrings: [],
        multiEditIndex: 1,
        deletedFile: false,
      },
    ]);
  });

  it("splits multiple hunks in one file into distinct entries", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /workspace/src/main.ts",
      "@@",
      "-const a = 1;",
      "+const a = 2;",
      "@@",
      "-const b = 3;",
      "+const b = 4;",
      "*** End Patch",
    ].join("\n");

    const entries = parseEditEntriesFromJson(
      "apply_patch",
      JSON.stringify({ input: patch }),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      filePath: "/workspace/src/main.ts",
      newString: "const a = 2;",
      oldStrings: ["const a = 1;"],
      deletedFile: false,
    });
    expect(entries[1]).toMatchObject({
      filePath: "/workspace/src/main.ts",
      newString: "const b = 4;",
      oldStrings: ["const b = 3;"],
      deletedFile: false,
    });
  });
});
