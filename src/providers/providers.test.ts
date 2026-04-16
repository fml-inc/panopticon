import { describe, expect, it } from "vitest";
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
