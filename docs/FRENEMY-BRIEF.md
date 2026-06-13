# Frenemy — real-time agent-to-agent comms on Panopticon

## Context

Panopticon is a headless observability layer for AI coding tools: five pipelines
(hooks, OTel logs/metrics, session-file scanner, API proxy) feed one SQLite DB,
queryable via MCP. Today two concurrent agent sessions can only *passively*
observe each other through the shared DB + hook-time context injection. There is
no way for them to **talk directly**.

This build adds a real-time **agent-to-agent comms channel ("the bus")** brokered
by the existing Panopticon server, then lands the headline use case on top:

**Frenemy** — a *real second agent session* (model configurable: Claude/Codex,
same- or cross-vendor) launched via the existing `/panopticon` surface
(`panopticon frenemy`) that runs alongside one or more "primary" agents in the
same workspace, watches their moves, and posts adversarial challenges. Primaries
hear them via Panopticon's existing `additionalContext` injection at their next
tool/prompt hook. Demo goal: primary attempts a questionable edit → frenemy
challenges it → primary reconsiders, live.

**Rooms are implicit and workspace-scoped.** No tokens to type — a room is derived
from the workspace/worktree/cwd, so every agent in the same coding activity
(people routinely run several sessions at once) automatically shares one room.

**Presence is tracked per agent.** Panopticon records each agent session's PID +
heartbeat so the bus knows who is active / idle / exited — the frenemy only
challenges live primaries, and it powers a future roster/Mission-Control view.

**Sidequest** (parallel sessions coordinating non-colliding edits into separate
PRs) reuses the same bus and is an explicit **stretch goal**, not in scope for v1.

### Why this is feasible
- Server is raw Node `http` on :4318 — trivial to add behavior; dispatch already
  abstracted through `src/service/` (`transport.ts` → `direct.ts`/`http.ts`).
- MCP is a read-only stdio subprocess → writes must round-trip through the HTTP
  exec dispatch (the established `permissions_apply` pattern).
- Delivery into a running agent is **turn-/tool-paced** (no idle nudge hook).
  `PreToolUse` fires before every tool action — the perfect interception point.
  Delivery is therefore **eventual**: a challenge lands at the primary's *next*
  hook round-trip (1–3s on stage). Confirmed acceptable; synchronous hold is out.

## Execution — one PR per layer

Land incrementally; each PR is independently shippable. Layers 0+1 are squash-
merged into the running base branch `layer0-instance-presence` (PR #275 → `main`).

1. **Layer 0 — generic instance presence + reaper.** ✅ landed. Table, PID capture,
   reaper, `instances` tool + CLI. (#275)
2. **Layer 1 — the bus primitive.** ✅ landed (merged into base). `agent_messages`,
   dispatch, `bus_*` tools, implicit repo rooms, zero-arg self-identification
   (`~/.claude/sessions/<ppid>.json`). (#276)
3. **Layer 2 — challenge delivery into hooks.** ✅ open (#277). Drain pending
   `challenge` messages into `PreToolUse`/`UserPromptSubmit` `additionalContext`
   (advisory inject), consume-once, frenemy-role exclusion. **No agent-activity
   republishing** — the frenemy observes via existing capture (`hook_timeline`)
   with `last_seen_ms` as the freshness hint; the only net-new activity source
   (human/fs edits) is a follow-up fs-watch PR.
4. **Layer 3 — conversation & deliberation.** See the rewritten Layer 3 below.
   Two interaction models on the same bus, plus the persistent-delegate end-state.

Sidequest (claims projection + skill) is a later PR on the same primitives.

## Implementation

### Layer 0 — generic instance presence & liveness (panopticon-wide)

This is a **first-class, always-on panopticon subsystem**, not a frenemy detail:
the server should know every instance currently connected to it — any session of
any target (claude/codex/gemini/pi), plus the frenemy as just one role. The bus
and frenemy *consume* this; it stands on its own as observability.

**Key correctness point:** a heartbeat upserted on activity **cannot tell "idle/
thinking" from "killed"** — both just stop updating. So liveness is detected by
**active OS-level probing**, not heartbeat decay. We capture each instance's PID
and the server actively reaps dead PIDs on an interval.

**1. Table** `panopticon_instances` (in SCHEMA_SQL + migration id 25):
```sql
CREATE TABLE IF NOT EXISTS panopticon_instances (
  session_id TEXT PRIMARY KEY,
  target TEXT,                      -- claude | codex | gemini | pi
  role TEXT,                        -- generic; 'frenemy' when marked, else NULL/'agent'
  pid INTEGER,                      -- agent process pid (hook-handler process.ppid)
  pid_start_hint TEXT,              -- best-effort process start stamp to guard PID reuse
  room TEXT,                        -- resolved workspace-superset room (Layer 1 §3)
  worktree TEXT,                    -- git worktree root (sidequest isolation metadata)
  branch TEXT,                      -- current branch (which PR this work lands in)
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,    -- heartbeat: drives active-vs-idle ONLY
  ended_at_ms INTEGER,             -- set by SessionEnd OR by the reaper on dead PID
  ended_reason TEXT                -- 'session_end' | 'pid_dead' | NULL
);
```

**2. Capture** — `src/hooks/handler.ts` forwards the agent PID (`process.ppid` —
the handler is a child of the agent) with every hook event; `src/hooks/ingest.ts`
`upsertInstance({session_id, target, pid, workspace, last_seen_ms})` on every
event, and sets `ended_at_ms`/`ended_reason='session_end'` on `SessionEnd`.

**3. Reaper loop** — new `src/presence/reaper.ts`, started in the server bootstrap
on the same `start/stop` Handle pattern as scanner/sync. Every ~5–10s it scans
instances with `ended_at_ms IS NULL` and probes `process.kill(pid, 0)` (the proven
start-lock liveness check); on `ESRCH` it marks `ended_at_ms=now,
ended_reason='pid_dead'`. **This is what catches kills / crashes / closed
terminals that never fire SessionEnd.** PID-reuse guard: compare a stored
`pid_start_hint` (best-effort; acceptable residual risk for a local single-host
dev tool — note it). Same-host/same-uid only, which matches panopticon's model.
**Forward hook for sidequest:** when the reaper marks an instance `exited`, it must
also expire that instance's open claims/leases (Layer 1 claims projection) so a
killed sidequest never holds a path forever — presence directly powers lease expiry.

**4. Status** (derived at read): `active` (last_seen < ~30s, not ended), `idle`
(not ended, stale last_seen, PID still alive), `exited` (`ended_at_ms` set). A
generic `instances` MCP tool + `panopticon instances` CLI expose the roster; the
bus `bus_roster` (Layer 1) is a thin room-scoped view over this same table.

### Layer 1 — the bus primitive

**1. Table** (`src/db/schema.ts` SCHEMA_SQL **and** new migration `id: 25` in
`src/db/migrations.ts` — mirror existing migration `id: 24`; table must be in both
so fresh DBs stamp it and existing DBs upgrade):

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  from_session TEXT NOT NULL,
  to_session TEXT,                  -- NULL = broadcast to room
  kind TEXT NOT NULL,              -- open-ended: challenge|activity|claim|release|handoff|chat
  body TEXT NOT NULL,
  subject TEXT,                    -- generic scope: 'path:src/auth.ts'|'glob:src/api/**'|'initiative:logging'
  ref_tool TEXT, ref_path TEXT, source TEXT, -- hook context (tool/path) + 'hook'|'fs' origin
  created_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER          -- NULL until drained (consume-once kinds only)
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_room ON agent_messages(room, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_agent_messages_drain ON agent_messages(to_session, delivered_at_ms);
CREATE INDEX IF NOT EXISTS idx_agent_messages_subject ON agent_messages(room, kind, subject);
```
This single append-only log carries **both** ephemeral events (challenge/activity,
consume-once via `delivered_at_ms`) **and** the source events for durable state
(claim/release → the claims projection, Sidequest readiness below). `kind` is plain
TEXT so new message types never need a migration.

**2. DB helpers** — new `src/db/bus.ts`: `insertAgentMessage`, `readAgentMessages`,
`markDelivered`, plus `readRoster(room)` (a room-scoped read over Layer 0's
`panopticon_instances`, with derived status). Model the insert+transaction shape
on `insertHookEvent` in `src/db/store.ts`. Presence capture/upsert lives in Layer 0.

**3. Implicit workspace-superset room** — new `src/bus/room.ts`
`resolveRoom(sessionId)`: no token. The room is the **workspace superset
(repo-level), NOT the worktree** — derive via `src/workspaces/superset.ts` +
`resolveRepoFromCwd`, e.g. `repo:<canonical-repo>`. This is the key sidequest-proofing
decision: agents in *different worktrees of the same repo* (separate branches →
separate PRs) still share one room and can coordinate, while their distinct
worktree/branch live on the instance row (Layer 0), not in the room key. Store the
resolved room on each message/instance row so reads never re-derive.

**4. Dispatch wiring** (reuse existing service abstraction — gets auth + the
rebuild-gate for free, no bespoke routes):
- `src/service/types.ts`: add `busSend`/`busRead`/`busRoster` to `PanopticonService`.
- `src/service/direct.ts`: implement them against `src/db/bus.ts`.
- `src/service/http.ts`: `busSend` → `callExec("bus-send", …)`, `busRead`/`busRoster` → `callTool(…)`.
- `src/service/transport.ts`: register `bus_read` + `bus_roster` in `TOOL_HANDLERS`
  (read) and `bus-send` in `EXEC_HANDLERS` (write). **Do not** add the read tools to
  `TOOLS_REQUIRING_DERIVED_STATE` (`src/api/routes.ts`) — they're raw, must stay
  available during rebuilds (else 503 mid-demo).

**5. MCP tools** (`src/mcp/server.ts`): `bus_send({ to?, body, kind?, ref_path? })`,
`bus_read({ since?, kinds? })`, `bus_roster({})` (who's in my room + status) —
room is implicit, resolved server-side from the calling session. Match the
`server.tool(name, desc, zodSchema, handler)` pattern; add all to the always-allow set.

**6. Feature flag** (`src/config.ts`, mirror `enablePreToolUseFileContextInjection`
at line 212): `enableBusDelivery` ← `PANOPTICON_ENABLE_BUS_DELIVERY` (default 0).
Layer 0 presence is **independent of this flag** — always on.

### Layer 2 — wiring the bus into hooks (`src/hooks/ingest.ts`)

Bus auto-publish/drain below are gated by `config.enableBusDelivery`, each wrapped
in try/catch (must never break hook ingest), reusing the implicit
`resolveRoom(sessionId)` (Layer 1 §3). (Presence `upsertInstance` + the reaper are
Layer 0 — always on, independent of the flag.)

- **Auto-publish activity (agent source)** — add `maybePublishActivity(...)` after
  the session upsert (~line 642). Publish on three events only:
  - `PreToolUse` for `Edit`/`Write`/`MultiEdit`/`Bash` → body "about to {tool} {path}",
    `ref_tool`/`ref_path` set (reuse `extractWrittenFilePath`, line 811).
  - `UserPromptSubmit` → prompt text.
  - `Stop` → "turn ended".
- **Auto-publish activity (filesystem source)** — new `src/bus/watch.ts`: a
  bus-scoped fs watcher so the frenemy also reacts to **human** edits made
  alongside the agent (the hook stream only sees the *agent's* actions). Started
  per active room for the room's repo root (room→cwd via `resolveRoom` /
  `getPrimarySessionCwd`); started/stopped on the scanner/sync `start/stop` Handle
  pattern, wired into the server bootstrap. On change: publish `kind='activity'`,
  `source='fs'`, `ref_path`, body "file {path} changed on disk". Debounce (~300ms),
  ignore `.git`/`node_modules`/`dist`/`.code-review-graph`, and suppress events
  that match an agent-published edit to the same path within a short window (the
  agent's own writes already publish via the hook source — avoid double-firing).
  Prefer `chokidar` if already a dep; else node `fs.watch` recursive (populates the
  `source` column added in Layer 1 §1).
- **Drain coordination context into `additionalContext`** — a generic
  `buildCoordinationContext(sessionId, event, data)` step in the `PreToolUse`
  permission branch (alongside file-context injection, ~line 677, compose via the
  existing `mergePreToolUseContext`) and the `UserPromptSubmit` branch (~line 722).
  Structure it as a small set of **context providers** over the bus so it isn't
  frenemy-specific:
  - *Frenemy challenges* (v1): `kind='challenge'`, room-scoped, `(to_session IS NULL
    OR to_session=sessionId)`, `delivered_at_ms IS NULL`, oldest-first, take ≤3,
    format "🔴 Frenemy challenge: …", `markDelivered` in the **same** query path
    (consume-once dedup — else it re-injects every PreToolUse).
  - *Claim conflicts* (sidequest, later): for a PreToolUse edit, look up the claims
    projection for the target `ref_path`; if another live instance holds it, inject
    "⚠️ claimed by {session} ({initiative})". This is **state-derived, not
    consume-once** — dedup per session/path with the existing `emitOncePerSessionPath`
    util instead of `delivered_at_ms`. Slots into the same provider list with zero
    seam changes.

**Critical guard (build first — top demo-breaker):** the frenemy is itself a real
session whose hooks flow through `processHookEvent`. Exclude frenemy sessions from
both publish and drain. Tag the frenemy session (launch with
`PANOPTICON_FRENEMY_ROLE=frenemy` and/or register its session id in the room) and
skip auto-publish for it; never publish activity for `bus_*` MCP tool calls
(reuse the `isPanopticonMcpTool` check, ~line 139).

### Layer 3 — conversation & deliberation

The Layer 2 PR delivers **one-way advisory nudges** into a working agent. Real
back-and-forth (two agents weighing pros/cons to a recommendation) needs more,
and the design hinges on a few hard truths established in discussion:

- **Agents are turn-takers, not event listeners.** Nothing can inject into an
  *idle* agent. The only things that wake a session are its own hooks or an
  external re-prompt. So every "listener" needs a **driver** that re-invokes it.
- **A single session can't work and converse at once** (single-threaded per turn).
  So a conversational participant running *alongside* real work is necessarily a
  **separate brain — a "delegate"** — that represents the working agent by
  observing its captured activity (`hook_timeline`, edits, plans), not by sharing
  its live private reasoning. Useful, but lossy on "why I *really* chose X."
- **The primary receives via hooks** (Layer 2); the **observer/participant
  receives by polling** (`bus_read`). Different mechanisms per role.

Three mechanisms, same bus, picked per use case:

**3a. Ambient frenemy (nudge).** A real second agent, loop-driven, that watches a
working session and fires advisory challenges. Launch via the existing
`/panopticon` surface: `panopticon frenemy` CLI spawns a `claude` (model/vendor
configurable) running `/loop /panopticon frenemy` with `PANOPTICON_FRENEMY_ROLE=
frenemy` (presence + Layer 2 exclusion). The loop: `bus_roster()` → `hook_timeline`
of live primaries since a cursor (NOT a republished activity feed) → judge → `bus_
send({kind:'challenge'})`. Persona rubric in `skills/panopticon/references/`. This
is the simplest sibling and the live-demo headliner.

**3b. Bounded deliberation (debate → recommendation).** Best built as a **Workflow**,
NOT bus + external driver: turns = sequential `await`s (no baton/deadlock); the
harness's await/notify *is* the turn-taking + wake mechanism, for free. Triggered
from a working session (`/panopticon debate "<decision>"`); the verdict is handed
back inline or **injected into the working session via the Layer 2 hook channel**.
Workflow debaters are ephemeral subagents — ideal for "debate this decision," not
for two persistent independent sessions.

**Protocol (evidence-backed — deep-research 2026, 24/25 claims verified):**
- **Three phases (CollabEval-style):** (1) each debater forms an *independent*
  position first, hidden, to cut anchoring; (2) discussion via sequential addressed
  hand-off; (3) a separate **judge agent extracts the recommendation**.
- **Termination = small fixed round cap (~3) + adaptive early-stop on genuine
  concession.** ~3 rounds captures most of the benefit. **Do NOT use consensus
  detection or majority voting** — standard consensus-based debate *harms* results
  and majority pressure makes agents abandon correct minority positions
  (sycophancy observed to 85.5%). The judge decides, not a vote.
- **Anti-groupthink, in priority order (diversity dominates turn-order):**
  (1) **different models/vendors** — the single biggest lever; homogeneous groups
  converge to shared bias; (2) fixed **adversarial roles** (critic/defender);
  (3) an explicit **"hunt for flaws, don't just agree" anti-conformity instruction**.
- **Cost:** naive debate is 2.1–3.4× tokens — another reason for the round cap +
  early-stop. Sources: AutoGen GroupChat (arXiv 2308.08155), conformity/diversity
  (2509.11035, 2511.07784), anti-consensus (2509.23055).

**3c. Parallel delegate (converse alongside the work).** A background Workflow that
holds a long-polled conversation **while the primary keeps coding** — the delegate
is a separate brain (per 3-truths above) that observes the primary via capture and
speaks for it. Requires a **server-side long-poll `bus_read`** (hold the connection
up to ~25s until a message or timeout) so the delegate waits cheaply instead of
burning a model call per poll (workflow scripts can't sleep/poll — no timers,
`Date.now` banned). Loop: long-poll-read → compose reply from thread + observed
activity → `bus_send`. Verdict/outcome injected back via Layer 2. Fits **bounded**
conversations.

**Recruitment beacon (supporting mechanism).** A Layer 2 provider that injects an
*invitation* ("decision Y is open in your room — `/panopticon debate join`") to
*active* agents at their hook cadence. Discovery/opt-in only — **inform, not
command** (commanding a busy agent to join is prompt-injection into someone else's
task). Beacon = who's-around; orchestrator/delegate = the actual conversation.

### Layer 3 end-state — the immortal delegate (the real goal)

The bounded mechanisms above are stepping stones. The end-state is a **persistent
delegate that lurks in every chat indefinitely**, representing its agent in the
workspace conversation. Workflows **cannot** be this (they complete-and-notify;
agent/wall-clock caps). It belongs in the **long-lived panopticon daemon** as a
managed delegate loop:

- **Lifecycle tied to Layer 0 presence.** When an agent session goes live
  (`SessionStart` → instance row), the daemon spawns its delegate; when the reaper
  marks the instance `exited`, the daemon tears the delegate down. Presence becomes
  the delegate supervisor — Layer 0 pays off again.
- **One delegate per active agent (or per room).** It long-polls the bus, converses
  on its principal's behalf (observing via capture), and reaches into the
  principal's live session via Layer 2 injection when something needs the human-
  driven agent's attention.
- Net: every agent in a workspace gets a persistent representative — a "society of
  agents" that can deliberate continuously without ever blocking the real work. The
  delegate's brain can be a cheap/contrasting model.
- Open questions for this stage: cost/rate-limiting of always-on delegates, turn
  arbitration across many delegates in one room, and how much of the principal's
  private reasoning the delegate may speak for (it fundamentally cannot share it).

**Pending input:** the deep-research report (turn-taking / termination / anti-
groupthink protocol) refines 3b/3c and the delegate's debate discipline before
those are built.

## Critical files
- **Layer 0 (presence):** `src/hooks/handler.ts` (forward agent PID `process.ppid`),
  `src/hooks/ingest.ts` (`upsertInstance` heartbeat + SessionEnd), new
  `src/presence/reaper.ts` (PID-probe loop, wired into server bootstrap on the
  `start/stop` Handle pattern), `instances` MCP tool + `panopticon instances` CLI
- `src/hooks/ingest.ts` — bus auto-publish (~L642) + drain (~L677 PreToolUse, ~L722 UserPromptSubmit)
- `src/db/schema.ts` + `src/db/migrations.ts` (id 25: `agent_messages` + `panopticon_instances`) + new `src/db/bus.ts`
- `src/service/{types,direct,http,transport}.ts` — bus + roster dispatch
- `src/mcp/server.ts` — `bus_send`/`bus_read`/`bus_roster` (+ `instances`) tools + always-allow
- `src/config.ts` — `enableBusDelivery` flag; new `src/bus/room.ts` (implicit workspace room)
- new `src/bus/watch.ts` — per-room fs watcher (human-edit activity source), wired into server bootstrap on the `start/stop` Handle pattern
- `src/cli.ts` (`panopticon frenemy` subcommand) + `skills/panopticon/references/frenemy.md` (+ `frenemy-persona.md`) — kickoff + coordination on the existing `/panopticon` surface

## Verification (end-to-end demo)
```
# Terminal 0 — server
export PANOPTICON_ENABLE_BUS_DELIVERY=1 && panopticon start --force
# Terminal 1 — PRIMARY (real agent), normal work in the repo
cd <repo> && claude
# Terminal 2 — FRENEMY (real second agent, same workspace → same implicit room)
cd <repo> && panopticon frenemy            # or: claude → /panopticon frenemy
```
1. Primary: "delete the flaky test in auth.test.ts so CI passes."
2. Primary PreToolUse(Edit) → auto-published as `activity` (source=hook) on the workspace room.
3. Frenemy loop `bus_roster()` (sees primary live) + `bus_read()`, then `bus_send`s
   a `challenge` ("deleting masks the flake instead of fixing it — root cause?").
4. Primary's next tool/prompt hook drains the challenge into `additionalContext`;
   primary visibly reconsiders.
5. **fs-watch beat:** hand-edit a file in the repo (no agent) → fs watcher publishes
   `activity` (source=fs) → frenemy challenges the human edit too.
6. **presence beat (the kill-detection proof):** `SIGKILL` the primary (or just
   close its terminal — no clean SessionEnd fires) → within one reaper interval
   `bus_roster()` / `panopticon instances` flips it to `exited (pid_dead)`. Contrast
   with an idle-but-alive agent, which shows `idle`, not `exited`. A second primary
   in the same worktree shares the room automatically.

Also: unit-test `src/presence` (reaper marks `pid_dead` when `process.kill` throws;
heartbeat staleness → `idle` not `exited`) and `src/db/bus.ts` (insert/read/
markDelivered/dedup, `readRoster` derived status) and the drain filter;
`pnpm check && pnpm typecheck && pnpm test`. Confirm `bus_read`/`bus_roster` return
during a derived-state rebuild (not in `TOOLS_REQUIRING_DERIVED_STATE`).

## Sidequest readiness (stretch — proven to fit, not built in v1)

The v1 primitives are deliberately shaped so sidequest is **additive, no rewrite**:

| Sidequest need | Already provided by v1 | What sidequest adds |
|---|---|---|
| Coordinate across separate-branch worktrees | Room = **workspace superset** (repo-level), worktree/branch on the instance row | nothing structural |
| "Who owns this path/initiative now?" | Append-only `agent_messages` with `kind` + generic `subject` | a **claims projection** over `kind in (claim,release)`, like the intent projection; `bus_claims(room)` read |
| Warn before editing a claimed file | Generic `buildCoordinationContext` provider list at PreToolUse | a claim-conflict provider (state-derived, dedup per session/path) |
| Auto-release on death | Reaper marks instance `exited` | reaper expires that instance's open claims (lease) |
| Directed handoff / peer discovery | `to_session` addressing + `bus_roster`/`instances` | `kind='handoff'`, `kind='chat'` over the same log |
| Land in separate PRs | `branch`/`worktree` per instance | per-initiative branch convention in the sidequest skill |

Conflict resolution rule (note for the projection): claims resolve by append order
(`id`/`created_at_ms`) — first claim on a `subject` wins; later ones see the
conflict. Sidequest is then just: a `panopticon sidequest` subcommand + skill that
claims a subject, works its branch, releases on done — all on these primitives.

## Roadmap (post Layer 2)
- **fs-watch PR** — per-room filesystem watcher publishing human/non-agent edits
  as the one genuinely net-new `kind:'activity'` source (hooks don't see them).
- **Server-side long-poll `bus_read`** (Layer 1 addition) — prerequisite for the
  parallel delegate (3c) and any efficient poller; holds the connection ~25s.
- **Layer 3a frenemy** — `panopticon frenemy` launcher + skill/persona (demo).
- **Layer 3b deliberation** — `/panopticon debate` as a Workflow; verdict back via L2.
- **Layer 3c + end-state delegate** — daemon-hosted persistent delegates, lifecycle
  bound to Layer 0 presence. The real goal; gated on the research + cost model.

## Out of scope (separate tracks)
- **Sidequest** itself (claims projection + skill) — primitives ready per above.
- **Mission Control UI** visualizing the live bus + roster (a parallel session is
  already building this in worktree `../panopticon-mission-control`).
```
