import { describe, expect, it } from "vitest";
import { isClaudeUserConfigPath } from "./config.js";

describe("isClaudeUserConfigPath", () => {
  it("matches memory files under any project slug", () => {
    expect(
      isClaudeUserConfigPath(
        "/Users/gus/.claude/projects/-Users-gus-workspace-panopticon/memory/MEMORY.md",
      ),
    ).toBe(true);
    expect(
      isClaudeUserConfigPath(
        "/Users/gus/.claude/projects/-Users-gus-workspace-fml-inc-fml/memory/feedback_pnpm_add.md",
      ),
    ).toBe(true);
  });

  it("matches memory files nested in subdirectories", () => {
    expect(
      isClaudeUserConfigPath(
        "/home/ubuntu/.claude/projects/foo/memory/notes/topic.md",
      ),
    ).toBe(true);
  });

  it("does not match non-.md files in memory/", () => {
    expect(
      isClaudeUserConfigPath(
        "/Users/gus/.claude/projects/foo/memory/MEMORY.md.bak",
      ),
    ).toBe(false);
    expect(
      isClaudeUserConfigPath(
        "/Users/gus/.claude/projects/foo/memory/state.json",
      ),
    ).toBe(false);
  });
});
