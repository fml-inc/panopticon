# Hook Blob Storage Design

This document records the follow-up design prompted by PR 216. PR 216 only
adds byte-aware sync batching; it intentionally does not change local hook
event storage semantics.

## Problem

Hook events can contain large tool results. Some real Panopticon MCP hook
events have produced single sync records larger than 1 MiB.

There are two separate failure modes:

- a batch can become too large because it contains too many rows
- a single row can be too large for a remote document/value limit

Byte-aware batching addresses the first failure mode. It does not solve the
second one.

The FML server-side large-object path solves the remote storage problem by
externalizing oversized hook fields to file storage. Panopticon should have an
analogous local design before it starts rewriting local hook payloads.

## Goals

- Preserve local observability fidelity: the original hook data must remain
  recoverable.
- Keep hook event metadata queryable without loading large blobs.
- Avoid storing repeated multi-megabyte strings in normal SQLite rows.
- Give sync a clean two-step path: row metadata first, blob content second.
- Make blob upload idempotent through content hashes.

## Non-Goals

- Do not truncate hook payloads or tool results.
- Do not silently redefine `hook_events.payload` from "raw hook event" to
  "normalized subset."
- Do not require the sync server to accept large values inline.
- Do not make PR 216 responsible for this storage migration.

## Proposed Local Model

Keep `hook_events` as the primary queryable row. Small values remain inline.
Large values move to a local content-addressed blob store.

Possible columns:

```sql
ALTER TABLE hook_events ADD COLUMN tool_result_ref TEXT;
ALTER TABLE hook_events ADD COLUMN tool_result_size INTEGER;
ALTER TABLE hook_events ADD COLUMN tool_result_hash TEXT;
ALTER TABLE hook_events ADD COLUMN tool_result_preview TEXT;
ALTER TABLE hook_events ADD COLUMN payload_ref TEXT;
ALTER TABLE hook_events ADD COLUMN payload_size INTEGER;
ALTER TABLE hook_events ADD COLUMN payload_hash TEXT;
ALTER TABLE hook_events ADD COLUMN payload_preview TEXT;
```

`tool_result_ref` and `payload_ref` should be stable content-addressed refs,
not path-shaped implementation details. A ref can be resolved through a local
blob store module.

Small values can stay in existing columns:

- `tool_result`
- compressed `payload`

Large values can clear the large inline value after the corresponding blob is
durably written and indexed. The row keeps size/hash/preview metadata.

## Local Blob Store

Use content-addressed files under the Panopticon data directory, for example:

```text
<dataDir>/blobs/sha256/<first-two-hex>/<full-sha256>
```

Blob writes should be atomic:

1. write to a temp file in the same directory
2. fsync if practical
3. rename into the final content-addressed path
4. treat existing identical hashes as success

The blob store should expose typed operations:

- `putBlob(bytes) -> { ref, hash, size }`
- `getBlob(ref) -> bytes`
- `hasBlob(ref | hash) -> boolean`
- `deleteUnreferencedBlobs(liveRefs)`

Compression should be a deliberate choice. The current `payload` column stores
gzip-compressed JSON. A blob store can either store compressed bytes with a
content encoding marker, or store raw bytes and let transport compression handle
sync. The DB metadata should record enough information to decode the blob.

## Ingest Behavior

At hook ingest:

1. Extract normal query metadata as today.
2. Decide whether `tool_result` and/or `payload` are large enough to
   externalize.
3. Store large fields in the blob store before committing the hook row.
4. Insert the hook row with inline metadata, hash, size, and preview.
5. Index previews and normal metadata in FTS.

The raw event fidelity decision must be explicit:

- If `payload` remains inline, it should remain the original hook event.
- If `payload` is externalized, the row should point at the original payload
  blob.
- If a normalized lightweight payload is also useful, store it as a separate
  projection field rather than overloading `payload`.

## Query Behavior

Default list/search queries should avoid loading blobs.

Rows should expose:

- normal hook metadata
- inline `tool_result` for small results
- preview/hash/size/ref metadata for externalized results
- a flag that tells clients whether a large field is available on demand

Detail queries can resolve blobs explicitly. UI and MCP tools should only fetch
large fields when the caller asks for the full value.

Search should initially cover previews and metadata. Full-blob search is a
separate indexing problem and should not block the storage model.

## Sync Behavior

Sync should split hook data into two channels.

The existing row sync sends queryable metadata:

```json
{
  "hookId": 123,
  "sessionId": "session-id",
  "toolName": "mcp__panopticon__search_intent",
  "toolResult": null,
  "toolResultRef": "sha256:...",
  "toolResultSize": 1925808,
  "toolResultHash": "...",
  "toolResultPreview": "...",
  "payloadRef": "sha256:...",
  "payloadSize": 2048123,
  "payloadHash": "...",
  "payloadPreview": "..."
}
```

A second blob sync path uploads missing blobs by hash/ref:

1. metadata sync sends refs and hashes
2. server responds with missing blob hashes, or client asks before upload
3. client uploads blobs through the server's large-object API
4. server stores blob content in its large-object store
5. row metadata points at server-side storage metadata after upload

This keeps normal row sync small and makes blob sync retryable. Uploads are
idempotent because content hashes define identity.

## Migration Strategy

Do not rewrite existing hook payloads in PR 216.

A future migration can be conservative:

- add nullable blob metadata columns
- leave existing rows inline
- externalize new large rows first
- optionally add a lazy backfill command for old large rows

Backfill should verify hash/size before clearing any inline value. If a blob
write fails, the row should remain inline.

## Garbage Collection

Blob GC should be reference based.

1. collect all live `*_ref` values from SQLite
2. compare with files under the blob store
3. delete only blobs not referenced by any row and older than a grace period

GC should be safe to interrupt and should never delete unknown paths outside
the blob root.

## Open Questions

- What exact threshold should Panopticon use for local externalization?
- Should payload blobs store compressed or raw JSON?
- Should `tool_result` full-text search index full blobs, previews only, or a
  separate bounded token sample?
- Should sync upload blobs before row metadata, after row metadata, or through
  a negotiated missing-hash protocol?
- Should payload and tool result blobs share one store with typed metadata, or
  use separate namespaces?

## Relationship To PR 216

PR 216 should remain a small transport hardening change:

- split sync POSTs by serialized byte size
- preserve local hook payloads exactly as they are today
- leave single-row oversized values for the server-side large-object path and
  this future local blob-store design

