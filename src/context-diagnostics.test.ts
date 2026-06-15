import { describe, expect, it } from "vitest";
import {
  type ContextActivity,
  type ContextFlagStatus,
  contextActivityHealth,
  contextFlagsHealth,
  formatContextActivity,
  formatContextFlags,
  formatHookTargets,
  type HookTargetStatus,
  hookTargetsHealth,
} from "./context-diagnostics.js";

describe("context diagnostics formatting", () => {
  it("summarizes context flags and warns only for required disabled flags", () => {
    const flags: ContextFlagStatus[] = [
      {
        label: "SessionStart",
        env: "PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION",
        enabled: true,
        required: true,
      },
      {
        label: "PreToolUse read",
        env: "PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION",
        enabled: true,
        required: true,
      },
      {
        label: "CRG file_overview",
        env: "PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW",
        enabled: false,
        required: false,
      },
      {
        label: "Context notices",
        env: "PANOPTICON_ENABLE_CONTEXT_NOTICES",
        enabled: false,
        required: false,
      },
    ];

    expect(formatContextFlags(flags)).toBe(
      "SessionStart=on, PreToolUse read=on, CRG file_overview=off, Context notices=off",
    );
    expect(contextFlagsHealth(flags)).toBe("ok");
    expect(contextFlagsHealth([{ ...flags[0], enabled: false }])).toBe("warn");
    expect(contextFlagsHealth([{ ...flags[1], enabled: false }])).toBe("warn");
  });

  it("summarizes hook targets and warns when source identity is missing", () => {
    const targets: HookTargetStatus[] = [
      {
        id: "codex",
        name: "Codex CLI",
        installed: true,
        configured: true,
        source: "explicit",
      },
      {
        id: "claude",
        name: "Claude Code",
        installed: true,
        configured: true,
        source: "native",
      },
    ];

    expect(formatHookTargets(targets)).toBe(
      "Codex CLI=source=explicit, Claude Code=source=native",
    );
    expect(hookTargetsHealth(targets)).toBe("ok");
    expect(hookTargetsHealth([{ ...targets[0], source: "unknown" }])).toBe(
      "warn",
    );
    expect(formatHookTargets([])).toBe("No supported coding tools found");
    expect(hookTargetsHealth([])).toBe("warn");
  });

  it("summarizes recent context-eligible hook activity", () => {
    const activity: ContextActivity = {
      sinceMs: 1,
      windowHours: 24,
      sessionStart: 2,
      userPromptSubmit: 3,
      preToolUseRead: 4,
      preToolUseEdit: 5,
    };

    expect(formatContextActivity(activity)).toBe(
      "last 24h: SessionStart=2, UserPromptSubmit=3, PreToolUse Read=4, PreToolUse edit=5",
    );
    expect(contextActivityHealth(activity)).toBe("ok");
    expect(contextActivityHealth(null)).toBe("warn");
  });
});
