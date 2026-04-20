import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    enableSessionSummaryProjections: false,
  },
}));

import { isToolName, TOOL_NAMES } from "./transport.js";

describe("service transport with session summary projections disabled", () => {
  it("does not expose the session summary tool surface", () => {
    expect(TOOL_NAMES).not.toContain("session_summaries");
    expect(TOOL_NAMES).not.toContain("session_summary_detail");
    expect(TOOL_NAMES).not.toContain("why_code");
    expect(TOOL_NAMES).not.toContain("recent_work_on_path");

    expect(isToolName("session_summaries")).toBe(false);
    expect(isToolName("session_summary_detail")).toBe(false);
    expect(isToolName("why_code")).toBe(false);
    expect(isToolName("recent_work_on_path")).toBe(false);
  });
});
