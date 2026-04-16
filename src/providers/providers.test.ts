import { describe, expect, it } from "vitest";
import { parseRoute } from "../proxy/server.js";
import {
  allProviders,
  getProvider,
  getProviderOrThrow,
  providerIds,
  registerProvider,
} from "./index.js";

describe("provider registry", () => {
  it("registers built-in providers on import", () => {
    const ids = providerIds();
    for (const id of [
      "openai",
      "anthropic",
      "google",
      "moonshot",
      "deepseek",
      "groq",
      "xai",
      "mistral",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("getProvider returns spec by id", () => {
    const openai = getProvider("openai");
    expect(openai).toBeDefined();
    expect(openai!.upstreamHost).toBe("api.openai.com");
    expect(openai!.accumulatorType).toBe("openai");
  });

  it("getProvider returns undefined for unknown id", () => {
    expect(getProvider("nonexistent")).toBeUndefined();
  });

  it("getProviderOrThrow throws on unknown id", () => {
    expect(() => getProviderOrThrow("nonexistent")).toThrow(/Unknown provider/);
  });

  it("allProviders returns the full set", () => {
    const all = allProviders();
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  it("rejects duplicate registration", () => {
    expect(() =>
      registerProvider({
        id: "openai",
        upstreamHost: "duplicate.example.com",
        accumulatorType: "openai",
      }),
    ).toThrow(/already registered/);
  });
});

describe("built-in provider rewritePath", () => {
  it("openai prepends /v1", () => {
    const p = getProvider("openai")!;
    expect(p.rewritePath!("/chat/completions", {})).toBe(
      "/v1/chat/completions",
    );
  });

  it("anthropic prepends /v1", () => {
    const p = getProvider("anthropic")!;
    expect(p.rewritePath!("/messages", {})).toBe("/v1/messages");
  });

  it("moonshot prepends /v1", () => {
    const p = getProvider("moonshot")!;
    expect(p.rewritePath!("/chat/completions", {})).toBe(
      "/v1/chat/completions",
    );
  });

  it("groq prepends /openai/v1", () => {
    const p = getProvider("groq")!;
    expect(p.rewritePath!("/chat/completions", {})).toBe(
      "/openai/v1/chat/completions",
    );
  });

  it("google passes path through unchanged", () => {
    const p = getProvider("google")!;
    expect(p.rewritePath).toBeUndefined();
  });

  // Clients split between "send unprefixed, let the proxy add /v1" (Claude
  // Code, OpenAI SDK) and "send /v1-prefixed verbatim" (OpenClaw). Rewriting
  // needs to handle both — never double-prefix.
  it("v1 rewrite is idempotent — does not double-prefix pre-prefixed paths", () => {
    for (const id of [
      "openai",
      "anthropic",
      "moonshot",
      "deepseek",
      "xai",
      "mistral",
    ]) {
      const p = getProvider(id)!;
      expect(p.rewritePath!("/v1/chat/completions", {})).toBe(
        "/v1/chat/completions",
      );
      expect(p.rewritePath!("/v1/messages", {})).toBe("/v1/messages");
    }
  });

  it("groq /openai/v1 rewrite is idempotent", () => {
    const p = getProvider("groq")!;
    expect(p.rewritePath!("/openai/v1/chat/completions", {})).toBe(
      "/openai/v1/chat/completions",
    );
    expect(p.rewritePath!("/chat/completions", {})).toBe(
      "/openai/v1/chat/completions",
    );
  });
});

describe("built-in provider accumulator types", () => {
  it("anthropic uses anthropic accumulator", () => {
    expect(getProvider("anthropic")!.accumulatorType).toBe("anthropic");
  });

  it("openai-compatible providers use openai accumulator", () => {
    for (const id of [
      "openai",
      "moonshot",
      "deepseek",
      "groq",
      "xai",
      "mistral",
      "google",
    ]) {
      expect(getProvider(id)!.accumulatorType).toBe("openai");
    }
  });
});

// These go through parseRoute rather than testing the registry in isolation
// so they cover the full URL-prefix → spec → Route flow that forwardStreaming
// consumes. Before the provider registry landed, `/proxy/anthropic/*` resolved
// through a static fallback that defaulted the accumulator to openai — which
// silently corrupted anthropic-format SSE streams. These tests lock that fix in.
describe("parseRoute picks the right accumulator per provider prefix", () => {
  it("/anthropic/v1/messages → anthropic provider, anthropic accumulator", () => {
    const route = parseRoute("/anthropic/v1/messages");
    expect(route).not.toBeNull();
    expect(route!.target).toBe("anthropic");
    expect(route!.upstream).toBe("api.anthropic.com");
    expect(route!.accumulatorType).toBe("anthropic");
  });

  it("/openai/v1/chat/completions → openai provider, openai accumulator", () => {
    const route = parseRoute("/openai/v1/chat/completions");
    expect(route).not.toBeNull();
    expect(route!.target).toBe("openai");
    expect(route!.upstream).toBe("api.openai.com");
    expect(route!.accumulatorType).toBe("openai");
  });

  it("/moonshot/v1/chat/completions → moonshot provider, openai accumulator", () => {
    const route = parseRoute("/moonshot/v1/chat/completions");
    expect(route).not.toBeNull();
    expect(route!.target).toBe("moonshot");
    expect(route!.upstream).toBe("api.moonshot.ai");
    expect(route!.accumulatorType).toBe("openai");
  });

  it("/groq/chat/completions applies /openai/v1 rewrite", () => {
    const route = parseRoute("/groq/chat/completions");
    expect(route!.path).toBe("/openai/v1/chat/completions");
  });

  it("target registry still wins on id collision (claude → anthropic upstream via target adapter)", () => {
    const route = parseRoute("/claude/v1/messages");
    expect(route).not.toBeNull();
    expect(route!.target).toBe("claude");
    expect(route!.accumulatorType).toBe("anthropic");
  });

  it("unknown prefix returns null", () => {
    expect(parseRoute("/not-a-real-provider/foo")).toBeNull();
  });
});
