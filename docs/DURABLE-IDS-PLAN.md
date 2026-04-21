# Durable IDs and Provenance Foundation Plan

## Goal

Stabilize scanner-derived evidence identity before expanding Panopticon's
facts/provenance model.

This work is about making ingestion and sync idempotent across reparse and
rescan. It is not the broader semantic identity project for repositories,
files, symbols, decisions, or future wiki artifacts.

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

## Phase 2A: Evidence Ref Normalization

### Objective

Once scanner-owned evidence rows are stable, normalize provenance references
across all raw evidence families and remove dependence on local row IDs or
opaque ad hoc keys in the claim layer.

### Deliverables

1. Typed evidence references for:
   - hook event
   - otel log
   - otel metric
   - otel span
   - message
   - tool call
   - scanner turn
   - scanner event
   - git commit
   - git hunk
   - file snapshot
2. Replace freeform/local-id evidence keys in claims with typed references.
3. Adopt a canonical locator strategy for append-only evidence that still uses
   stored random `sync_id` values today:
   - `hook_events`
   - `otel_logs`
   - `otel_metrics`
   - keep `otel_spans` aligned with their existing `(trace_id, span_id)` key
   - explicitly decide whether any of those families need deterministic ingest
     identity beyond typed refs in a follow-up slice
4. Update claim integrity/provenance resolution to target typed evidence refs
   instead of string-parsing local identifiers.

### Why Hooks/OTel Land Here

- They did not need to block Phase 1 because the urgent correctness problem was
  scanner reparse/rescan duplication.
- They should not wait until later semantic work, because claims already cite
  hook/message/tool evidence and need a stable, typed reference substrate
  before we broaden provenance further.
- `hook_events` are highest priority in this phase because they already back
  active claim generation directly.

See [EVIDENCE-REFS-PHASE2A.md](./EVIDENCE-REFS-PHASE2A.md) for the concrete
typed-ref shape, migration sketch, and the hook/OTel identity recommendation.

## Phase 2B: Repo/File Normalization

### Objective

Once evidence references are structured, add the first semantic subjects that
already have strong evidence support.

### Deliverables

1. First-class subject kinds for:
   - `repository`
   - `file`
2. Stable identity rules for repository and file subjects.
3. Initial git-derived provenance/facts for repo/file subjects.

### Tracked Follow-Up

- Revisit the `messages` ordinal fallback for rows without source UUIDs.
  Phase 1 accepts `session_id + ordinal` as the durable key input, but a future
  parser that re-numbers legacy UUID-less streams would change those message
  identities after reparse. Evaluate a stronger fallback before later
  provenance layers depend on those rows as stable evidence.

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

## Immediate Next Steps

1. Land and monitor Phase 1 scanner-owned durable IDs.
2. Define the typed evidence-ref shape for:
   - hook events
   - otel logs / metrics / spans
   - scanner rows
   - messages / tool calls
3. Decide the durable/transport identity strategy for `hook_events`,
   `otel_logs`, and `otel_metrics`.
4. Update claim evidence storage and integrity resolution to use typed refs.
5. Start `repository` / `file` normalization only after the evidence-ref layer
   is in place.
