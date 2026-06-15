import { describe, expect, it } from "vitest";
import { extractHookNotice, normalizeHookOutput } from "./handler.js";

describe("normalizeHookOutput", () => {
  it("turns bare operational errors into a no-op hook response", () => {
    expect(normalizeHookOutput({ error: "unauthorized" })).toEqual({});
    expect(normalizeHookOutput({ error: "hook ingest failed" })).toEqual({});
  });

  it("preserves valid hook decisions", () => {
    const decision = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked",
      },
    };

    expect(normalizeHookOutput(decision)).toEqual(decision);
  });

  it("drops error metadata without discarding a target-specific decision", () => {
    expect(
      normalizeHookOutput({
        error: "ignored",
        decision: "allow",
        reason: "allowed by policy",
      }),
    ).toEqual({
      decision: "allow",
      reason: "allowed by policy",
    });
  });

  it("strips internal Panopticon notices from hook stdout", () => {
    expect(
      normalizeHookOutput({
        panopticonNotice: "Panopticon: surfaced prior work for src/a.ts",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "ctx",
        },
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "ctx",
      },
    });
  });

  it("extracts a single-line Panopticon hook notice", () => {
    expect(
      extractHookNotice({
        panopticonNotice: " Panopticon:\n surfaced prior work\tfor src/a.ts ",
      }),
    ).toBe("Panopticon: surfaced prior work for src/a.ts");
    expect(extractHookNotice({ panopticonNotice: "" })).toBeNull();
  });
});
