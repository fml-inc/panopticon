# Local Workstreams And Code Provenance V1

This document proposes the next read-model layer on top of panopticon's
existing `claims -> intent_units / intent_edits` pipeline.

The goal of this slice is deliberately narrow:

- answer "why is this code here?" for local work
- answer "what larger local workstream was this intent part of?"
- preserve the historical trail needed to later support real-time coordination
- avoid committing to a team-wide or lease-based coordination model yet

This is a local-first proposal. It should still carry enough identity to widen
later to multi-agent shared-workspace coordination and multi-machine/team scope.

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
2. What local workstream does this intent belong to?
3. What recently touched this path?
4. What workstreams are active, landed, mixed, or abandoned on this machine?

## Addressability Model

V1 addressability is intentionally simple:

- code lookup input: `path` plus optional `line`
- provenance binding: file-level first, span-level when confidently bindable
- symbol metadata: optional enrichment fields, not first-class tables

The system should prefer precise span answers when possible and fall back to
file-level explanations when not.

## Migration

Suggested migration name:

- `add_local_workstreams_and_code_provenance`

Suggested SQL:

```sql
CREATE TABLE IF NOT EXISTS workstreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_key TEXT NOT NULL UNIQUE,
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

CREATE TABLE IF NOT EXISTS intent_workstreams (
  intent_unit_id INTEGER NOT NULL,
  workstream_id INTEGER NOT NULL,
  membership_kind TEXT NOT NULL, -- primary | related
  source TEXT NOT NULL,          -- heuristic | claim
  score REAL NOT NULL DEFAULT 1.0,
  reason_json TEXT,
  UNIQUE(intent_unit_id, workstream_id)
);

CREATE TABLE IF NOT EXISTS code_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
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
  workstream_id INTEGER,
  status TEXT NOT NULL, -- current | ambiguous | stale
  confidence REAL NOT NULL DEFAULT 1.0,
  file_hash TEXT,
  established_at_ms INTEGER NOT NULL,
  verified_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workstreams_repo
  ON workstreams(repository);
CREATE INDEX IF NOT EXISTS idx_workstreams_status
  ON workstreams(status);
CREATE INDEX IF NOT EXISTS idx_workstreams_last_ts
  ON workstreams(last_intent_ts_ms);

CREATE INDEX IF NOT EXISTS idx_intent_workstreams_intent
  ON intent_workstreams(intent_unit_id);
CREATE INDEX IF NOT EXISTS idx_intent_workstreams_workstream
  ON intent_workstreams(workstream_id);

CREATE INDEX IF NOT EXISTS idx_code_provenance_repo_file
  ON code_provenance(repository, file_path);
CREATE INDEX IF NOT EXISTS idx_code_provenance_workstream
  ON code_provenance(workstream_id);
CREATE INDEX IF NOT EXISTS idx_code_provenance_intent
  ON code_provenance(intent_unit_id);
CREATE INDEX IF NOT EXISTS idx_code_provenance_status
  ON code_provenance(status);
```

## Projection Semantics

### `workstreams`

`workstreams` groups prompt-level intents into a larger local work object.

V1 grouping should be heuristic and conservative:

- same `repository`
- nearby `cwd`
- same session when available
- close in time
- shared touched files
- shared branch/worktree if available

V1 rule:

- every intent gets exactly one `primary` workstream
- additional `related` memberships can wait until later if they complicate the
  initial rebuild logic

V1 title derivation:

- default title: first intent prompt text, truncated
- later override path: claim-backed metadata such as `workstream/title`

V1 status derivation:

- `active`: has unreconciled edits or fresh intents with unknown outcome
- `landed`: all known edits landed and no open edits remain
- `mixed`: some landed, some churned/reverted, no open edits remain
- `abandoned`: no landed edits and no open edits remain

### `intent_workstreams`

`intent_workstreams` keeps workstream grouping explorable and auditable.

It should preserve:

- why an intent was grouped
- whether the grouping came from heuristics or explicit future claims
- a score so later ranking/tie-breaking does not require schema changes

### `code_provenance`

`code_provenance` answers "best current explanation for this local code."

It is derived from:

- `intent_edits`
- landed status / landed reason
- current file contents on disk

V1 binding rules:

- if a current snippet can be matched confidently, emit a `span` row
- otherwise emit a `file` row
- if multiple plausible rows remain, mark the winner `ambiguous`
- if a once-valid row no longer binds cleanly, mark it `stale`

`code_provenance` is not a history table. It is the current best explanation
layer. Historical browsing still comes from `intent_edits` and `workstreams`.

## Proposed Service Types

Add to `src/service/types.ts`:

```ts
export interface ListWorkstreamsInput {
  repository?: string;
  cwd?: string;
  status?: "active" | "landed" | "mixed" | "abandoned";
  path?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface WorkstreamDetailInput {
  workstream_id: number;
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

Add to `PanopticonService`:

```ts
  listWorkstreams(opts?: ListWorkstreamsInput): Promise<unknown>;
  workstreamDetail(opts: WorkstreamDetailInput): Promise<unknown>;
  whyCode(opts: WhyCodeInput): Promise<unknown>;
  recentWorkOnPath(opts: RecentWorkOnPathInput): Promise<unknown>;
```

## Proposed Tool Names

Add to `src/service/transport.ts`:

```ts
  workstreams: (service, params) =>
    service.listWorkstreams(asType<ListWorkstreamsInput>(params)),
  workstream_detail: (service, params) =>
    service.workstreamDetail(asType<WorkstreamDetailInput>(params)),
  why_code: (service, params) =>
    service.whyCode(asType<WhyCodeInput>(params)),
  recent_work_on_path: (service, params) =>
    service.recentWorkOnPath(asType<RecentWorkOnPathInput>(params)),
```

These should also be added to `src/mcp/server.ts` with matching zod schemas.

## API Contract

Panopticon's current HTTP surface is transport-based:

- `POST /api/tool` with `{ name, params }`

V1 should fit that shape directly.

### `workstreams`

Request:

```json
{
  "name": "workstreams",
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
    "workstream_id": 17,
    "workstream_key": "ws:local:/Users/gus/workspace/panopticon:17",
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

### `workstream_detail`

Request:

```json
{
  "name": "workstream_detail",
  "params": {
    "workstream_id": 17
  }
}
```

Response:

```json
{
  "workstream": {
    "workstream_id": 17,
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
  "workstream": {
    "workstream_id": 17,
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
        "status": "current"
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
      "workstream_id": 17,
      "workstream_title": "service layer and path hardening",
      "intent_unit_id": 301,
      "prompt_text": "move tool dispatch into shared transport",
      "intent_edit_id": 822,
      "timestamp_ms": 1745020137000,
      "status": "current"
    },
    {
      "workstream_id": 16,
      "workstream_title": "claims-backed intent projection clean cutover",
      "intent_unit_id": 288,
      "intent_edit_id": 790,
      "timestamp_ms": 1745019700000,
      "status": "superseded"
    }
  ]
}
```

## Query Implementation Sketch

### `listWorkstreams`

Backed by direct reads from `workstreams`, optionally filtered by:

- `repository`
- `cwd`
- `status`
- `since`

When `path` is provided:

- join through `code_provenance` or, before that projection is complete,
  derive from `intent_edits -> intent_workstreams`

### `workstreamDetail`

Return:

- one row from `workstreams`
- member intents from `intent_workstreams + intent_units`
- touched files aggregated from `intent_edits`

### `whyCode`

Resolution order:

1. exact `span` row in `code_provenance` covering the requested line
2. best `file` row in `code_provenance`
3. fallback to current `intent_for_code(path)` history plus ambiguity marker

This fallback allows the tool to ship before span binding is perfect.

### `recentWorkOnPath`

Return chronological local history for a file using:

- `intent_edits`
- joined `intent_workstreams`
- joined `workstreams`

This is historical, not only current-state provenance.

## Rebuild Strategy

Suggested exec command later:

- `rebuild-workstream-projections`

It should:

1. rebuild `workstreams`
2. rebuild `intent_workstreams`
3. rebuild `code_provenance`

Session-scoped rebuild support can wait until the grouping logic is stable.

## Validation Cases

Implementation should not be considered ready until these pass:

1. single local intent with one landed edit
2. multiple intents grouped into one workstream by shared files and time
3. two workstreams touching the same file at different times
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
