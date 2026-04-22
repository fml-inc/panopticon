# Durable IDs Phase 1 Identity Matrix

## Scope

This document records the landed Phase 1 durable-ID model for the
scanner-owned tables.

Phase 1 is about durable evidence row identity only:

- `messages`
- `tool_calls`
- `scanner_turns`
- `scanner_events`

It does not define semantic entity IDs for repositories, files, symbols,
decisions, or claims. Those come later.

## Terms

- `local id`: integer surrogate key used for local joins and ordering.
- `natural key`: columns that already identify the logical row in source data.
- `durable key`: canonical row identity that should survive reparse/rescan.
- `transport key`: the idempotency key carried over sync. In Phase 1 this
  should be the durable key encoded into `sync_id`.

## Current State

### Summary

- `messages`, `tool_calls`, `scanner_turns`, and `scanner_events` all have
  deterministic `sync_id` values.
- `tool_calls` now store `call_index`, and sync payloads carry
  `messageSyncId`, `callIndex`, and deterministic `syncId`.
- Session-linked incremental sync still uses local row-id watermarks in
  `target_session_sync` as a local efficiency optimization.
- Atomic reparse rewinds scanner-owned `target_session_sync` rows so replay can
  happen safely against durable remote identities.
- `restoreSyncIds` is now a no-op for scanner-owned rows.

## Identity Matrix

| Table | Local id | Current natural key | Current durable / transport key | Remaining caveat |
| --- | --- | --- | --- | --- |
| `messages` | `messages.id` | `UNIQUE(session_id, ordinal)` plus optional `uuid` | deterministic `sync_id` from `msg|<session_id>|uuid|<uuid>` or `msg|<session_id>|ord|<ordinal>` | UUID-less rows still fall back to `session_id + ordinal` |
| `tool_calls` | `tool_calls.id` | parent `messageSyncId` plus `tool_use_id` when present, otherwise `call_index` | deterministic `sync_id` from `tc|<messageSyncId>|tuid|<tool_use_id>` or `tc|<messageSyncId>|idx|<call_index>` | local `message_id` remains only as a local FK |
| `scanner_turns` | `scanner_turns.id` | `UNIQUE(session_id, source, turn_index)` | deterministic `sync_id` from `turn|<session_id>|<source>|<turn_index>` | none beyond normal row-id watermark replay rules |
| `scanner_events` | `scanner_events.id` | `UNIQUE(session_id, source, event_index)` | deterministic `sync_id` from `evt|<session_id>|<source>|idx|<event_index>` | `event_index` must remain stable across reparses |

## Table-by-Table Notes

### Messages

Landed behavior:

- Local identity is `messages.id`.
- Dedup in storage uses `UNIQUE(session_id, ordinal)`.
- Parsed source UUIDs are stored in `uuid` / `parent_uuid`.
- `messages.sync_id` is populated deterministically on insert and backfilled for
  older DBs by migration 6.
- Sync readers emit `syncId`.
- `messages.id` remains only a local surrogate for joins and FTS.

Fallback caveat:

- `uuid` is the strongest source identity and should be preferred when present.
- The `ordinal` fallback is sufficient for unchanged rescans, but it is weaker
  if a parser version later re-numbers legacy message streams. That is
  acceptable for Phase 1, but should stay explicitly documented.

### Tool Calls

Landed behavior:

- Local identity is `tool_calls.id`.
- `call_index INTEGER NOT NULL` is stored on every row and backfilled for older
  DBs by migration 7.
- `tool_calls.sync_id` is deterministic from durable message identity plus
  either `tool_use_id` or `call_index`.
- Sync readers emit `messageSyncId`, `callIndex`, and deterministic `syncId`.
- `message_id` remains only as a local FK.

### Scanner Turns

Landed behavior:

- Storage already has a strong natural key:
  `UNIQUE(session_id, source, turn_index)`.
- `sync_id` is derived directly from that natural key.
- Older DBs are backfilled by migration 8.

### Scanner Events

Landed behavior:

- Storage now uses `UNIQUE(session_id, source, event_index)`.
- `sync_id` is derived from `session_id + source + event_index`.
- Older DBs are rebuilt/backfilled by migrations 8 and 9.

Why the event index exists:

- The original plan used `event_type + timestamp_ms + tool_name` as the durable
  key input, mirroring the pre-existing uniqueness assumption.
- That collapsed real scanner data: repeated same-timestamp metadata events such
  as file snapshots, attachments, and reasoning rows produced duplicate
  `sync_id` values and dropped rows remotely.
- `event_index` is the minimal durable discriminator that matches how scanner
  events actually behave in live transcripts.

## Canonical Encoding

Phase 1 should use a single canonical encoding rule for durable key inputs:

1. Build a namespaced string from stable fields.
2. Hash it using one stable algorithm.
3. Store the hash in `sync_id`.

Suggested format:

- input string examples:
  - `msg|sess_123|uuid|abc`
  - `tc|<message_sync_id>|idx|1`
  - `turn|sess_123|claude|42`
  - `evt|sess_123|claude|idx|7`
- stored `sync_id`:
  - hex-encoded SHA-256 of the canonical input string

Why hash:

- fixed-width IDs across tables
- avoids pathologically long composite keys in transport payloads
- keeps the canonical structured fields available for later typed evidence refs
  without forcing them into the sync key itself

## Sync Contract Changes

### Required payload changes

`MessageSyncRecord`

- add `syncId`

`ToolCallSyncRecord`

- keep `syncId`
- add `messageSyncId`
- keep `messageId` only if needed for backward compatibility during migration

`ScannerTurnRecord`

- keep `syncId`, but make it deterministic

`ScannerEventRecord`

- keep `syncId`, but make it deterministic

### Watermark model

Current state:

- Session-linked sync still reads rows by local `id > watermark`.
- That is acceptable as a local efficiency optimization only while local row IDs
  remain monotonic within the same DB.
- Atomic full reparse rewinds scanner-owned `target_session_sync` watermarks so
  rows replay.
- Remote idempotency relies on deterministic `sync_id` when replay happens.

Without this, a fresh DB rebuild can preserve old watermarks that point past the
new local row IDs.

## Supporting Scan-State Gap

`scanner_file_watermarks` is keyed only by `file_path` and byte offset.

That is not a row-identity problem, but it matters for Phase 1 because a future
replacement-detection improvement probably wants stronger file identity inputs
such as file hash, inode/device, or both. This can remain a supporting task and
does not need to block the row-level durable-ID work.

## What Shipped

1. Add `messages.sync_id`.
2. Add `tool_calls.call_index`.
3. Backfill deterministic `sync_id` values for scanner-owned tables.
4. Update scanner insert paths to compute deterministic keys on write.
5. Update sync payload types and readers.
6. Update reparse paths to stop restoring scanner-owned random `sync_id` values.
7. Reset or rewind scanner-owned sync watermarks during atomic full-reparse.

## Implementation Order That Landed

1. `messages`
   - add `sync_id`
   - update readers/types/payload
2. `tool_calls`
   - add `call_index`
   - derive `sync_id` from `messageSyncId`
   - add `messageSyncId` to sync payload
3. `scanner_turns`
   - deterministic `sync_id`
4. `scanner_events`
   - deterministic `sync_id`
5. reparse + watermark handling
   - stop preserving random scanner sync IDs
   - reset/rewind session sync watermarks when needed

## Validation Covered By Tests

1. Reparse unchanged scanner data in the same DB:
   - no duplicate remote logical rows
2. Atomic full-reparse into a fresh DB:
   - replay occurs
   - remote dedupe still holds
3. Tool calls without `tool_use_id`:
   - deterministic identity falls back to `call_index`
4. Message replay:
   - message sync payload includes deterministic `syncId`
5. Scanner turns/events replay:
   - `restoreSyncIds` no longer required for scanner-owned tables

## Open Questions

1. Is `session_id + ordinal` an acceptable fallback durable message identity for
   rows without `uuid`, or do we want a content-based fallback before later
   provenance layers rely on those IDs as permanent evidence?
2. Do any scanner sources require a stronger event discriminator than the
   current `scanner_events` unique constraint?
3. When can sync transport drop `messageId` and rely on `messageSyncId`
   exclusively for tool-call relationships?
