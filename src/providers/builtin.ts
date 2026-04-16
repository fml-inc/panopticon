/**
 * Built-in provider entries — upstream LLM APIs panopticon knows how to
 * forward to. Each entry declares the host, optional path rewrite, and
 * which streaming accumulator format to use when capturing responses.
 *
 * Add a new provider by appending to the array. Tests in providers.test.ts
 * verify that builtin entries register without conflict.
 */
import { registerProvider } from "./registry.js";
import type { ProviderSpec } from "./types.js";

/**
 * Prepend `/v1` only when the client didn't already send a `/v1` prefix.
 * Some clients (Claude Code via ANTHROPIC_BASE_URL, the OpenAI SDK with a
 * base URL set) send unprefixed paths like `/messages` and expect the proxy
 * to add the version. Others (OpenClaw's anthropic gateway plugin) honor the
 * configured baseUrl verbatim and send `/v1/messages` themselves. Unconditional
 * prepending double-prefixes the second case to `/v1/v1/messages`, which every
 * upstream 404s. Idempotent rewrite handles both client conventions.
 */
const v1 = (p: string) => (p === "/v1" || p.startsWith("/v1/") ? p : `/v1${p}`);

const openaiV1 = (p: string) =>
  p === "/openai/v1" || p.startsWith("/openai/v1/") ? p : `/openai/v1${p}`;

const BUILTIN: ProviderSpec[] = [
  // OpenAI and OpenAI-compatible providers
  {
    id: "openai",
    upstreamHost: "api.openai.com",
    rewritePath: v1,
    accumulatorType: "openai",
  },
  {
    id: "moonshot",
    upstreamHost: "api.moonshot.ai",
    rewritePath: v1,
    accumulatorType: "openai",
  },
  {
    id: "deepseek",
    upstreamHost: "api.deepseek.com",
    rewritePath: v1,
    accumulatorType: "openai",
  },
  {
    id: "xai",
    upstreamHost: "api.x.ai",
    rewritePath: v1,
    accumulatorType: "openai",
  },
  {
    id: "mistral",
    upstreamHost: "api.mistral.ai",
    rewritePath: v1,
    accumulatorType: "openai",
  },
  {
    id: "groq",
    upstreamHost: "api.groq.com",
    rewritePath: openaiV1,
    accumulatorType: "openai",
  },

  // Anthropic
  {
    id: "anthropic",
    upstreamHost: "api.anthropic.com",
    rewritePath: v1,
    accumulatorType: "anthropic",
  },

  // Google Gemini — passthrough path; Gemini's URL convention bakes the version
  // into the request path already (e.g. /v1beta/models/...:streamGenerateContent).
  {
    id: "google",
    upstreamHost: "generativelanguage.googleapis.com",
    accumulatorType: "openai",
  },
];

for (const spec of BUILTIN) {
  registerProvider(spec);
}
