import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    enableSessionSummaryProjections: false,
  },
}));

import { isToolName, TOOL_NAMES } from "./transport.js";

describe("service transport with session summary projections disabled", () => {
  it("only hides projection-dependent session summary tools", () => {
    expect(TOOL_NAMES).not.toContain("session_summaries");
    expect(TOOL_NAMES).not.toContain("session_summary_detail");

    expect(isToolName("session_summaries")).toBe(false);
    expect(isToolName("session_summary_detail")).toBe(false);

    expect(TOOL_NAMES).toContain("why_code");
    expect(TOOL_NAMES).toContain("recent_work_on_path");
    expect(TOOL_NAMES).toContain("file_overview");

    expect(isToolName("why_code")).toBe(true);
    expect(isToolName("recent_work_on_path")).toBe(true);
    expect(isToolName("file_overview")).toBe(true);
  });
});
