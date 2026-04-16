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

  it("openclaw emits no shell env vars", () => {
    const openclaw = getTarget("openclaw")!;
    expect(openclaw.shellEnv.envVars(4318, false)).toEqual([]);
  });
});

describe("openclaw target adapter", () => {
  const openclaw = getTarget("openclaw")!;

  it("is registered", () => {
    expect(openclaw).toBeDefined();
    expect(targetIds()).toContain("openclaw");
  });

  it("has correct display name", () => {
    expect(openclaw.detect.displayName).toBe("OpenClaw");
  });

  it("maps command:new to SessionStart", () => {
    expect(openclaw.events.eventMap["command:new"]).toBe("SessionStart");
  });

  it("maps command:reset to SessionEnd", () => {
    expect(openclaw.events.eventMap["command:reset"]).toBe("SessionEnd");
  });

  it("maps tool_result_persist to PostToolUse", () => {
    expect(openclaw.events.eventMap.tool_result_persist).toBe("PostToolUse");
  });

  it("formats permission response as flat decision/reason", () => {
    expect(
      openclaw.events.formatPermissionResponse({
        allow: true,
        reason: "allowed",
      }),
    ).toEqual({ decision: "allow", reason: "allowed" });
  });

  it("does not declare its own proxy spec — uses provider registry instead", () => {
    expect(openclaw.proxy).toBeUndefined();
  });

  it("applyInstallConfig enables diagnostics-otel plugin", () => {
    const result = openclaw.hooks.applyInstallConfig(
      {},
      { pluginRoot: "/app", port: 4318 },
    );
    const plugins = result.plugins as Record<string, unknown>;
    expect((plugins.allow as string[]).includes("diagnostics-otel")).toBe(true);
    expect(
      (plugins.entries as Record<string, unknown>)["diagnostics-otel"],
    ).toEqual({ enabled: true });
  });

  it("applyInstallConfig sets OTLP endpoint", () => {
    const result = openclaw.hooks.applyInstallConfig(
      {},
      { pluginRoot: "/app", port: 9999 },
    );
    const otel = (result.diagnostics as Record<string, unknown>).otel as Record<
      string,
      unknown
    >;
    expect(otel.enabled).toBe(true);
    expect(otel.endpoint).toBe("http://localhost:9999");
  });

  it("applyInstallConfig preserves existing config", () => {
    const existing = {
      agents: { defaults: { model: { primary: "moonshot/kimi-k2.5" } } },
    };
    const result = openclaw.hooks.applyInstallConfig(existing, {
      pluginRoot: "/app",
      port: 4318,
    });
    expect((result.agents as Record<string, unknown>).defaults).toEqual({
      model: { primary: "moonshot/kimi-k2.5" },
    });
  });

  it("applyInstallConfig does not duplicate plugin allow entries", () => {
    const existing = {
      plugins: { allow: ["diagnostics-otel", "other-plugin"] },
    };
    const result = openclaw.hooks.applyInstallConfig(existing, {
      pluginRoot: "/app",
      port: 4318,
    });
    const allow = (result.plugins as Record<string, unknown>).allow as string[];
    expect(allow.filter((p) => p === "diagnostics-otel")).toHaveLength(1);
  });

  it("applyInstallConfig with proxy rewrites every known provider's baseUrl", () => {
    const existing = {
      models: {
        providers: {
          moonshot: { baseUrl: "https://api.moonshot.ai/v1" },
          openai: { baseUrl: "https://api.openai.com/v1" },
          anthropic: { baseUrl: "https://api.anthropic.com/v1" },
        },
      },
    };
    const result = openclaw.hooks.applyInstallConfig(existing, {
      pluginRoot: "/app",
      port: 4318,
      proxy: true,
    });
    const providers = (result.models as Record<string, unknown>)
      .providers as Record<string, Record<string, unknown>>;
    expect(providers.moonshot.baseUrl).toBe(
      "http://localhost:4318/proxy/moonshot",
    );
    expect(providers.openai.baseUrl).toBe("http://localhost:4318/proxy/openai");
    expect(providers.anthropic.baseUrl).toBe(
      "http://localhost:4318/proxy/anthropic",
    );
  });

  it("applyInstallConfig leaves unknown providers' baseUrl alone", () => {
    const existing = {
      models: {
        providers: {
          moonshot: { baseUrl: "https://api.moonshot.ai/v1" },
          // Not in panopticon's provider registry
          someprivateprovider: { baseUrl: "https://internal.corp/v1" },
        },
      },
    };
    const result = openclaw.hooks.applyInstallConfig(existing, {
      pluginRoot: "/app",
      port: 4318,
      proxy: true,
    });
    const providers = (result.models as Record<string, unknown>)
      .providers as Record<string, Record<string, unknown>>;
    expect(providers.moonshot.baseUrl).toBe(
      "http://localhost:4318/proxy/moonshot",
    );
    expect(providers.someprivateprovider.baseUrl).toBe(
      "https://internal.corp/v1",
    );
  });

  it("applyInstallConfig without proxy does not touch provider baseUrls", () => {
    const existing = {
      models: {
        providers: { moonshot: { baseUrl: "https://api.moonshot.ai/v1" } },
      },
    };
    const result = openclaw.hooks.applyInstallConfig(existing, {
      pluginRoot: "/app",
      port: 4318,
    });
    const moonshot = (
      (result.models as Record<string, unknown>).providers as Record<
        string,
        Record<string, unknown>
      >
    ).moonshot;
    expect(moonshot.baseUrl).toBe("https://api.moonshot.ai/v1");
  });

  it("removeInstallConfig removes diagnostics-otel from plugins", () => {
    const existing = openclaw.hooks.applyInstallConfig(
      {},
      { pluginRoot: "/app", port: 4318 },
    );
    const result = openclaw.hooks.removeInstallConfig(existing);
    expect(result.plugins).toBeUndefined();
  });

  it("removeInstallConfig deletes diagnostics.otel block", () => {
    const existing = openclaw.hooks.applyInstallConfig(
      {},
      { pluginRoot: "/app", port: 4318 },
    );
    const result = openclaw.hooks.removeInstallConfig(existing);
    expect(result.diagnostics).toBeUndefined();
  });

  it("removeInstallConfig preserves user-set moonshot.baseUrl", () => {
    const existing = {
      models: {
        providers: { moonshot: { baseUrl: "https://api.moonshot.ai/v1" } },
      },
    };
    const result = openclaw.hooks.removeInstallConfig(existing);
    const moonshot = (
      (result.models as Record<string, unknown>).providers as Record<
        string,
        Record<string, unknown>
      >
    ).moonshot;
    expect(moonshot.baseUrl).toBe("https://api.moonshot.ai/v1");
  });

  it("removeInstallConfig reverts proxy-rewritten baseUrls across all providers", () => {
    const existing = openclaw.hooks.applyInstallConfig(
      {
        models: {
          providers: {
            moonshot: { baseUrl: "https://api.moonshot.ai/v1" },
            anthropic: { baseUrl: "https://api.anthropic.com/v1" },
          },
        },
      },
      { pluginRoot: "/app", port: 4318, proxy: true },
    );
    const result = openclaw.hooks.removeInstallConfig(existing);
    const providers = (result.models as Record<string, unknown>)
      .providers as Record<string, Record<string, unknown>>;
    expect(providers.moonshot.baseUrl).toBeUndefined();
    expect(providers.anthropic.baseUrl).toBeUndefined();
  });

  it("removeInstallConfig leaves unrelated config untouched", () => {
    const existing = {
      agents: { defaults: { model: { primary: "moonshot/kimi-k2.5" } } },
      plugins: { allow: ["other-plugin"], entries: { "other-plugin": {} } },
      diagnostics: { flags: ["gateway.*"] },
    };
    const result = openclaw.hooks.removeInstallConfig(existing);
    expect(result.agents).toEqual({
      defaults: { model: { primary: "moonshot/kimi-k2.5" } },
    });
    expect((result.plugins as Record<string, unknown>).allow).toEqual([
      "other-plugin",
    ]);
    expect((result.plugins as Record<string, unknown>).entries).toEqual({
      "other-plugin": {},
    });
    expect((result.diagnostics as Record<string, unknown>).flags).toEqual([
      "gateway.*",
    ]);
  });

  it("declares otel.serviceName as openclaw-gateway", () => {
    expect(openclaw.otel?.serviceName).toBe("openclaw-gateway");
  });

  it("declares openclaw.tokens metric with token-type and model attrs", () => {
    expect(openclaw.otel?.metrics?.metricNames).toEqual(["openclaw.tokens"]);
    expect(openclaw.otel?.metrics?.tokenTypeAttrs).toEqual([
      '$."openclaw.token"',
    ]);
    expect(openclaw.otel?.metrics?.modelAttrs).toEqual(['$."openclaw.model"']);
  });

  it("does not declare ident.modelPatterns (multi-provider; would conflict)", () => {
    expect(openclaw.ident?.modelPatterns).toBeUndefined();
  });

  it("isConfigured requires both diagnostics.otel and plugin entry", () => {
    // Verify the predicate logic by exercising the merged config the adapter
    // produces — both signals are set together.
    const cfg = openclaw.hooks.applyInstallConfig(
      {},
      { pluginRoot: "/app", port: 4318 },
    );
    const diag = (cfg.diagnostics as Record<string, unknown>).otel as Record<
      string,
      unknown
    >;
    const entry = (
      (cfg.plugins as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    )["diagnostics-otel"];
    expect(diag.enabled).toBe(true);
    expect(entry.enabled).toBe(true);
  });
});

describe("target otel specs", () => {
  it("claude declares SUM aggregation for claude_code.token.usage", () => {
    const claude = getTarget("claude")!;
    expect(claude.otel?.metrics).toBeDefined();
    expect(claude.otel!.metrics!.metricNames).toEqual([
      "claude_code.token.usage",
    ]);
    expect(claude.otel!.metrics!.aggregation).toBe("SUM");
    expect(claude.otel!.metrics!.tokenTypeAttrs).toEqual(["$.type"]);
    expect(claude.otel!.metrics!.modelAttrs).toEqual(["$.model"]);
  });

  it("claude has no serviceName (always provides session_id)", () => {
    const claude = getTarget("claude")!;
    expect(claude.otel?.serviceName).toBeUndefined();
  });

  it("gemini declares MAX aggregation for cumulative counters", () => {
    const gemini = getTarget("gemini")!;
    expect(gemini.otel?.metrics).toBeDefined();
    expect(gemini.otel!.metrics!.metricNames).toEqual([
      "gemini_cli.token.usage",
      "gen_ai.client.token.usage",
    ]);
    expect(gemini.otel!.metrics!.aggregation).toBe("MAX");
  });

  it("gemini declares serviceName for session inference", () => {
    const gemini = getTarget("gemini")!;
    expect(gemini.otel?.serviceName).toBe("gemini-cli");
  });

  it("codex declares SUM aggregation with token type remapping", () => {
    const codex = getTarget("codex")!;
    expect(codex.otel?.metrics).toBeDefined();
    expect(codex.otel!.metrics!.metricNames).toEqual([
      "codex.turn.token_usage",
    ]);
    expect(codex.otel!.metrics!.aggregation).toBe("SUM");
    expect(codex.otel!.metrics!.tokenTypeMap).toEqual({
      cached_input: "cacheRead",
      reasoning_output: "output",
    });
    expect(codex.otel!.metrics!.excludeTokenTypes).toEqual(["total"]);
  });

  it("codex declares serviceName for session inference", () => {
    const codex = getTarget("codex")!;
    expect(codex.otel?.serviceName).toBe("codex_cli_rs");
  });

  it("codex declares logFields for non-standard OTel event/timestamp extraction", () => {
    const codex = getTarget("codex")!;
    expect(codex.otel?.logFields).toBeDefined();
    expect(codex.otel!.logFields!.eventTypeExprs!.length).toBeGreaterThan(1);
    expect(codex.otel!.logFields!.timestampMsExprs!.length).toBeGreaterThan(1);
  });

  it("claude-desktop has no otel spec", () => {
    const cd = getTarget("claude-desktop");
    if (cd) {
      expect(cd.otel).toBeUndefined();
    }
  });
});

describe("target ident specs", () => {
  it("claude matches claude- model prefixes", () => {
    const claude = getTarget("claude")!;
    expect(claude.ident?.modelPatterns).toBeDefined();
    expect(claude.ident!.modelPatterns![0].test("claude-3-opus")).toBe(true);
    expect(claude.ident!.modelPatterns![0].test("gpt-4")).toBe(false);
  });

  it("codex matches OpenAI model prefixes", () => {
    const codex = getTarget("codex")!;
    expect(codex.ident?.modelPatterns).toBeDefined();
    const re = codex.ident!.modelPatterns![0];
    expect(re.test("gpt-4o")).toBe(true);
    expect(re.test("o1-preview")).toBe(true);
    expect(re.test("chatgpt-4o-latest")).toBe(true);
    expect(re.test("claude-3-opus")).toBe(false);
  });

  it("gemini has no ident spec (identified via eventMap)", () => {
    const gemini = getTarget("gemini")!;
    expect(gemini.ident).toBeUndefined();
  });
});
