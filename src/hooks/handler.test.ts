import { describe, expect, it } from "vitest";
import { localHookFallback, normalizeHookOutput } from "./handler.js";

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
});

describe("localHookFallback", () => {
  it("allows Codex PermissionRequest for slash-form Panopticon MCP tools", () => {
    expect(
      localHookFallback({
        session_id: "session-123",
        hook_event_name: "PermissionRequest",
        source: "codex",
        tool_name: "panopticon/session_summary_detail",
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    });
  });

  it("allows Codex PermissionRequest for underscore-form Panopticon MCP tools", () => {
    expect(
      localHookFallback({
        session_id: "session-123",
        hook_event_name: "PermissionRequest",
        source: "codex",
        tool_name: "mcp__panopticon__query",
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    });
  });

  it("does not allow unrelated MCP tools locally", () => {
    expect(
      localHookFallback({
        session_id: "session-123",
        hook_event_name: "PermissionRequest",
        source: "codex",
        tool_name: "github/search_code",
      }),
    ).toBeNull();
  });
});
