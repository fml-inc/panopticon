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
- `scanner_events`: stable event key from `source + session_id + event shape`

### Acceptance Criteria

- Reparse of unchanged scanner input does not create duplicate remote rows.
- Full filesystem rescan does not create duplicate remote rows.
- `messages` no longer rely on local numeric row IDs for remote idempotency.
- `restoreSyncIds` is no longer needed for scanner-owned rows.

## Phase 2: Typed Evidence Refs and Repo/File Normalization

### Objective

Once evidence rows are stable, make provenance references structured and add
the first semantic subjects that already have strong evidence support.

### Deliverables

1. Typed evidence references for:
   - message
   - tool call
   - scanner turn
   - scanner event
   - git commit
   - git hunk
   - file snapshot
2. First-class subject kinds for:
   - `repository`
   - `file`
3. Stable identity rules for repository and file subjects.
4. Initial git-derived provenance/facts for repo/file subjects.

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

1. Write the Phase 1 identity matrix against current tables and sync paths.
2. Fix `messages` first, since they are currently the least reparse-safe.
3. Make `tool_calls` deterministic off durable message identity.
4. Make `scanner_turns` and `scanner_events` deterministic.
5. Update sync tests to prove reparse/rescan idempotency.
6. Rebase higher-level provenance work on top of the durable-ID branch once
   Phase 1 lands.
