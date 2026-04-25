# Daemon Execution Model

This document records how the installed panopticon daemon actually executes
today, where the serialization boundaries are, and what a sensible
concurrency/workpooling follow-up should look like.

It is intentionally operational rather than aspirational: the goal is to make
future runtime work line up with the current code, not with an older mental
model of "background tasks."

## Current Topology

The installed daemon is one unified server process.

Today that process owns:

- the HTTP server for `/hooks`, OTLP ingest, proxy routes, and `/api/*`
- one scanner loop
- one core sync loop
- one OTel-focused sync loop
- one hourly prune timer
- one session-summary pass that runs from the scanner's idle path

The top-level boot order lives in `src/server.ts`:

1. start the unified HTTP server
2. start the scanner loop
3. wait for the scanner to report `onReady`
4. start sync loops only after scanner readiness
5. run prune once, then schedule prune hourly

That startup ordering is an important invariant: sync is intentionally deferred
until the scanner has finished any startup reparse or derived-state rebuild, so
the daemon does not export partial or stale local state.

## Current Execution Style

The runtime is mostly serialized.

That is true in two separate senses:

1. loop scheduling is serialized
   - each loop instance allows only one in-flight tick at a time
   - scanner, core sync, and OTel sync each schedule the next tick only after
     the current one finishes
2. much of the work inside those ticks is also synchronous/blocking
   - file discovery and file reads are synchronous
   - database reads and writes are synchronous
   - summary runner invocation uses synchronous child-process calls

That means a future "concurrency" change cannot stop at rearranging promises.
For several hot paths, real workpooling will require explicit worker/process
boundaries or async subprocess orchestration.

## Scanner Loop

The scanner loop lives in `src/scanner/loop.ts`.

Default cadence:

- idle interval: 60s
- catch-up interval: 5s

Execution model per tick:

1. if this is the first tick, check whether raw-data resync or claims rebuild
   is required
2. discover scanner files for each registered target
3. parse discovered files one file at a time
4. write each file's results in one DB transaction
5. archive raw session files
6. rebuild touched sessions one session at a time
7. link subagent sessions
8. if the scan found no new turns and the scanner is already ready, run the
   session-summary pass

Important serialization boundaries today:

- target discovery is serial
- file parsing is serial
- per-file DB writes are serial
- touched-session rebuild is serial
- summary execution is mixed:
  projection-backed enrichment uses a bounded async runner pool, while legacy
  summary generation remains serial

The touched-session rebuild phase is itself a three-stage serial pipeline per
session:

1. `rebuildIntentClaimsFromScanner({ sessionId })`
2. `reconcileLandedClaimsFromDisk({ sessionId })`
3. `rebuildIntentProjection({ sessionId })`

This is currently the most obvious place where a bounded workpool could improve
throughput without changing the external runtime model.

## Session Summary Execution

The session-summary pass lives in `src/session_summaries/pass.ts` and is called
from the scanner's idle path.

It has two parts:

1. projection-backed enrichment refresh
2. legacy `sessions.summary` generation

### Projection-backed enrichment refresh

If `PANOPTICON_ENABLE_SESSION_SUMMARY_PROJECTIONS=1`, the daemon first runs
`refreshSessionSummaryEnrichmentsOnce()`.

Current behavior:

- selects dirty rows
- claims rows transactionally
- processes claimed rows through a bounded worker pool
- invokes the selected CLI runner through async subprocess execution
- writes success/failure state back per row as workers finish

Default limits:

- background limit from direct exec path: `PANOPTICON_SESSION_SUMMARY_ENRICH_LIMIT`
  default `5`
- worker concurrency: `PANOPTICON_SESSION_SUMMARY_ENRICH_CONCURRENCY`
  default `2`
- scanner-idle limit: `PANOPTICON_SESSION_SUMMARY_SCANNER_ENRICH_LIMIT`
  default `2`
- timeout: `PANOPTICON_SESSION_SUMMARY_ENRICH_TIMEOUT_MS`
  default `90000`

Important nuance:

- the scanner tick still waits for the full summary pass before scheduling the
  next idle cycle
- all workers still write through the same SQLite connection, so this is
  bounded overlapping CLI execution, not multi-threaded DB work
- touched-session rebuild and legacy summary generation are still serialized

### Legacy summary generation

After enrichment refresh, the daemon runs `generateSummariesOnce()` from
`src/summary/loop.ts`.

Current behavior:

- selects up to `50` sessions per idle cycle
- generates deterministic summary text one session at a time
- updates `sessions.summary` and `summary_version`

The code still contains the older LLM path, but the active loop currently uses
the deterministic builder only.

## Sync Execution

Sync execution lives in `src/sync/loop.ts`.

The server currently starts two loop instances:

- core sync loop
  - syncs sessions and the default session-linked / non-session tables
  - uses the default cadence from `src/sync/loop.ts`
- OTel sync loop
  - dedicated to OTel session tables
  - does not sync session rows
  - uses a slower idle interval, separate watermarks, and tighter session
    budgets

This split already acts like coarse work partitioning: large OTel backlog is
kept away from the core session transport path.

### Per-loop behavior

Each sync loop instance:

- allows only one in-flight tick at a time
- iterates targets sequentially
- runs three phases per target

Per-target phases:

1. sync session rows
2. sync session-linked dependent rows for confirmed sessions
3. sync non-session tables

Inside those phases, the code is also serial:

- sessions are posted in batches, sequentially
- pending confirmed sessions are advanced one session at a time
- session tables are advanced one table at a time
- non-session tables are advanced one table at a time

Important invariants today:

- `target_session_sync` is the coordination table for confirmed sessions
- per-table watermarks only advance after the relevant POSTs succeed
- `synced_seq` only advances when a session is fully drained in the relevant
  mode
- the OTel loop is intentionally isolated from core loop watermarks and
  confirmation state

Any future workpool has to preserve those invariants.

## Prune Execution

Prune is currently the simplest runtime task:

- runs once on startup
- runs every hour after that
- shares the daemon process with all other work

It is timer-driven, not queue-driven, and currently has no separate
prioritization or backpressure model.

## What Is Safely Serialized Today

The current design buys a few useful properties:

- one scanner tick cannot overlap another scanner tick
- one sync loop tick cannot overlap another tick for the same loop instance
- sync does not start before scanner readiness
- per-file scanner writes happen inside a single DB transaction
- summary enrichment rows are claimed before execution
- session-linked sync progress is explicit in watermarks and `synced_seq`

This is why the daemon is relatively easy to reason about today, even though it
is not yet throughput-optimized.

## Where The Runtime Bottlenecks Are

The most obvious bottlenecks today are:

- scanner file discovery and parse are serial
- scanner touched-session rebuild is serial
- summary runner invocation blocks the event loop
- sync target execution is serial
- confirmed-session advancement within sync is serial
- non-session table sync is serial

There is also a structural limitation behind all of that:

- several hot paths use synchronous file IO, synchronous DB access, and
  synchronous child-process execution

So the runtime is not just "single worker by choice." In several places it is
single worker because the implementation style is fundamentally blocking.

## Near-Term Follow-Up: Bounded Workpooling

The next daemon-runtime tranche should add bounded workpooling, not unbounded
parallelism.

The design target should be:

- higher throughput
- explicit backpressure
- preserved session/watermark invariants
- predictable resource use
- debuggable queue state

### Principles

1. Prefer queues plus bounded worker counts over ad hoc parallel loops.
2. Preserve per-session ordering whenever later stages depend on it.
3. Do not let multiple workers race arbitrary SQLite writes.
4. Make concurrency configurable and easy to turn down to `1`.
5. Add observability before tuning: queue depth, in-flight workers, wait time,
   and per-phase latency.

### Recommended rollout order

#### 1. Summary enrichment workpool

This is the lowest-risk first step.

Why:

- work units already exist as claimed enrichment rows
- concurrency can be bounded tightly
- the work is expensive and latency-dominated
- failures already have explicit state (`failure_count`, `last_error`,
  `last_attempted_at_ms`)

Needed change:

- move runner invocation off synchronous child-process calls on the main event
  loop
- run claimed rows through a bounded pool with per-runner concurrency caps

#### 2. Touched-session rebuild pool

After a scan, the daemon already has an explicit set of touched session IDs.

That makes this the next clean workpool boundary:

- queue work per touched session
- run a bounded number of session rebuild workers
- keep each session's claim/reconcile/projection chain ordered within the
  worker
- run `linkSubagentSessions()` only after the pool drains

This is likely the highest-value throughput improvement in the scanner path.

#### 3. Sync target/session workpool

The sync loop should eventually support limited concurrency in two places:

- across targets
- within a target's confirmed-session advancement

Guardrails:

- keep per-session watermark ownership explicit
- do not reorder writes in a way that breaks `synced_seq` semantics
- keep core and OTel loops independently budgeted

The existing core-vs-OTel split should remain even if finer-grained pooling is
added later.

#### 4. Scanner file parse / archive workpool

This should come after profiling, not before.

The current file path mixes:

- file-system reads
- parser work
- DB writes
- archive writes

If profiling still shows file handling as the dominant bottleneck after the
touched-session pool exists, the safer shape is:

- bounded file parse/archive workers
- explicit commit boundary for DB writes
- session-affinity or write serialization where needed

This is the part most likely to require the most design care because it touches
both parser behavior and DB consistency.

### Shared scheduler/backpressure work

The daemon will also need cross-cutting runtime controls once multiple pools
exist:

- global visibility into active reparse / rebuild / sync / enrichment work
- queue depth reporting in logs or status surfaces
- refusal or deferral rules for expensive work during full reparse/rebuild
- clear worker-count and budget configuration

## Non-Goals For The First Workpooling Pass

The first pass should not try to do all of the following at once:

- rewrite the daemon into a distributed job system
- add unbounded parallel file parsing
- run arbitrary concurrent SQLite writers without ownership rules
- overlap full reparse with normal incremental scanning and sync
- promise strict speedups before queue instrumentation lands

## Practical Guidance

If a near-term runtime change only adds `Promise.all()` around existing
synchronous file, DB, or subprocess work, it is unlikely to produce the
intended throughput improvement.

The useful unit of work here is not "make things concurrent" in the abstract.
It is:

- identify a queueable work boundary
- define the ownership/invariant for that boundary
- run it through a bounded pool
- measure the queue and worker behavior

That is the right shape for the daemon's next concurrency/workpooling tranche.
