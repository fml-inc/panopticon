# Phase 2A: Evidence Ref Normalization

## Goal

Make claim evidence machine-readable and stable for the evidence families that
current claim producers actually use, without coupling provenance to local
SQLite row IDs.

Phase 1 solved the urgent scanner-owned durability problem. On `main`, the
active Phase 2A scope is the core cutover for:

- `message`
- `tool_call`
- `hook_event`
- `file_snapshot`

That work comes before broader `repository` / `file` semantic subjects because
the claim layer already depends on evidence references today.

Other families remain reserved extension points, not required Phase 2
completion work:

- `scanner_turn`
- `scanner_event`
- `otel_log`
- `otel_metric`
- `otel_span`
- `git_commit`
- `git_hunk`

## Decision

1. Introduce typed `evidence_ref` objects before adding more semantic subjects.
2. Land the core cutover first for the evidence families current claim writers
   actually emit.
3. Keep additional `scanner_*` / `otel_*` refs as optional extensions until a
   concrete provenance or query use case appears.
4. Treat `git_*` refs as reserved kinds only until a raw git ingest model
   exists.

In practice, that means:

- `messages` and `tool_calls` use their Phase 1 deterministic `sync_id`.
- `hook_events` use their existing stored `sync_id` as the canonical locator.
- `file_snapshot` uses file path plus content hash.
- `scanner_*`, `otel_*`, and `git_*` keep reserved typed-ref shapes for future
  use without forcing more schema churn now.

The immediate problem is reference structure, not append-only transport-key
generation.

## Why Typed Refs First

Current claim evidence is stringly-typed:

- `message:<session_id>:<ordinal>`
- `tool:<tool_use_id>`
- `tool_local:<session_id>:<ordinal>:<tool_call_index>`
- `hook:<id>`
- `fs_snapshot:<path>:<content_hash>`

That was fine to bootstrap intent claims, but it creates three problems:

1. local IDs leak into provenance
2. integrity resolution has to string-parse ad hoc formats
3. adding new evidence families scales poorly

Typed refs solve those without forcing every raw family to redesign its ingest
identity in the same phase.

## Proposed Shape

Use a canonical evidence-ref record plus a family-specific locator payload.

### TypeScript model

```ts
type EvidenceRefKind =
  | "message"
  | "tool_call"
  | "scanner_turn"
  | "scanner_event"
  | "hook_event"
  | "otel_log"
  | "otel_metric"
  | "otel_span"
  | "git_commit"
  | "git_hunk"
  | "file_snapshot";

interface EvidenceRefInput {
  kind: EvidenceRefKind;
  refKey: string;
  sessionId?: string | null;
  syncId?: string | null;
  repository?: string | null;
  filePath?: string | null;
  filePaths?: string[] | null;
  traceId?: string | null;
  spanId?: string | null;
  locator: Record<string, unknown>;
}
```

### Storage model

Add a first-class `evidence_refs` table and make `claim_evidence` point to it.

```sql
CREATE TABLE evidence_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  session_id TEXT,
  sync_id TEXT,
  repository TEXT,
  file_path TEXT,
  trace_id TEXT,
  span_id TEXT,
  locator_json TEXT NOT NULL
);

CREATE TABLE evidence_ref_paths (
  evidence_ref_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  UNIQUE(evidence_ref_id, file_path)
);

CREATE TABLE claim_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL,
  evidence_ref_id INTEGER NOT NULL,
  detail JSON,
  role TEXT NOT NULL DEFAULT 'supporting'
);
```

Notes:

- `ref_key` is the canonical identity of the evidence reference.
- `locator_json` stores family-specific fields without forcing every field into
  fixed columns immediately.
- denormalized columns like `session_id`, `sync_id`, `trace_id`, `span_id`,
  `repository`, and `file_path` are intended to make lookups and filtering
  cheap. For current claim producers, populate them eagerly at claim-write
  time wherever the raw evidence already makes them unambiguous; future
  families can still use targeted backfills if a writer cannot supply them
  up front.
- `evidence_ref_paths` holds the normalized path set for refs that touch one
  or more files. Keep `evidence_refs.file_path` as the singleton fast path and
  use the join table when a ref touches multiple paths.
- local row IDs are intentionally not part of canonical identity.

## Canonical Ref Keys

Each family has a canonical ref-key encoding.

The first four families below plus `file_snapshot` are the active shapes on
`main`. The remaining rows are reserved extension shapes so future expansion
does not require another schema redesign.

| Kind | Canonical ref key | Initial locator source |
| --- | --- | --- |
| `message` | `msg:<sync_id>` | `messages.sync_id` |
| `tool_call` | `tc:<sync_id>` | `tool_calls.sync_id` |
| `scanner_turn` | `scan_turn:<sync_id>` | `scanner_turns.sync_id` |
| `scanner_event` | `scan_event:<sync_id>` | `scanner_events.sync_id` |
| `hook_event` | `hook_event:<sync_id>` | `hook_events.sync_id` |
| `otel_log` | `otel_log:<sync_id>` | `otel_logs.sync_id` |
| `otel_metric` | `otel_metric:<sync_id>` | `otel_metrics.sync_id` |
| `otel_span` | `otel_span:<trace_id>:<span_id>` | `otel_spans.(trace_id, span_id)` |
| `git_commit` | `git_commit:<repository>:<commit_sha>` | git ingest |
| `git_hunk` | `git_hunk:<repository>:<commit_sha>:<path>:<hunk_hash>` | git ingest |
| `file_snapshot` | `file_snapshot:<path>:<content_hash>` | disk/git snapshotting |

Example locators:

```json
{ "kind": "message", "refKey": "msg:abcd...", "sessionId": "sess-1", "syncId": "abcd...", "locator": { "ordinal": 7, "uuid": "msg-uuid" } }
{ "kind": "hook_event", "refKey": "hook_event:ef01...", "sessionId": "sess-1", "syncId": "ef01...", "locator": { "eventType": "PostToolUse", "timestampMs": 1710000 } }
{ "kind": "otel_span", "refKey": "otel_span:trace:span", "sessionId": "sess-1", "locator": { "traceId": "trace", "spanId": "span" } }
```

## Current State On Main

`main` has the Phase 2A core cutover needed by current claim producers.

Implemented here:

- `claim_evidence` now stores `evidence_ref_id` only.
- migrations treat claims/projection state as disposable derived data and force
  atomic reparse from raw scanner files plus preserved `hook_events` / `otel_*`
  rows.
- derived-state freshness now uses `data_versions(component, version, updated_at_ms)`
  instead of `PRAGMA user_version`, which allows startup to distinguish raw
  scanner reparses from claims-only rebuilds.
- active claim producers now emit typed refs for:
  - `message`
  - `tool_call`
  - `hook_event`
  - `file_snapshot`
- `ensureEvidenceRef()` upserts by canonical `ref_key` and stores normalized
  multi-file path sets in `evidence_ref_paths`
- runtime integrity checks resolve evidence by loading the ref row and
  dispatching on `evidence_refs.kind`
- active edit views expose structured typed payload-evidence refs instead of
  preserving hook-event row-id helpers
- landed-status reconciliation decodes tool/hook payloads from those typed
  refs directly
- `claims.asserter_version` and `claim_rebuild_runs.asserter_version` are now
  integer component versions sourced from the central version registry.

Not part of the active Phase 2 backlog:

- no current claim producer emits `scanner_turn`, `scanner_event`, `otel_*`,
  `git_commit`, or `git_hunk` refs
- `scanner_*` and `otel_*` raw tables exist, but current claim/provenance
  paths do not need those refs today
- `git_commit` and `git_hunk` are reserved kinds only; no raw git ingest
  tables exist today
- compatibility helpers still parse legacy/local-id and canonical string keys
  in `src/claims/evidence-refs.ts`, but current claim writers do not emit those
  legacy keys anymore
- denormalized `repository` / `file_path` fields are only populated for the
  evidence families that already emit typed refs today

## Future Extension Notes

### `hook_events`

This cutover is already landed on `main`.

Claims no longer depend on `hook:<local id>` style references; active writers
emit typed hook refs keyed by the stored `sync_id`.

### `scanner_turn` / `scanner_event`

These raw tables have durable identities and generic resolver support, but they
are not currently useful enough in claim provenance to justify active Phase 2
work.

If a later query or provenance feature needs direct citation of scanner turns
or events, the reserved ref shapes can be activated without another schema
change.

### `otel_log` / `otel_metric` / `otel_span`

These raw tables also exist and the generic resolver can already target them by
`sync_id` or `trace_id + span_id`.

They are not part of active Phase 2 work because the current claim/provenance
layer does not need them, and the product value looks low relative to the repo
/ file follow-on work.

If that changes later, the existing recommendation still stands:

- use stored `sync_id` for `otel_log` and `otel_metric`
- use `trace_id + span_id` for `otel_span`
- do not make deterministic ingest identity a prerequisite unless replay or
  re-import becomes first-class

### `git_commit` / `git_hunk`

These kinds are reserved shapes only.

There are no raw git ingest tables behind them today, so they should not be
tracked as remaining Phase 2 work. A real rollout would start with a separate
git ingest/provenance design, then attach typed refs to that model.

## Migration Approach

1. Add `evidence_refs`.
2. Rebuild `claim_evidence` to the ref-only schema without copying legacy rows.
3. Treat `claims`, `claim_evidence`, `active_claims`, `intent_*`,
   `session_summaries`, and `code_provenance` as disposable derived state for
   this cutover.
4. Mark the relevant `data_versions` components stale so startup runs the
   required rebuild:
   - rescan session files into a fresh DB
   - copy raw `hook_events` / `otel_*` rows forward
   - derive claims, intent projection, and evidence refs fresh from raw data
   - populated DBs that predate `data_versions` are treated as stale and
     rebuilt on first startup with the new code
5. Update claim writers to create/read `evidence_refs`.
6. Start moving integrity checks and provenance resolvers to `evidence_refs`.
   On `main`, integrity checks, active edit views, and landed-status payload
   decoding already use the `kind + locator` pattern; the remaining follow-up
   is repo/file/query work built on top of that foundation.

## Target Resolver Model

`resolveEvidenceRef(ref)` should dispatch by `kind`, not by parsing arbitrary
strings.

This is now the runtime pattern for evidence integrity and landed-status payload
decoding. Canonical prefix parsing still exists in compatibility helpers, but
the current read-path pattern is:

1. load the `evidence_refs` row
2. dispatch by `kind`
3. resolve the raw row using the locator fields already materialized on the ref

Examples:

- `message` -> lookup by `sync_id`
- `tool_call` -> lookup by `sync_id`
- `hook_event` -> lookup by `sync_id`
- `otel_log` -> lookup by `sync_id`
- `otel_metric` -> lookup by `sync_id`
- `otel_span` -> lookup by `trace_id + span_id`
- `git_commit` / `git_hunk` / `file_snapshot` -> validate against their stored
  materialization or return a structured opaque reference when raw material is
  external

## Acceptance Criteria

1. No claim evidence depends on local row IDs as canonical identity.
2. New writes for active claim producers no longer emit legacy freeform/local-id
   evidence strings.
3. Typed refs for `message`, `tool_call`, `hook_event`, and `file_snapshot`
   survive local reparse and normal sync flows.
4. Optional future families (`scanner_*`, `otel_*`, `git_*`) can still be
   added later without a second schema migration.
5. `repository` / `file` normalization is already building on the evidence-ref
   layer; remaining follow-up is current repo/file/query work on top of the
   already-landed typed-evidence consumer cleanup.

## Open Questions

1. Do we want `claims.sync_id` to remain random, or should claims eventually
   get a deterministic observation-level transport identity too?
2. Should `evidence_refs` dedupe purely by `ref_key`, or also enforce kind
   consistency in the schema/index layer?
3. For future evidence families that cannot populate denormalized columns
   unambiguously at write time, do we prefer a targeted backfill / repair pass
   or leaving those fields sparse until a consumer needs them?
4. If raw replay for append-only evidence becomes first-class later, do any
   `otel_*` families need deterministic ingest identity beyond their current
   locator scheme?
