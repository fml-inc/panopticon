# Inference Interfaces

This document defines the intended interface boundary for panopticon features
that use a headless coding agent or LLM to enrich local data.

It exists because the older summary-generation path is useful in spirit but not
reliable enough in its current form:

- it shells out directly to a specific CLI
- it expects raw text, not a typed contract
- it does not expose a reusable task interface
- it does not make fallback behavior explicit enough for future features

The goal here is to set the shape we will reuse as session summaries become
more explicit and provenance-backed, and when we later come back to:

- session summaries
- cross-session workstream titles and summaries
- "why_code" natural-language explanations
- classification or ranking tasks where deterministic signals exist but are not
  sufficient for a good UX by themselves

## Current Status On Main

The current codebase already has two distinct layers:

- deterministic local provenance queries:
  - `session_summaries`
  - `session_summary_detail`
  - `why_code`
  - `recent_work_on_path`
  - `file_overview`
- best-effort inference plumbing in `src/inference/types.ts`

The Phase 2 local session-summary/code-provenance path is currently fully
deterministic and does not shell out to a model. The remaining CLI-based
inference path lives in the older summary-generation code under
`src/summary/llm.ts`.

So this document is mainly forward-looking for presentation-grade enrichments,
not a description of the current Phase 2 read model itself.

## Rules

### 1. Deterministic truth comes first

LLM-backed inference is an enrichment layer.

It must not replace:

- event capture
- claims
- landed status
- edit extraction
- any other hard fact we can derive directly from local data

### 2. Every inference task needs an explicit deterministic fallback

Every task must define a deterministic path, even if the fallback is very
simple.

Examples:

- session summary: prompt + message count + top tools + edited files
- workstream title: truncated first prompt
- workstream summary: aggregate intent prompts + touched files + landed counts
- why-code explanation: deterministic evidence chain rendered as text

This fallback can be low quality. It cannot be implicit.

### 3. LLM output must be parsed into a typed result

No feature should rely on "whatever text the model returned."

Each task should build a request and supply a parser that returns either:

- a typed result, or
- `null` for parse failure

If parse fails, the caller should fall back deterministically.

### 4. Inference must be best-effort and non-blocking

Inference should never be required for correctness.

Failure modes:

- runner unavailable
- timeout
- CLI non-zero exit
- malformed output
- MCP/tool failure

These should all degrade into deterministic output, not user-visible breakage.

### 5. Callers need provenance for the enrichment result

For every returned enrichment result, callers should be able to tell:

- whether it came from deterministic fallback or LLM
- which runner produced it
- which model was used
- what raw text was returned when useful for debugging

This applies even when the LLM result is accepted successfully.

## Code Contract

The initial shared type contract lives in:

- [src/inference/types.ts](/Users/gus/workspace/panopticon/src/inference/types.ts)

Key pieces:

- `InferenceRunner`
  - a headless adapter such as Claude CLI or Codex CLI
- `InferenceRequest<T>`
  - prompt, system prompt, timeout, MCP use, output mode, parse function
- `EnrichmentTask<TInput, TOutput>`
  - a typed task with:
    - `deterministic(input)`
    - `buildRequest(input)`
- `EnrichmentResult<T>`
  - wraps the final result and records whether it came from fallback or LLM

## Recommended Next Implementation Step

When we come back to session summaries, the right refactor order is:

1. Wrap the current deterministic summary builder as an `EnrichmentTask`
2. Wrap Claude CLI as an `InferenceRunner`
3. Add a second `InferenceRunner` for Codex CLI
4. Add a small orchestrator that:
   - checks runner availability
   - tries the preferred runner
   - validates/parses output
   - falls back deterministically on any failure
5. Store runner/model/source metadata with the resulting enrichment

## What Not To Do

- Do not wire feature logic directly to a specific CLI binary
- Do not let freeform model text become a first-class fact
- Do not make LLM availability a correctness requirement
- Do not hide whether a result was deterministic or inferred

## How This Relates To Session Summaries And Code Provenance V1

For the local-only workstream/code-provenance slice, LLM inference should be
strictly optional and limited to presentation-grade enrichments:

- workstream title refinement
- workstream summary text
- "why/how" explanation text for `why_code`

The underlying projections should still be fully usable without any LLM:

- `session_summaries`
- `intent_session_summaries`
- `code_provenance`

That keeps the system useful when no headless agent is installed and preserves a
clean path toward future multi-agent and multi-machine features.
