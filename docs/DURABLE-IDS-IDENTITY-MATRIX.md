# Durable IDs Phase 1 Identity Matrix

## Scope

This document maps the current identity and sync behavior for the scanner-owned
tables and proposes the Phase 1 durable-ID model.

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

- `messages` have no `sync_id` at all.
- `tool_calls`, `scanner_turns`, and `scanner_events` have `sync_id`, but it is
  random and must be preserved manually across reparse.
- Sync watermarks are based on local autoincrement `id`, not durable identity.
- `tool_calls` sync payloads include unstable local `message_id`.
- Full atomic reparse preserves `target_session_sync`, which means local row-id
  watermarks can become stale even if row identity is otherwise preserved.

## Identity Matrix

| Table | Local id | Current natural key | Current transport key | Proposed durable key input | Proposed Phase 1 changes |
| --- | --- | --- | --- | --- | --- |
| `messages` | `messages.id` | `UNIQUE(session_id, ordinal)` plus optional `uuid` | none | `msg|<session_id>|uuid|<uuid>` if `uuid` present, else `msg|<session_id>|ord|<ordinal>` | Add `messages.sync_id`; emit it in sync payload; keep `id` only as local surrogate |
| `tool_calls` | `tool_calls.id` | currently implicit: local `message_id` + `tool_use_id`/`tool_name` | random `sync_id` | `tc|<message_sync_id>|tuid|<tool_use_id>` if present, else `tc|<message_sync_id>|idx|<call_index>` | Make `sync_id` deterministic; add `call_index`; emit `messageSyncId`; stop relying on local `message_id` across sync |
| `scanner_turns` | `scanner_turns.id` | `UNIQUE(session_id, source, turn_index)` | random `sync_id` | `turn|<session_id>|<source>|<turn_index>` | Replace random `sync_id` with deterministic value derived from natural key |
| `scanner_events` | `scanner_events.id` | `UNIQUE(session_id, source, event_type, timestamp_ms, tool_name)` | random `sync_id` | `event|<session_id>|<source>|<event_type>|<timestamp_ms>|<tool_name>` | Replace random `sync_id` with deterministic value derived from natural key |

## Table-by-Table Notes

### Messages

Current behavior:

- Local identity is `messages.id`.
- Dedup in storage uses `UNIQUE(session_id, ordinal)`.
- Parsed source UUIDs are stored in `uuid` / `parent_uuid`.
- Sync sends only the local row `id`, not a durable identity.

Implications:

- Reparse in the same DB is usually safe because new rows get larger local IDs.
- Atomic rebuild into a fresh DB is not safe to reason about via local IDs.
- Remote systems cannot dedupe logical message rows independently because no
  message-level transport key exists.

Phase 1 recommendation:

- Add `messages.sync_id`.
- Populate it deterministically on insert.
- Extend `MessageSyncRecord` and readers to include `syncId`.
- Keep `messages.id` for local joins and FTS only.

Fallback caveat:

- `uuid` is the strongest source identity and should be preferred when present.
- The `ordinal` fallback is sufficient for unchanged rescans, but it is weaker
  if a parser version later re-numbers legacy message streams. That is
  acceptable for Phase 1, but should stay explicitly documented.

### Tool Calls

Current behavior:

- Local identity is `tool_calls.id`.
- Sync sends both random `sync_id` and unstable local `message_id`.
- Reparse preservation matches rows by session + message ordinal + `tool_use_id`
  + `tool_name`.
- There is no stored `call_index`, so there is no deterministic fallback when
  `tool_use_id` is missing.

Implications:

- `tool_use_id` is good when present.
- Without `tool_use_id`, durable identity is under-specified today.
- Remote consumers should not depend on `message_id`.

Phase 1 recommendation:

- Add `call_index INTEGER NOT NULL` to `tool_calls`.
- Populate `call_index` from the tool-call position inside each message.
- Make `tool_calls.sync_id` deterministic from durable message identity plus
  either `tool_use_id` or `call_index`.
- Extend `ToolCallSyncRecord` to include `messageSyncId`.
- Keep `message_id` only as a local FK.

### Scanner Turns

Current behavior:

- Storage already has a strong natural key:
  `UNIQUE(session_id, source, turn_index)`.
- Sync identity is still random and restored manually after reparse.

Phase 1 recommendation:

- Derive `sync_id` directly from the existing natural key.
- Remove `scanner_turns` from sync-id snapshot/restore logic once inserts are
  deterministic.

### Scanner Events

Current behavior:

- Storage already assumes a natural key:
  `UNIQUE(session_id, source, event_type, timestamp_ms, tool_name)`.
- Sync identity is random and restored manually after reparse.

Phase 1 recommendation:

- Derive `sync_id` directly from the existing natural key.
- Remove `scanner_events` from sync-id snapshot/restore logic once inserts are
  deterministic.

Constraint:

- This preserves the same uniqueness assumption the table already makes. If a
  future source can emit multiple logically distinct events with the same
  current key shape, the table will need an explicit event index or stronger
  discriminator.

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
  - `event|sess_123|claude|tool_result|1710000000000|Write`
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

Phase 1 recommendation:

- Keep local row-id watermarks for steady-state incremental sync.
- On operations that can lower or reshuffle local row IDs, especially atomic
  full-reparse into a fresh DB, reset or rewind scanner-owned `target_session_sync`
  watermarks so the rows replay.
- Rely on deterministic `sync_id` for remote idempotency when replay happens.

Without this, a fresh DB rebuild can preserve old watermarks that point past the
new local row IDs.

## Supporting Scan-State Gap

`scanner_file_watermarks` is keyed only by `file_path` and byte offset.

That is not a row-identity problem, but it matters for Phase 1 because a future
replacement-detection improvement probably wants stronger file identity inputs
such as file hash, inode/device, or both. This can remain a supporting task and
does not need to block the row-level durable-ID work.

## Migration Notes

1. Add `messages.sync_id`.
2. Add `tool_calls.call_index`.
3. Backfill deterministic `sync_id` values for scanner-owned tables.
4. Update scanner insert paths to compute deterministic keys on write.
5. Update sync payload types and readers.
6. Update reparse paths to stop restoring scanner-owned random `sync_id` values.
7. Reset or rewind scanner-owned sync watermarks during atomic full-reparse.

## Suggested Implementation Order

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

## Tests Needed

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
   rows without `uuid`, or do we want a content-based fallback before Phase 1
   lands?
2. Do any scanner sources require a stronger event discriminator than the
   current `scanner_events` unique constraint?
3. Does the remote sync consumer need a compatibility window where both
   `messageId` and `messageSyncId` are sent for tool calls?
