# Phase 2A: Evidence Ref Normalization

## Goal

Make claim evidence machine-readable and stable across raw evidence families
without coupling provenance to local SQLite row IDs.

Phase 1 solved the urgent scanner-owned durability problem. Phase 2A should
normalize how claims point at evidence:

- `message`
- `tool_call`
- `scanner_turn`
- `scanner_event`
- `hook_event`
- `otel_log`
- `otel_metric`
- `otel_span`
- `git_commit`
- `git_hunk`
- `file_snapshot`

This phase comes before `repository` / `file` semantic subjects because the
claim layer already depends on evidence references today.

## Decision

1. Introduce typed `evidence_ref` objects before adding more semantic subjects.
2. Use the strongest existing stable locator for each evidence family now.
3. Do not block this phase on deterministic `hook_events` / `otel_logs` /
   `otel_metrics` generation.
4. Keep `otel_spans` on their existing natural key: `(trace_id, span_id)`.

In practice, that means:

- `messages`, `tool_calls`, `scanner_turns`, `scanner_events` use their Phase 1
  deterministic `sync_id`.
- `hook_events`, `otel_logs`, and `otel_metrics` use their existing stored
  `sync_id` as the canonical locator for now.
- `otel_spans` use `trace_id + span_id`.

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

Each family should have one canonical ref-key encoding.

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

## Current Branch Scope

This branch lands the Phase 2A core cutover, not the full multi-family rollout.

Implemented here:

- `claim_evidence` now stores `evidence_ref_id` only.
- migrations treat claims/projection state as disposable derived data and force
  atomic reparse from raw scanner files plus preserved `hook_events` / `otel_*`
  rows.
- active claim producers now emit typed refs for:
  - `message`
  - `tool_call`
  - `hook_event`
  - `file_snapshot`

Not fully delivered yet:

- no current claim producer emits `scanner_turn`, `scanner_event`, `otel_*`,
  `git_commit`, or `git_hunk` refs yet
- some evidence consumers still branch on canonical ref-key prefixes instead of
  loading an `evidence_ref` and dispatching by `kind`
- denormalized `repository` / `file_path` fields are only populated for the
  evidence families that already emit typed refs today

## Recommendation for Hooks and OTel

### `hook_events`

Use typed refs immediately, keyed by the existing stored `sync_id`.

Do **not** make deterministic hook-event sync IDs a prerequisite for Phase 2A.

Why:

- `hook_events` are append-only
- atomic reparse copies them instead of regenerating them
- remote sync already treats `sync_id` as the transport key
- the immediate weakness is `hook:<local id>` in claims, not transport
  idempotency

If we later need raw hook replay/re-import from source logs to dedupe across new
DBs, then we can add deterministic hook-event key generation as a follow-up.

### `otel_logs`

Use typed refs immediately, keyed by existing `otel_logs.sync_id`.

Do not block on deterministic log IDs. Log identity is trickier because a good
natural key may need body + attrs + timestamps + session context, and we do not
need to solve that just to normalize provenance references.

### `otel_metrics`

Same call as `otel_logs`: typed refs first, current stored `sync_id` as
canonical locator for now.

### `otel_spans`

No extra durable-ID work is needed before typed refs. Spans already have a
strong natural key:

- `trace_id`
- `span_id`

Use that directly in the canonical `ref_key`.

## Why Not Deterministic Hook/Log/Metric IDs First

Because those are different problems:

- typed refs solve provenance structure
- deterministic raw IDs solve replay/re-import idempotency

Phase 1 needed both for scanner-owned tables because reparses actively
recreated those rows. Hooks and OTel do not currently have the same failure
mode.

So the recommended order is:

1. replace claim evidence strings with typed refs
2. switch hook/log/metric references from local row IDs to `sync_id`
3. only then decide whether deterministic generation is worth the migration
   cost for those append-only families

## Migration Approach

1. Add `evidence_refs`.
2. Rebuild `claim_evidence` to the ref-only schema without copying legacy rows.
3. Treat `claims`, `claim_evidence`, `active_claims`, `intent_*`,
   `session_summaries`, and `code_provenance` as disposable derived state for
   this cutover.
4. Bump the scanner data version so startup runs atomic reparse:
   - rescan session files into a fresh DB
   - copy raw `hook_events` / `otel_*` rows forward
   - derive claims, intent projection, and evidence refs fresh from raw data
   - reset `PRAGMA user_version` during migration so upgrade always triggers
     the reparse even on DBs already stamped by newer local builds
5. Update claim writers to create/read `evidence_refs`.
6. Start moving integrity checks and provenance resolvers to `evidence_refs`.
   Finishing the move from key-prefix dispatch to `kind + locator` is follow-up
   work after the core cutover.

## Target Resolver Model

`resolveEvidenceRef(ref)` should dispatch by `kind`, not by parsing arbitrary
strings.

The current branch stores `kind` and canonical `ref_key`, but some read paths
still branch on canonical prefixes like `tc:` and `hook_event:`. Follow-up
work should replace those callers with a single resolver that loads the ref row
and dispatches by `kind`.

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
4. Remaining families (`scanner_*`, `otel_*`, `git_*`) can be added without a
   second schema migration.
5. `repository` / `file` normalization can build on the evidence-ref layer once
   denormalized-column hydration and resolver follow-up are complete.

## Open Questions

1. Do we want `claims.sync_id` to remain random, or should claims eventually
   get a deterministic observation-level transport identity too?
2. Should `evidence_refs` dedupe purely by `ref_key`, or also enforce kind
   consistency in the schema/index layer?
3. For future evidence families that cannot populate denormalized columns
   unambiguously at write time, do we prefer a targeted backfill / repair pass
   or leaving those fields sparse until a consumer needs them?
4. If hook or OTel raw replay becomes first-class, which family should get
   deterministic ingest identity first: `hook_events` or `otel_logs`?
