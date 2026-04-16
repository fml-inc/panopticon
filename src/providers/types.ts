/**
 * Provider adapter — declares forwarding rules for a single upstream LLM API.
 *
 * Providers are upstream APIs (openai, anthropic, moonshot, ...). Targets are
 * coding tools (claude, codex, openclaw, ...). A target may use one or many
 * providers; a provider may serve one or many targets.
 *
 * The proxy server (`src/proxy/server.ts`) accepts requests under
 * `/<id>/<path>`. Resolution checks targets first (target wins on id match,
 * preserving dynamic routing like codex JWT detection), then providers.
 *
 * Same shape as `TargetProxySpec` in src/targets/types.ts — kept separate so
 * the registry is self-documenting and can evolve independently.
 */
export interface ProviderSpec {
  /** Machine identifier: "openai", "anthropic", "moonshot", ... */
  id: string;
  /**
   * Upstream API host. String for static routing; function when the upstream
   * depends on incoming headers (e.g. JWT-vs-API-key auth detection).
   */
  upstreamHost: string | ((headers: Record<string, string>) => string);
  /** Path rewrite, e.g. prepend "/v1". Default: pass through. */
  rewritePath?(path: string, headers: Record<string, string>): string;
  /** Stream accumulator format for capturing responses. */
  accumulatorType: "openai" | "anthropic";
}
