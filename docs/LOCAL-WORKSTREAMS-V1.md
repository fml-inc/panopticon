# Session Summaries And Code Provenance V1

This document records the current local read-model layer on top of panopticon's
existing `claims -> intent_units / intent_edits` pipeline.

## Status On Main

As of `main` on April 22, 2026:

- `session_summaries`, `intent_session_summaries`, and `code_provenance` are in
  the core schema.
- `rebuildIntentProjection()` rebuilds these projections through
  `rebuildSessionSummaryProjections()` when
  `PANOPTICON_ENABLE_SESSION_SUMMARY_PROJECTIONS=1`.
- The current grouping rule is intentionally simple: one derived session summary
  row per `session_id`, keyed as `ss:local:<session_id>`.
- The exposed service and MCP tool names are:
  - `session_summaries`
  - `session_summary_detail`
  - `why_code`
  - `recent_work_on_path`
  - `file_overview`
- Those tools are feature-gated behind the same environment flag.
- `listSessions()` also enriches session results with session-summary metadata
  when the flag is enabled.
- `why_code`, `recent_work_on_path`, and `file_overview` are deterministic
  structured queries. They do not currently call an LLM.

Historical "workstream" terminology elsewhere in this doc should be read as
"session summary". Cross-session grouping is still follow-up work.

The current implementation scope is deliberately narrow:

- answer "why is this code here?" for local work
- replace weak per-session summary text with an explicit session-derived summary
- preserve the historical trail needed to later support real-time coordination
- avoid committing to a team-wide or lease-based coordination model yet

This is still a local-first design. The current implementation does not yet
implement cross-session session-summary grouping. It uses one derived summary
row per session and leaves true multi-session grouping as a follow-on layer.

## Non-goals

V1 does not attempt to provide:

- perfect line ownership
- exact AST/symbol provenance everywhere
- reservations / leases / coordination policy
- team-wide sync or cross-machine provenance joins
- checkpoint / rewind / resume semantics

## Existing Truth Layers

No new source-of-truth tables are introduced.

Truth remains:

- raw events: `hook_events`, `messages`, `tool_calls`, scanner rows
- semantic facts: `claims`, `claim_evidence`, `active_claims`
- current intent projection: `intent_units`, `intent_edits`

The new tables below are disposable projections that can be rebuilt from
existing data plus current file state on disk.

## User Questions

V1 is meant to answer:

1. Why is this code here?
2. What explicit session summary does this intent belong to?
3. What recently touched this path?
4. What is the current local overview of this file and what else changed with it?
5. What session summaries are active, landed, mixed, or abandoned on this machine?

## Addressability Model

V1 addressability is intentionally simple:

- code lookup input: `path` plus optional `line`
- provenance binding: file-level first, span-level when confidently bindable
- symbol metadata: optional enrichment fields, not first-class tables

The system should prefer precise span answers when possible and fall back to
file-level explanations when not.

## Current Schema

The current schema lives in `src/db/schema.ts` and includes:

```sql
CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_summary_key TEXT NOT NULL UNIQUE,
  repository TEXT,
  cwd TEXT,
  branch TEXT,
  worktree TEXT,
  actor TEXT,
  machine TEXT NOT NULL DEFAULT 'local',
  origin_scope TEXT NOT NULL DEFAULT 'local',
  title TEXT NOT NULL,
  status TEXT NOT NULL, -- active | landed | mixed | abandoned
  first_intent_ts_ms INTEGER,
  last_intent_ts_ms INTEGER,
  intent_count INTEGER NOT NULL DEFAULT 0,
  edit_count INTEGER NOT NULL DEFAULT 0,
  landed_edit_count INTEGER NOT NULL DEFAULT 0,
  open_edit_count INTEGER NOT NULL DEFAULT 0,
  reconciled_at_ms INTEGER,
  reason_json TEXT
);

CREATE TABLE IF NOT EXISTS intent_session_summaries (
  intent_unit_id INTEGER NOT NULL,
  session_summary_id INTEGER NOT NULL,
  membership_kind TEXT NOT NULL, -- primary | related
  source TEXT NOT NULL,          -- heuristic | claim
  score REAL NOT NULL DEFAULT 1.0,
  reason_json TEXT,
  UNIQUE(intent_unit_id, session_summary_id)
);

CREATE TABLE IF NOT EXISTS code_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL,
  binding_level TEXT NOT NULL, -- file | span
  start_line INTEGER,
  end_line INTEGER,
  snippet_hash TEXT,
  snippet_preview TEXT,
  language TEXT,
  symbol_kind TEXT,
  symbol_name TEXT,
  actor TEXT,
  machine TEXT NOT NULL DEFAULT 'local',
  origin_scope TEXT NOT NULL DEFAULT 'local',
  intent_unit_id INTEGER NOT NULL,
  intent_edit_id INTEGER,
  session_summary_id INTEGER,
  status TEXT NOT NULL, -- current | ambiguous | stale
  confidence REAL NOT NULL DEFAULT 1.0,
  file_hash TEXT,
  established_at_ms INTEGER NOT NULL,
  verified_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_repo
  ON session_summaries(repository);
CREATE INDEX IF NOT EXISTS idx_session_summaries_status
  ON session_summaries(status);
CREATE INDEX IF NOT EXISTS idx_session_summaries_last_ts
  ON session_summaries(last_intent_ts_ms);

CREATE INDEX IF NOT EXISTS idx_intent_session_summaries_intent
  ON intent_session_summaries(intent_unit_id);
CREATE INDEX IF NOT EXISTS idx_intent_session_summaries_session_summary
  ON intent_session_summaries(session_summary_id);

CREATE INDEX IF NOT EXISTS idx_code_provenance_repo_file
  ON code_provenance(repository, file_path);
CREATE INDEX IF NOT EXISTS idx_code_provenance_session_summary
  ON code_provenance(session_summary_id);
CREATE INDEX IF NOT EXISTS idx_code_provenance_intent
  ON code_provenance(intent_unit_id);
CREATE INDEX IF NOT EXISTS idx_code_provenance_status
  ON code_provenance(status);
```

## Projection Semantics

### `session_summaries`

The current implementation creates exactly one local summary row per session.

Current grouping rule:

- `session_summary_key = ss:local:<session_id>`
- every intent in the session gets exactly one `primary` membership
- `membership_kind = 'primary'`
- `source = 'heuristic'`
- `score = 1.0`
- `reason_json = {"strategy":"session_id"}`

Cross-session grouping by shared files, time, repo, or branch is not
implemented yet.

Current title derivation:

- default title: first intent prompt text, truncated
- later override path: claim-backed metadata such as `workstream/title`

Current status derivation:

- `active`: has unreconciled edits or fresh intents with unknown outcome
- `landed`: all known edits landed and no open edits remain
- `mixed`: some landed, some churned/reverted, no open edits remain
- `abandoned`: no landed edits and no open edits remain

### `intent_session_summaries`

`intent_session_summaries` keeps session-summary membership explorable and
auditable.

Current implementation preserves:

- that the membership came from the session-id grouping strategy
- one `primary` membership per intent
- room for richer grouping later without another schema change

### `code_provenance`

`code_provenance` answers "best current explanation for this local code."

It is derived from:

- `intent_edits`
- landed status / landed reason
- current file contents on disk

Current binding rules:

- if a current snippet can be matched confidently, emit a `span` row
- otherwise emit a `file` row
- if multiple plausible rows remain, mark the winner `ambiguous`
- if a once-valid row no longer binds cleanly, mark it `stale`

`code_provenance` is not a history table. It is the current best explanation
layer. Historical browsing still comes from `intent_edits` and `session_summaries`.

## Current Service Types

The current service surface in `src/service/types.ts` exposes:

```ts
export interface ListSessionSummariesInput {
  repository?: string;
  cwd?: string;
  status?: "active" | "landed" | "mixed" | "abandoned";
  path?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface SessionSummaryDetailInput {
  session_id: string;
}

export interface WhyCodeInput {
  path: string;
  line?: number;
  repository?: string;
}

export interface RecentWorkOnPathInput {
  path: string;
  repository?: string;
  limit?: number;
}
```

Current `PanopticonService` methods:

```ts
  listSessionSummaries(opts?: ListSessionSummariesInput): Promise<unknown>;
  sessionSummaryDetail(opts: SessionSummaryDetailInput): Promise<unknown>;
  whyCode(opts: WhyCodeInput): Promise<unknown>;
  recentWorkOnPath(opts: RecentWorkOnPathInput): Promise<unknown>;
  fileOverview(opts: FileOverviewInput): Promise<unknown>;
```

## Current Tool Names

The current transport layer exposes:

```ts
  session_summaries: (service, params) =>
    service.listSessionSummaries(asType<ListSessionSummariesInput>(params)),
  session_summary_detail: (service, params) =>
    service.sessionSummaryDetail(asType<SessionSummaryDetailInput>(params)),
  why_code: (service, params) =>
    service.whyCode(asType<WhyCodeInput>(params)),
  recent_work_on_path: (service, params) =>
    service.recentWorkOnPath(asType<RecentWorkOnPathInput>(params)),
  file_overview: (service, params) =>
    service.fileOverview(asType<FileOverviewInput>(params)),
```

These tools are only registered when
`PANOPTICON_ENABLE_SESSION_SUMMARY_PROJECTIONS=1`.

## API Contract

Panopticon's current HTTP surface is transport-based:

- `POST /api/tool` with `{ name, params }`

V1 should fit that shape directly.

### `session_summaries`

Request:

```json
{
  "name": "session_summaries",
  "params": {
    "repository": "/Users/gus/workspace/panopticon",
    "status": "active",
    "limit": 20
  }
}
```

Response:

```json
[
  {
    "session_id": "abc123",
    "title": "service layer and path hardening",
    "status": "landed",
    "repository": "/Users/gus/workspace/panopticon",
    "cwd": "/Users/gus/workspace/panopticon",
    "branch": "gus/service-layer-path-hardening",
    "worktree": null,
    "actor": "gus",
    "machine": "local",
    "origin_scope": "local",
    "first_intent_ts_ms": 1745020000000,
    "last_intent_ts_ms": 1745020900000,
    "intent_count": 4,
    "edit_count": 11,
    "landed_edit_count": 8,
    "open_edit_count": 0
  }
]
```

### `session_summary_detail`

Request:

```json
{
  "name": "session_summary_detail",
  "params": {
    "session_id": "abc123"
  }
}
```

Response:

```json
{
  "session_summary": {
    "session_id": "abc123",
    "title": "service layer and path hardening",
    "status": "landed",
    "repository": "/Users/gus/workspace/panopticon",
    "cwd": "/Users/gus/workspace/panopticon",
    "branch": "gus/service-layer-path-hardening",
    "actor": "gus",
    "machine": "local",
    "origin_scope": "local",
    "first_intent_ts_ms": 1745020000000,
    "last_intent_ts_ms": 1745020900000,
    "intent_count": 4,
    "edit_count": 11,
    "landed_edit_count": 8,
    "open_edit_count": 0
  },
  "intents": [
    {
      "intent_unit_id": 301,
      "prompt_text": "move tool dispatch into shared transport",
      "prompt_ts_ms": 1745020123000,
      "session_id": "abc123",
      "membership_kind": "primary",
      "score": 0.96
    }
  ],
  "files": [
    {
      "file_path": "src/service/transport.ts",
      "edit_count": 3,
      "landed_count": 3
    }
  ]
}
```

### `why_code`

Request:

```json
{
  "name": "why_code",
  "params": {
    "path": "src/service/transport.ts",
    "line": 28
  }
}
```

Response:

```json
{
  "path": "src/service/transport.ts",
  "line": 28,
  "match_level": "span",
  "status": "current",
  "confidence": 0.91,
  "repository": "/Users/gus/workspace/panopticon",
  "session_summary": {
    "session_summary_id": 17,
    "title": "service layer and path hardening",
    "status": "landed"
  },
  "intent": {
    "intent_unit_id": 301,
    "prompt_text": "move tool dispatch into shared transport",
    "session_id": "abc123",
    "prompt_ts_ms": 1745020123000
  },
  "edit": {
    "intent_edit_id": 822,
    "file_path": "src/service/transport.ts",
    "tool_name": "Edit",
    "timestamp_ms": 1745020137000,
    "landed": 1,
    "landed_reason": null,
    "snippet_preview": "export const TOOL_HANDLERS = {"
  },
  "binding": {
    "binding_level": "span",
    "start_line": 24,
    "end_line": 40,
    "symbol_kind": null,
    "symbol_name": null
  },
  "evidence": {
    "intent_for_code": [
      {
        "intent_unit_id": 301,
        "edit": {
          "edit_count": 2,
          "current_edit_count": 1,
          "superseded_edit_count": 1,
          "reverted_edit_count": 0,
          "unknown_edit_count": 0
        },
        "status": "mixed"
      }
    ]
  },
  "related_candidates": []
}
```

If only a file-level answer is possible:

```json
{
  "path": "src/service/transport.ts",
  "line": 28,
  "match_level": "file",
  "status": "ambiguous",
  "confidence": 0.54,
  "related_candidates": [
    {
      "intent_unit_id": 301,
      "reason": "same file, nearby timestamp"
    },
    {
      "intent_unit_id": 305,
      "reason": "same file, no unique snippet binding"
    }
  ]
}
```

### `recent_work_on_path`

Request:

```json
{
  "name": "recent_work_on_path",
  "params": {
    "path": "src/service/transport.ts",
    "limit": 10
  }
}
```

Response:

```json
{
  "path": "src/service/transport.ts",
  "repository": "/Users/gus/workspace/panopticon",
  "recent": [
    {
      "session_summary_id": 17,
      "session_summary_title": "service layer and path hardening",
      "intent_unit_id": 301,
      "prompt_text": "move tool dispatch into shared transport",
      "intent_edit_id": 822,
      "edit_count": 2,
      "current_edit_count": 1,
      "superseded_edit_count": 1,
      "reverted_edit_count": 0,
      "unknown_edit_count": 0,
      "timestamp_ms": 1745020137000,
      "status": "mixed"
    },
    {
      "session_summary_id": 16,
      "session_summary_title": "claims-backed intent projection clean cutover",
      "prompt_text": "initial transport cleanup",
      "intent_unit_id": 288,
      "intent_edit_id": 790,
      "edit_count": 1,
      "current_edit_count": 0,
      "superseded_edit_count": 1,
      "reverted_edit_count": 0,
      "unknown_edit_count": 0,
      "timestamp_ms": 1745019700000,
      "status": "superseded"
    }
  ]
}
```

### `file_overview`

Request:

```json
{
  "name": "file_overview",
  "params": {
    "path": "src/service/transport.ts",
    "recent_limit": 5,
    "related_limit": 10
  }
}
```

Response:

```json
{
  "path": "src/service/transport.ts",
  "repository": "/Users/gus/workspace/panopticon",
  "summary": {
    "intent_count": 4,
    "edit_count": 6,
    "session_summary_count": 2,
    "current_edit_count": 3,
    "superseded_edit_count": 1,
    "reverted_edit_count": 2,
    "unknown_edit_count": 0
  },
  "current": {
    "status": "current",
    "confidence": 0.91,
    "binding_level": "span",
    "session_summary_id": 17,
    "session_summary_title": "service layer and path hardening",
    "intent_unit_id": 301,
    "intent_edit_id": 822,
    "prompt_text": "move tool dispatch into shared transport",
    "snippet_preview": "export const TOOL_HANDLERS = {"
  },
  "recent": [
    {
      "intent_unit_id": 301,
      "edit_count": 2,
      "current_edit_count": 1,
      "superseded_edit_count": 1,
      "reverted_edit_count": 0,
      "unknown_edit_count": 0,
      "status": "mixed"
    }
  ],
  "related_files": [
    {
      "file_path": "src/service/http.ts",
      "shared_intent_count": 2,
      "shared_session_summary_count": 1,
      "last_status": "current"
    }
  ]
}
```

## Query Implementation Sketch

### `listSessionSummaries`

Backed by direct reads from `session_summaries`, optionally filtered by:

- `repository`
- `cwd`
- `status`
- `since`

When `path` is provided:

- join through `code_provenance`

### `sessionSummaryDetail`

Return:

- one row from `session_summaries`
- member intents from `intent_session_summaries + intent_units`
- touched files aggregated from `intent_edits`

### `whyCode`

Resolution order:

1. exact `span` row in `code_provenance` covering the requested line
2. best `file` row in `code_provenance`
3. fallback to current `intent_for_code(path)` history plus ambiguity marker

This fallback allows the tool to ship before span binding is perfect.

### `recentWorkOnPath`

Return chronological local history for a file using one row per intent touching
that file rather than one row per raw `intent_edit`. Repeated edits, multi-edit
batches, and apply-patch batches from the same prompt collapse into a single row
with aggregate outcome counts.

Uses:

- `intent_edits`
- joined `intent_session_summaries`
- joined `session_summaries`

This is historical, not only current-state provenance.

### `fileOverview`

Return a file-level aggregate using:

- `why_code` for the best current local explanation
- `recent_work_on_path` for short chronological history
- `intent_edits`, `intent_units`, and `intent_session_summaries` for counts
- related-file aggregation over shared intents and shared session summaries

## Rebuild Strategy

Current rebuild path:

- `rebuild-intent-projection-from-claims`

That rebuilds:

1. rebuild `session_summaries`
2. rebuild `intent_session_summaries`
3. rebuild `code_provenance`

Session-scoped rebuild is also supported through the `sessionId` option on the
projection rebuild path.

## Validation Cases

Implementation should not be considered ready until these pass:

1. single local intent with one landed edit
2. multiple intents grouped into one workstream by shared files and time
3. two session_summaries touching the same file at different times
4. overwritten edit in the same session
5. reverted edit after session close
6. duplicate snippet causing an `ambiguous` answer
7. scanner-only local session
8. hook-only local session

## Why This Shape

This proposal keeps local "why/how" answers separate from future coordination
policy, but it still ladders toward it cleanly:

- history remains append-only in the underlying truth tables
- current-state answers come from disposable projections
- local identity fields (`actor`, `machine`, `origin_scope`) are present from
  day one
- later lease / reservation events can be projected into adjacent tables
  without replacing this model

That makes V1 useful immediately for local provenance while still leaving a
straight path toward:

- shared-workspace multi-agent coordination
- larger team / multi-machine provenance
- richer symbol-aware or AST-aware bindings
