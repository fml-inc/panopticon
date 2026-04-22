# MCP Payloads Fast Follow

This document proposes the broader MCP payload work that should follow the
current `claude -p` subprocess hardening.

The subprocess wrapper is now reliable enough to run real session-summary
probes. The next bottleneck is not auth or process startup. It is oversized
MCP tool responses from panopticon's local MCP server.

## Problem

Panopticon currently returns most MCP tool results as a single large
`JSON.stringify(...)` text blob from [src/mcp/server.ts](/Users/gus/workspace/panopticon/src/mcp/server.ts).

That is workable for small responses, but it breaks down for session-summary
workloads:

- `timeline(limit=50)` can exceed Claude Code's inline result threshold
- broad `query` calls can exceed it even more easily
- Claude persists those results to a tmp file and replaces the inline result
  with a file reference
- in our headless summary setup, built-in tools are disabled, so that spill file
  is not a primary access path we should design around

In ad hoc runs against real panopticon sessions we observed:

- `timeline(limit=50)` overflow at `82,538` characters
- a broad `query` overflow at `108,646` characters
- Claude recovered by issuing narrower follow-up tool calls rather than by
  relying on the spill file

This means the current issue is architectural, not incidental.

## Goals

- Keep normal summary-oriented MCP calls small enough to stay inline
- Let Claude explore sessions progressively instead of starting from a giant
  payload
- Preserve access to full-fidelity data when needed
- Keep the MCP server generally useful outside the summary flow
- Make the next PR small enough to land quickly

## Non-goals

- Removing the raw `query` tool entirely
- Making arbitrary large SQL results safe to inline
- Reworking the session-summary feature itself
- Depending on Claude's tmp-file spill behavior as a primary transport

## Current Failure Mode

The current summary prompt in
[src/summary/loop.ts](/Users/gus/workspace/panopticon/src/summary/loop.ts)
starts with:

- `timeline(sessionId, limit=50)`

That is too large for longer sessions because row-count is a poor proxy for
payload size. A session with many long messages, tool inputs, or subagent
metadata can blow past the inline threshold even when payload truncation is on.

The raw `query` tool is even riskier because it has no output budget at all.

## Design Rules

### 1. Budget by characters, not rows

`limit=50` is not a stable contract. The MCP layer should stop building a page
when it reaches a payload budget and report that there is more to read.

### 2. Overview first, detail second

The first call should give Claude a compact map of the session, not a large dump
of message content.

### 3. Use higher size limits only for bounded tools

Claude Code supports per-tool `_meta["anthropic/maxResultSizeChars"]`, but that
should only be used for tools with naturally bounded output. It is appropriate
for `timeline` and `get`. It is not a substitute for redesigning `query`.

### 4. Make large data addressable

If some data is too large to inline, expose it as an explicit resource or a
smaller follow-up read path. Do not rely on Claude's private tmp-file spill path
as panopticon's API.

## Proposed Changes

### 1. Prompt-level mitigation

Lower the initial summary prompt's first read from `timeline(limit=50)` to a
smaller page, such as `10` or `20`.

This is not the full fix, but it is a safe mitigation and can land
independently.

Files:

- [src/summary/loop.ts](/Users/gus/workspace/panopticon/src/summary/loop.ts)

### 2. Move selected tools to `registerTool(...)` with `_meta`

Panopticon currently uses `server.tool(...)` everywhere. The MCP SDK already
supports `registerTool(...)` with both `annotations` and arbitrary `_meta`.

For tools that are useful inline and reasonably bounded, switch to
`registerTool(...)` and set:

```ts
_meta: {
  "anthropic/maxResultSizeChars": 120000,
}
```

Initial candidates:

- `timeline`
- `get`
- possibly `search`

Avoid adding this to `query` at first. Raising `query` too much will just make
it easier to dump huge text into the model context.

Files:

- [src/mcp/server.ts](/Users/gus/workspace/panopticon/src/mcp/server.ts)

### 3. Add char-budgeted pagination to `timeline`

`sessionTimeline()` should page by both row count and serialized size.

Suggested shape:

```ts
interface SessionTimelineInput {
  sessionId: string;
  limit?: number;
  offset?: number;
  fullPayloads?: boolean;
  maxChars?: number;
}

interface SessionTimelineResult {
  session: ...;
  messages: ...;
  totalMessages: number;
  hasMore: boolean;
  nextOffset: number | null;
  truncatedByBudget: boolean;
  returnedChars: number;
  source: "local";
}
```

Implementation sketch:

1. Read candidate rows in ordinal order
2. Serialize incrementally
3. Stop before exceeding `maxChars`
4. Return the largest inline-safe page plus `nextOffset`

This keeps `timeline` useful without making the first page arbitrarily large.

Files:

- [src/db/query.ts](/Users/gus/workspace/panopticon/src/db/query.ts)
- [src/service/types.ts](/Users/gus/workspace/panopticon/src/service/types.ts)
- [src/service/direct.ts](/Users/gus/workspace/panopticon/src/service/direct.ts)
- [src/service/http.ts](/Users/gus/workspace/panopticon/src/service/http.ts)
- [src/mcp/server.ts](/Users/gus/workspace/panopticon/src/mcp/server.ts)

### 4. Add a compact `session_overview` MCP tool

Claude should not need to start from raw messages.

Add a summary-oriented read tool that returns:

- session metadata
- message count
- child-session count
- repositories / cwd / branch when available
- top tool counts
- top edited files if derivable cheaply
- first and last message ids / ordinals
- a small set of notable message ids to inspect next

This should become the first MCP call in the summary prompt.

The intended flow becomes:

1. `session_overview(sessionId)`
2. `timeline(sessionId, limit=10, offset=0, maxChars=...)`
3. `get(source, id)` for specific rows
4. `query(sql)` only as a last resort

Files:

- [src/mcp/server.ts](/Users/gus/workspace/panopticon/src/mcp/server.ts)
- [src/db/query.ts](/Users/gus/workspace/panopticon/src/db/query.ts)
- [src/summary/loop.ts](/Users/gus/workspace/panopticon/src/summary/loop.ts)

### 5. Add explicit resources or `resource_link`s for truly large reads

If we still need a file-like intermediate path, make it explicit in MCP.

Candidates:

- paged timeline resources
- full message-content resources
- prebuilt session analysis reports

This keeps oversized reads protocol-native and inspectable, instead of
implicitly depending on Claude's private `tool-results/...txt` spill files.

This step is optional. It should only become a primary design once we verify
that `claude -p` handles `resource_link` follow-ups cleanly in our headless
configuration.

### 6. Tighten `query` expectations

`query` is too powerful to be the default exploration path.

Near-term guardrails:

- update the system prompt to prefer `session_overview`, `timeline`, and `get`
- treat `query` as a last-resort diagnostic tool
- avoid examples that encourage `SELECT *` across joined large tables

Longer-term, if summary workloads still rely heavily on `query`, add narrower
read tools instead of widening the query budget.

## Suggested PR Sequence

### PR 1

- lower initial `timeline` page size in the summary prompt

### PR 2

- switch `timeline` and `get` to `registerTool(...)`
- add `_meta["anthropic/maxResultSizeChars"]`

### PR 3

- add char-budgeted pagination and `nextOffset` to `timeline`

### PR 4

- add `session_overview`
- update the summary prompt to start there

### PR 5

- evaluate explicit resources / `resource_link`s for large follow-up reads

## Validation Plan

Use the same ad hoc summary harness that exercised real sessions.

Minimum checks:

- compare success rate before and after on a mixed sample of small, medium, and
  large sessions
- track duration
- track whether Claude spills MCP results to disk
- track which tools Claude actually uses
- confirm that the first `timeline` page stays inline on large sessions

Success criteria:

- no `timeline` spills on normal summary runs
- `query` usage drops materially
- summary quality stays at least as good as the current ad hoc runs
- total runtime does not regress significantly

## Open Questions

- What is the right default `_meta["anthropic/maxResultSizeChars"]` value for
  `timeline` and `get`?
- Should `search` also get a higher inline budget, or should it stay more
  conservative?
- Do `resource_link`-based follow-ups work well enough in `claude -p` JSON mode
  to justify making them part of the default path?
- Should `query` remain exposed to the summary workflow at all, or should we
  replace its common cases with dedicated read tools?

## Recommendation

The fast-follow should start with:

1. smaller initial `timeline` pages
2. `_meta["anthropic/maxResultSizeChars"]` on `timeline` and `get`
3. char-budgeted pagination
4. `session_overview`

That is enough to address the observed MCP payload failures without turning the
current subprocess-hardening PR into a broad MCP-server refactor.
