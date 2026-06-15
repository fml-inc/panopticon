import { describe, expect, it } from "vitest";
import {
  parseDiffstatFiles,
  selectCandidates,
  validateSolutionFreePrompt,
} from "./eval-prepare-one-shot.js";

describe("one-shot replay preparation", () => {
  it("selects explicit PRs in requested order before applying the limit", () => {
    const selected = selectCandidates(
      [
        {
          session_id: "s1",
          pr_number: 1,
          merge_commit: "m1",
          files: 1,
          total: 1,
        },
        {
          session_id: "s2",
          pr_number: 2,
          merge_commit: "m2",
          files: 1,
          total: 1,
        },
        {
          session_id: "s3",
          pr_number: 3,
          merge_commit: "m3",
          files: 1,
          total: 1,
        },
      ],
      {
        prNumbers: [3, 1],
        sessionIds: [],
        limit: 2,
        maxFiles: null,
        maxTotal: null,
      },
    );

    expect(selected.map((row) => row.pr_number)).toEqual([3, 1]);
  });

  it("prefers small candidates when no explicit PR order is provided", () => {
    const selected = selectCandidates(
      [
        {
          session_id: "large",
          pr_number: 10,
          merge_commit: "m10",
          files: 2,
          total: 100,
        },
        {
          session_id: "small",
          pr_number: 11,
          merge_commit: "m11",
          files: 1,
          total: 4,
        },
      ],
      {
        prNumbers: [],
        sessionIds: [],
        limit: 1,
        maxFiles: null,
        maxTotal: null,
      },
    );

    expect(selected[0]?.pr_number).toBe(11);
  });

  it("parses diffstat file rows and rename syntax", () => {
    expect(
      parseDiffstatFiles(`src/{old.ts => new.ts} | 2 +-
 package.json           | 1 +
 2 files changed, 2 insertions(+), 1 deletion(-)`),
    ).toEqual(["package.json", "src/new.ts"]);
  });

  it("flags prompt leakage of oracle file paths and metadata", () => {
    expect(
      validateSolutionFreePrompt(
        "Update package.json on branch fix/demo.",
        {
          session_id: "s",
          pr_number: 1,
          merge_commit: "abc123",
          branch: "fix/demo",
        },
        ["package.json"],
      ),
    ).toEqual([
      "mentions changed file path: package.json",
      "mentions oracle metadata: fix/demo",
      "appears to direct edits to a specific file",
    ]);
  });
});
