/**
 * Shared interfaces for best-effort local inference tasks.
 *
 * These tasks are enrichment layers on top of deterministic panopticon data,
 * not replacements for the underlying truth model.
 *
 * Design constraints:
 * - every task must have a deterministic fallback
 * - LLM output must be parsed into a typed result
 * - LLM failure must not block the caller
 * - callers must be able to tell whether a result came from fallback or LLM
 */

export type InferenceOutputMode = "text" | "json";

export interface InferenceRequest<TOutput> {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  withMcp?: boolean;
  outputMode: InferenceOutputMode;
  parse(rawText: string): TOutput | null;
}

export interface InferenceAvailability {
  available: boolean;
  reason?: string;
}

export interface InferenceInvocationResult<TOutput> {
  ok: boolean;
  runnerId: string;
  model?: string;
  rawText: string | null;
  output: TOutput | null;
  error?: string;
}

export interface InferenceRunner {
  id: string;
  availability(): Promise<InferenceAvailability> | InferenceAvailability;
  invoke<TOutput>(
    request: InferenceRequest<TOutput>,
  ): Promise<InferenceInvocationResult<TOutput>>;
}

export type EnrichmentSource = "deterministic" | "llm";

export interface EnrichmentResult<TOutput> {
  ok: boolean;
  source: EnrichmentSource;
  output: TOutput | null;
  rawText?: string | null;
  runnerId?: string;
  model?: string;
  reason?: string;
}

/**
 * Task contract for a typed enrichment operation.
 *
 * The deterministic fallback is required. It may return null when no sensible
 * fallback exists, but every task must make that choice explicitly rather than
 * silently assuming LLM availability.
 */
export interface EnrichmentTask<TInput, TOutput> {
  kind: string;
  version: string;
  deterministic(input: TInput): TOutput | null;
  buildRequest(input: TInput): InferenceRequest<TOutput> | null;
}
