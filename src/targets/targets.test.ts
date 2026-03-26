import { describe, expect, it } from "vitest";
import type { HookInput } from "../hooks/ingest.js";
import { allTargets, getTarget, targetIds } from "./index.js";

describe("target registry", () => {
  it("registers claude, gemini, and codex", () => {
    expect(targetIds()).toContain("claude");
    expect(targetIds()).toContain("gemini");
    expect(targetIds()).toContain("codex");
  });

  it("getTarget returns adapter by id", () => {
    const claude = getTarget("claude");
    expect(claude).toBeDefined();
    expect(claude!.id).toBe("claude");
    expect(claude!.detect.displayName).toBe("Claude Code");
  });

  it("getTarget returns undefined for unknown target", () => {
    expect(getTarget("nonexistent")).toBeUndefined();
  });

  it("allTargets returns all registered adapters", () => {
    const targets = allTargets();
    expect(targets.length).toBeGreaterThanOrEqual(3);
    const ids = targets.map((v) => v.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("gemini");
    expect(ids).toContain("codex");
  });
});

describe("gemini event normalization", () => {
  const gemini = getTarget("gemini")!;

  it("maps BeforeTool to PreToolUse", () => {
    expect(gemini.events.eventMap.BeforeTool).toBe("PreToolUse");
  });

  it("maps AfterTool to PostToolUse", () => {
    expect(gemini.events.eventMap.AfterTool).toBe("PostToolUse");
  });

  it("maps BeforeModel to UserPromptSubmit", () => {
    expect(gemini.events.eventMap.BeforeModel).toBe("UserPromptSubmit");
  });

  it("normalizePayload extracts user_prompt from llm_request.messages (string content)", () => {
    const data: HookInput = {
      session_id: "test",
      hook_event_name: "BeforeModel",
      llm_request: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello world" },
        ],
      },
    };
    const result = gemini.events.normalizePayload!(data);
    expect((result as Record<string, unknown>).user_prompt).toBe("Hello world");
  });

  it("normalizePayload extracts user_prompt from llm_request.messages (array content)", () => {
    const data: HookInput = {
      session_id: "test",
      hook_event_name: "BeforeModel",
      llm_request: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "first" },
              { type: "image", url: "http://example.com" },
              { type: "text", text: "second" },
            ],
          },
        ],
      },
    };
    const result = gemini.events.normalizePayload!(data);
    expect((result as Record<string, unknown>).user_prompt).toBe(
      "first\nsecond",
    );
  });

  it("normalizePayload is a no-op when no llm_request", () => {
    const data: HookInput = {
      session_id: "test",
      hook_event_name: "BeforeModel",
    };
    const result = gemini.events.normalizePayload!(data);
    expect((result as Record<string, unknown>).user_prompt).toBeUndefined();
  });
});

describe("permission response formatting", () => {
  it("claude formats as hookSpecificOutput", () => {
    const claude = getTarget("claude")!;
    const response = claude.events.formatPermissionResponse({
      allow: true,
      reason: "Tool is allowed",
    });
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Tool is allowed",
      },
    });
  });

  it("gemini formats as flat decision/reason", () => {
    const gemini = getTarget("gemini")!;
    const response = gemini.events.formatPermissionResponse({
      allow: true,
      reason: "Tool is allowed",
    });
    expect(response).toEqual({
      decision: "allow",
      reason: "Tool is allowed",
    });
  });

  it("codex formats as hookSpecificOutput (same as claude)", () => {
    const codex = getTarget("codex")!;
    const response = codex.events.formatPermissionResponse({
      allow: true,
      reason: "Tool is allowed",
    });
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Tool is allowed",
      },
    });
  });
});

describe("target proxy specs", () => {
  it("claude proxies to api.anthropic.com with anthropic accumulator", () => {
    const claude = getTarget("claude")!;
    expect(claude.proxy).toBeDefined();
    expect(claude.proxy!.upstreamHost).toBe("api.anthropic.com");
    expect(claude.proxy!.accumulatorType).toBe("anthropic");
  });

  it("gemini proxies to google with openai accumulator", () => {
    const gemini = getTarget("gemini")!;
    expect(gemini.proxy).toBeDefined();
    expect(gemini.proxy!.upstreamHost).toBe(
      "generativelanguage.googleapis.com",
    );
    expect(gemini.proxy!.accumulatorType).toBe("openai");
  });

  it("codex has dynamic upstream based on auth header", () => {
    const codex = getTarget("codex")!;
    expect(codex.proxy).toBeDefined();
    expect(typeof codex.proxy!.upstreamHost).toBe("function");

    const fn = codex.proxy!.upstreamHost as (
      h: Record<string, string>,
    ) => string;
    // API key → api.openai.com
    expect(fn({ authorization: "Bearer sk-test123" })).toBe("api.openai.com");
    // JWT → chatgpt.com
    expect(fn({ authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.test" })).toBe(
      "chatgpt.com",
    );
  });

  it("codex rewrites path based on auth header", () => {
    const codex = getTarget("codex")!;
    const rewrite = codex.proxy!.rewritePath!;

    // API key → /v1 prefix
    expect(
      rewrite("/chat/completions", { authorization: "Bearer sk-test" }),
    ).toBe("/v1/chat/completions");
    // JWT → /backend-api/codex prefix
    expect(
      rewrite("/chat/completions", { authorization: "Bearer eyJtest" }),
    ).toBe("/backend-api/codex/chat/completions");
  });
});

describe("target shell env vars", () => {
  it("claude emits CLAUDE_CODE_ENABLE_TELEMETRY", () => {
    const claude = getTarget("claude")!;
    const vars = claude.shellEnv.envVars(4318, false);
    expect(vars).toContainEqual(["CLAUDE_CODE_ENABLE_TELEMETRY", "1"]);
  });

  it("claude emits ANTHROPIC_BASE_URL when proxy is true", () => {
    const claude = getTarget("claude")!;
    const vars = claude.shellEnv.envVars(4318, true);
    const baseUrl = vars.find(([k]) => k === "ANTHROPIC_BASE_URL");
    expect(baseUrl).toBeDefined();
    expect(baseUrl![1]).toContain("/proxy/anthropic");
  });

  it("claude omits ANTHROPIC_BASE_URL when proxy is false", () => {
    const claude = getTarget("claude")!;
    const vars = claude.shellEnv.envVars(4318, false);
    expect(vars.find(([k]) => k === "ANTHROPIC_BASE_URL")).toBeUndefined();
  });

  it("gemini emits telemetry vars with correct port", () => {
    const gemini = getTarget("gemini")!;
    const vars = gemini.shellEnv.envVars(9999, false);
    expect(vars).toContainEqual(["GEMINI_TELEMETRY_ENABLED", "true"]);
    expect(vars).toContainEqual([
      "GEMINI_TELEMETRY_OTLP_ENDPOINT",
      "http://localhost:9999",
    ]);
  });

  it("codex emits no shell env vars", () => {
    const codex = getTarget("codex")!;
    expect(codex.shellEnv.envVars(4318, false)).toEqual([]);
  });
});
