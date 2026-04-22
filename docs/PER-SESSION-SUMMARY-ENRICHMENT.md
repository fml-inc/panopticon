# Per-Session Summary Enrichment

This document captures the intended next step for session summaries:

- stay per-session for now
- move richer summary text into the projection layer
- avoid capricious LLM regeneration during rebuilds

It builds on the existing gated `session_summaries` projection surface and the
inference rules in
[docs/INFERENCE-INTERFACES.md](/Users/gus/workspace/panopticon/docs/INFERENCE-INTERFACES.md).

## Goal

Replace the weak legacy `sessions.summary` field with a richer per-session
summary that lives in the projection/read-model layer and is suitable for:

- AI retrieval
- session list display
- later reuse by workstream-level views

The summary should be:

- derived from stable local session data
- optionally enriched by LLMs
- cheap to preserve across deterministic rebuilds
- regenerated only when the underlying summary-relevant inputs change
  materially

## Scope

This proposal is intentionally limited to:

- one summary document per session
- no cross-session workstream grouping yet
- no requirement that LLM generation happen during projection rebuild

Workstreams can layer on top later. For now, session summaries remain the only
summary unit.

## Current State

Today the gated projection layer provides:

- `session_summaries`
- `intent_session_summaries`
- `code_provenance`

The projector lives in
[src/session_summaries/project.ts](/Users/gus/workspace/panopticon/src/session_summaries/project.ts)
and is invoked from
[src/intent/project.ts](/Users/gus/workspace/panopticon/src/intent/project.ts).

The main user-visible integrations are:

- explicit projection queries in
  [src/session_summaries/query.ts](/Users/gus/workspace/panopticon/src/session_summaries/query.ts)
- `listSessions()` replacing weak summary text with projection-derived text in
  [src/db/query.ts](/Users/gus/workspace/panopticon/src/db/query.ts)

## Key Constraint

The current projection rebuild is destructive.

When a session or full rebuild runs, the projector deletes and recreates rows in
`session_summaries`, `intent_session_summaries`, and `code_provenance`:

- [src/session_summaries/project.ts](/Users/gus/workspace/panopticon/src/session_summaries/project.ts:58)

That is acceptable for cheap deterministic projections. It is the wrong shape
for expensive LLM enrichment:

- every rebuild would risk losing cached summary text
- every rebuild would risk regenerating summaries unnecessarily
- `session_summary_id` values can churn, which makes enrichment keyed by row id
  brittle

This means the first LLM-backed summary design should not assume that
`session_summaries` rows are stable enough to hold expensive enrichment
directly.

## Design Rules

### 1. Deterministic projection and LLM enrichment are separate phases

`rebuildSessionSummaryProjections()` should remain deterministic and cheap.

It should:

- rebuild the structured projection
- compute summary-relevant hashes
- mark enrichment rows dirty when needed

It should not:

- shell out to Claude or Codex
- block projection rebuild on LLM availability
- destroy valid cached summary text without a material reason

### 2. The cache key must be stable across destructive rebuilds

Use `session_summary_key` as the stable identifier, not `session_summary_id`.

The key already exists today:

- `ss:local:${session_id}`

This survives destructive rebuilds even when row ids change.

### 3. Regeneration requires material change, not any change

Not every projection rebuild should trigger a new summary.

Examples of changes that should *not* invalidate an expensive summary:

- row id churn
- changes to `verified_at_ms`
- confidence tweaks in `code_provenance`
- line-binding improvements with no change to the session's user-visible story
- equivalent ordering changes

### 4. A deterministic fallback must always exist

If no enriched summary exists, callers should still be able to render a useful
per-session summary from structured projection fields.

## Recommended Storage Shape

For v1, use a separate enrichment table keyed by `session_summary_key`.

This is preferable to adding expensive-summary columns directly to
`session_summaries` because the current projector still deletes and recreates
that base table.

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS session_summary_enrichments (
  session_summary_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  summary_text TEXT,
  summary_search_text TEXT,
  summary_source TEXT NOT NULL DEFAULT 'deterministic',
  summary_runner TEXT,
  summary_model TEXT,
  summary_version INTEGER NOT NULL DEFAULT 1,
  summary_generated_at_ms INTEGER,
  projection_hash TEXT,
  summary_input_hash TEXT,
  dirty INTEGER NOT NULL DEFAULT 1,
  dirty_reason_json TEXT,
  last_material_change_at_ms INTEGER,
  last_attempted_at_ms INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_summary_enrichments_dirty
  ON session_summary_enrichments(dirty, last_material_change_at_ms);
CREATE INDEX IF NOT EXISTS idx_session_summary_enrichments_session
  ON session_summary_enrichments(session_id);
```

Field meaning:

- `summary_text`
  - optional richer text for UI or user-facing surfaces
- `summary_search_text`
  - compact fielded text optimized for AI retrieval
- `summary_source`
  - `deterministic` or `llm`
- `summary_runner`, `summary_model`
  - provenance for accepted LLM output
- `summary_version`
  - bump when prompt/parser/schema logic changes and old summaries should be
    invalidated
- `projection_hash`
  - hash of the broader deterministic projection envelope
- `summary_input_hash`
  - hash of only the fields that should drive summary regeneration
- `dirty`
  - whether an enrichment worker should reconsider this row
- `dirty_reason_json`
  - explicit explanation for why the row became dirty

## Why A Separate Table Is The Right First Step

This design has three advantages:

1. It survives destructive projection rebuilds because the key is stable.
2. It lets the current projector keep deleting and recreating
   `session_summaries` rows while enrichment remains cached.
3. It can be folded back into `session_summaries` later if the projector is
   rewritten to preserve rows by upsert.

## Two Hashes, Not One

Use two hashes:

### `projection_hash`

Hash all deterministic projection fields that describe the session summary row.

Example inputs:

- `title`
- `status`
- `repository`
- `cwd`
- `branch`
- `first_intent_ts_ms`
- `last_intent_ts_ms`
- `intent_count`
- `edit_count`
- `landed_edit_count`
- `open_edit_count`
- top file list

Purpose:

- detect whether the broader projection changed
- support debugging and cache introspection

### `summary_input_hash`

Hash only the summary-relevant fields that should trigger a new summary.

Example inputs:

- `title`
- `status`
- `repository`
- `branch`
- ordered intent prompt texts
- ordered touched file list with edit counts
- landed/open counts
- small, stable verification facts

Purpose:

- drive LLM summary invalidation conservatively

This is the important one for spend control.

## Material Change Policy

Do not regenerate the summary when `projection_hash` changes but
`summary_input_hash` stays the same.

Mark the row dirty only when one of these is true:

- no summary exists yet
- `summary_version` changed
- `summary_input_hash` changed
- `status` changed
- `title` changed
- repository or branch changed
- a new intent was added
- top touched files changed
- landed/open edit counts changed materially
- the session moved from active to reconciled

Do not mark dirty for:

- row id churn
- provenance-only confidence changes
- timestamp-only noise
- line/span rebinding with the same underlying edit set

## Suggested `dirty_reason_json`

Store explicit reasons so behavior is inspectable and testable.

Example:

```json
{
  "reasons": ["status_changed", "new_intent", "top_files_changed"],
  "previous_summary_input_hash": "abc",
  "next_summary_input_hash": "def"
}
```

## Deterministic Summary Document

Even before LLM enrichment, build a deterministic summary document for every
session. This should be good enough to use when:

- the row is still dirty
- no LLM is installed
- an LLM call failed

This deterministic document should feed:

- `summary_text` fallback
- `summary_search_text` fallback

### `summary_search_text` shape

Optimize it for AI retrieval, not prose beauty.

Example:

```text
Outcome: fixed 3 bugs in rlm package.
Files: rlm/adapters/codex.sh; rlm/rlm; rlm/rlm_query.
Entities: codex exec; model_instructions_file; RLM_CHILD_ADAPTER; Claude.
Verification: npm install -g; interactive Codex root with Claude children.
Followup: none.
```

This is better than a pure paragraph for retrieval because it is:

- short
- fielded
- entity-heavy
- stable across reruns

## Enrichment Worker Lifecycle

Add a separate summary-enrichment worker or idle-cycle pass.

Its job is:

1. select `session_summary_enrichments` rows where `dirty = 1`
2. build the prompt from deterministic projection data
3. attempt LLM enrichment
4. on success:
   - write `summary_text`
   - write `summary_search_text`
   - write provenance fields
   - set `dirty = 0`
   - clear failure state
5. on failure:
   - keep deterministic fallback available
   - increment `failure_count`
   - store `last_error`
   - optionally leave `dirty = 1` for retry, or back off after N failures

This worker should be best-effort. It should never be required for correctness.

## How The Projector Should Interact With Enrichment

When `rebuildSessionSummaryProjections()` runs:

1. rebuild deterministic projection tables as it does today
2. compute `projection_hash` and `summary_input_hash` per session summary key
3. upsert into `session_summary_enrichments`
4. set `dirty = 1` only if the material-change policy says so
5. preserve existing summary text if the row is not materially dirty

This keeps rebuilds cheap while still making summary freshness explicit.

## Read-Path Changes

Once the enrichment table exists, reads should prefer it.

### `listSessions()`

Instead of formatting only:

- title
- status
- counts
- top files

join the enrichment row by `session_summary_key` and prefer:

- `summary_text` if present
- deterministic formatted fallback otherwise

Relevant code:

- [src/db/query.ts](/Users/gus/workspace/panopticon/src/db/query.ts)

### `session_summaries` and `session_summary_detail`

Extend the returned payload with:

- `summary_text`
- `summary_search_text`
- `summary_source`
- `summary_runner`
- `summary_model`
- `summary_generated_at_ms`
- `dirty`

Relevant code:

- [src/session_summaries/query.ts](/Users/gus/workspace/panopticon/src/session_summaries/query.ts)

## Search Changes

Do not keep relying on `sessions.summary LIKE`.

Instead:

- query the enrichment table's `summary_search_text`
- preferably through a dedicated FTS table in a follow-up step

The old `sessions.summary` field should remain a compatibility fallback only
during migration.

## Migration Order

### 1. Add the enrichment table

No behavior change yet.

### 2. Compute and persist hashes during projection rebuild

Still no LLM generation yet.

### 3. Add deterministic `summary_text` and `summary_search_text`

This gives an immediate upgrade without LLM spend.

### 4. Add the background enrichment worker

Only for rows marked dirty.

### 5. Update reads to prefer enrichment

- `listSessions()`
- `session_summaries`
- `session_summary_detail`

### 6. Move search to the new summary corpus

At that point, `sessions.summary` can become legacy-only.

## Non-goals

- multi-session workstream summaries
- making projection rebuild depend on LLM availability
- rebuilding expensive summaries on every projector run
- using raw freeform LLM text as the only summary representation

## Recommendation

For the per-session phase, the right design is:

- deterministic `session_summaries` remains the structural projection
- expensive summary text lives in a separate stable-key enrichment table
- projection rebuild computes hashes and dirtiness, but does not call the LLM
- a separate worker enriches only materially changed rows

That gives us a richer session-summary corpus without paying repeatedly for
capricious rebuilds.
