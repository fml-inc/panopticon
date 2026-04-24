# Durable IDs and Provenance Foundation Plan

## Goal

Stabilize scanner-derived evidence identity before expanding Panopticon's
facts/provenance model.

This work is about making ingestion and sync idempotent across reparse and
rescan. It is not the broader semantic identity project for repositories,
files, symbols, decisions, or future wiki artifacts.

## Status On Main

As of `main` on April 22, 2026, the implementation is ahead of the original
Phase 2 wording in a few places:

- Phase 1 durable IDs are landed for `messages`, `tool_calls`,
  `scanner_turns`, and `scanner_events`.
- Phase 2A core evidence-ref cutover is landed:
  - `claim_evidence` stores `evidence_ref_id`
  - `evidence_refs` and `evidence_ref_paths` are in the schema
  - active claim writers emit typed refs for `message`, `tool_call`,
    `hook_event`, and `file_snapshot`
- The first Phase 2B repo/file normalization slice is also landed:
  - `repository` / `file` subject kinds exist
  - scanner and hook asserters emit `repository/name`, `file/path`,
    `file/in-repository`, `intent/in-repository`, and `edit/touches-file`
  - `intent_for_code` prefers normalized file-subject relations and falls back
    to the legacy `intent_edits.file_path` path
- The local `session_summaries` / `code_provenance` projection exists and is
  enabled by default. It can be disabled with
  `PANOPTICON_ENABLE_SESSION_SUMMARY_PROJECTIONS=0` and is currently tracked
  under its own `session_summaries.projection` data-version component.

## Why This Comes First

Today, some scanner-owned rows depend on local row IDs or random `sync_id`
values that are only preserved by reparse-specific repair logic. That means
higher-level provenance can end up pointing at unstable evidence.

We should fix the evidence layer before building more on top of it.

## Phase 1: Durable Evidence IDs

### Objective

Give scanner-derived rows deterministic durable identities so the same logical
evidence does not duplicate on the server after a reparse or full filesystem
rescan.

### In Scope

- `messages`
- `tool_calls`
- `scanner_turns`
- `scanner_events`

### Out of Scope

- `hook_events`
- `otel_*`
- claims/schema expansion beyond what is required for durable evidence IDs
- human-readable/wiki artifacts

These are out of scope for Phase 1 only. They move into the immediately
following evidence-normalization phase; they are not indefinite backlog.

### Deliverables

1. Identity matrix for scanner-owned tables:
   - local surrogate key
   - durable identity
   - transport/idempotency key
2. Deterministic durable ID formulas for scanner-owned tables.
3. Add durable sync identity to `messages`.
4. Replace random scanner `sync_id` generation where natural keys are strong.
5. Update sync readers/writers to use durable identities for idempotency.
6. Remove reparse-time `sync_id` preservation hacks where they become obsolete.
7. Add regression tests for reparse/rescan idempotency.

### Likely Identity Basis

- `messages`: `session_id + (uuid || ordinal)`
- `tool_calls`: durable message identity + `tool_use_id` or call ordinal/index
- `scanner_turns`: `source + session_id + turn_index`
- `scanner_events`: stable per-stream event ordinal from
  `source + session_id + event_index`

### Acceptance Criteria

- Reparse of unchanged scanner input does not create duplicate remote rows.
- Full filesystem rescan does not create duplicate remote rows.
- `messages` no longer rely on local numeric row IDs for remote idempotency.
- `restoreSyncIds` is no longer needed for scanner-owned rows.

## Phase 2: Remaining Foundation Work

### Objective

Finish the still-open evidence and repo/file provenance work on top of the
already-landed Phase 1 durable IDs, Phase 2A core evidence-ref cutover, and
the first Phase 2B repo/file normalization slice.

The old 2A/2B split is no longer the best way to track active work: `main`
already contains part of each. The remaining Phase 2 items are grouped here as
one contiguous tranche.

### Completed On Main

These items are no longer part of the active Phase 2 backlog:

- typed evidence refs are in the schema and active claim writers emit them for
  `message`, `tool_call`, `hook_event`, and `file_snapshot`
- claim integrity and landed-status read paths already resolve evidence by
  `kind` plus locator data instead of depending on local numeric row IDs
- active edit views and landed-status reconciliation now consume typed
  payload-evidence refs directly instead of preserving hook-event row-id
  fallbacks
- `repository` / `file` subject kinds and the initial repo/file relations are
  emitted by scanner-backed and hook-backed asserters
- `intent_for_code` already uses the normalized file-subject path with legacy
  fallback

See [EVIDENCE-REFS-PHASE2A.md](./EVIDENCE-REFS-PHASE2A.md) for the concrete
typed-ref shape, landed core cutover, and optional extension notes.

### Remaining Work

1. Add the next repo/file provenance slice:
   - git-derived repo facts
   - git-derived file facts and provenance
2. Continue adding richer file-centric query paths on top of the normalized
   repo/file relations. `file_overview` is now landed as the first aggregate
   file-centric query in this slice.
3. Decide whether local projection tables should remain grouped under
   `session_summaries.projection` or split further:
   - code provenance
   - any future materialized repo/file views
4. Revisit the `messages` ordinal fallback for UUID-less rows before later
   provenance layers depend on those message identities as stable evidence.

### Future Consideration

These items are no longer part of the active Phase 2 backlog:

- `scanner_turn` / `scanner_event` typed refs:
  raw tables exist, but current claim/provenance paths do not need them
- `otel_log` / `otel_metric` / `otel_span` typed refs:
  raw tables exist, but the provenance value is currently unclear outside
  sync, diagnostics, and operational queries
- `git_commit` / `git_hunk` typed refs:
  reserved evidence kinds only for now; a real rollout would require a future
  raw git ingest model rather than just more claim writers

## Phase 3: Claims and Provenance Expansion

### Objective

Build broader machine-readable facts and provenance on top of stable evidence
and typed references.

### Deliverables

1. Expand `subject_kind` beyond `intent` and `edit`.
2. Add more explicit relations/predicates between entities.
3. Track fact lifecycle and supersession more explicitly.
4. Add provenance queries that rely on stable evidence refs.

## Deferred

- `symbol` and `decision` entities
- human-readable artifact/wiki generation
- presentation-layer summaries/pages

## Data Version Management

Derived-state freshness is now tracked in
`data_versions(component, version, updated_at_ms)` rather than a single global
SQLite header integer.

Current components:

- `scanner.raw`
- `intent.from_scanner`
- `intent.from_hooks`
- `intent.landed_from_disk`
- `claims.active`
- `claims.projection`
- `session_summaries.projection`

`claims.projection` currently covers:

- `intent_units`
- `intent_edits`

`session_summaries.projection` currently covers:

- `session_summaries`
- `session_summary_search_index`
- `intent_session_summaries`
- `code_provenance`

That enables startup to distinguish:

- stale raw scanner data -> atomic reparse
- stale claims/provenance state -> claims-only rebuild from existing local raw
  tables

Full manual rebuild execs should participate in the same component-version
model; session-scoped rebuild helpers remain partial utilities and should not
clear global stale-state flags.

`claims.asserter_version` is now the integer component version that emitted the
row, not an independently managed string constant.
