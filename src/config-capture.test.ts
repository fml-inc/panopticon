import { describe, expect, it } from "vitest";
import {
  extractWrittenFilePath,
  isTrackedUserConfigPath,
} from "./config-capture.js";

describe("isTrackedUserConfigPath", () => {
  it("matches memory files under any project slug", () => {
    expect(
      isTrackedUserConfigPath(
        "/Users/gus/.claude/projects/-Users-gus-workspace-panopticon/memory/MEMORY.md",
      ),
    ).toBe(true);
    expect(
      isTrackedUserConfigPath(
        "/Users/gus/.claude/projects/-Users-gus-workspace-fml-inc-fml/memory/feedback_pnpm_add.md",
      ),
    ).toBe(true);
  });

  it("matches memory files nested in subdirectories", () => {
    expect(
      isTrackedUserConfigPath(
        "/home/ubuntu/.claude/projects/foo/memory/notes/topic.md",
      ),
    ).toBe(true);
  });

  it("does not match non-.md files in memory/", () => {
    expect(
      isTrackedUserConfigPath(
        "/Users/gus/.claude/projects/foo/memory/MEMORY.md.bak",
      ),
    ).toBe(false);
    expect(
      isTrackedUserConfigPath(
        "/Users/gus/.claude/projects/foo/memory/state.json",
      ),
    ).toBe(false);
  });

  it("matches panopticon permissions files across platforms", () => {
    expect(
      isTrackedUserConfigPath(
        "/Users/gus/Library/Application Support/panopticon/permissions/allowed.json",
      ),
    ).toBe(true);
    expect(
      isTrackedUserConfigPath(
        "/home/ubuntu/.local/share/panopticon/permissions/approvals.json",
      ),
    ).toBe(true);
    expect(
      isTrackedUserConfigPath(
        "C:\\Users\\x\\AppData\\Roaming\\panopticon\\permissions\\allowed.json",
      ),
    ).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(isTrackedUserConfigPath("/Users/gus/workspace/foo.ts")).toBe(false);
    expect(isTrackedUserConfigPath("/Users/gus/.claude/settings.json")).toBe(
      false,
    );
    expect(
      isTrackedUserConfigPath(
        "/Users/gus/.claude/projects/foo/memorycommand.md",
      ),
    ).toBe(false);
  });
});

describe("extractWrittenFilePath", () => {
  it("returns file_path for Edit/Write/MultiEdit inputs", () => {
    expect(extractWrittenFilePath({ file_path: "/a/b.md" })).toBe("/a/b.md");
  });

  it("returns notebook_path for NotebookEdit inputs", () => {
    expect(extractWrittenFilePath({ notebook_path: "/a/nb.ipynb" })).toBe(
      "/a/nb.ipynb",
    );
  });

  it("prefers file_path over notebook_path when both present", () => {
    expect(
      extractWrittenFilePath({
        file_path: "/a/b.md",
        notebook_path: "/a/c.ipynb",
      }),
    ).toBe("/a/b.md");
  });

  it("returns null when neither field is set", () => {
    expect(extractWrittenFilePath({})).toBeNull();
    expect(extractWrittenFilePath(undefined)).toBeNull();
    expect(extractWrittenFilePath({ command: "ls" })).toBeNull();
  });

  it("returns null for empty string paths", () => {
    expect(extractWrittenFilePath({ file_path: "" })).toBeNull();
  });
});
