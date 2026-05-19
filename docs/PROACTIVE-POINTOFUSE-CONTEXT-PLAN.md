# Proactive Point-of-Use Context — Plan

## Motivation

External feedback: OpenWolf is perceived as delivering a great experience because
it surfaces "what happened here before" **proactively, at the moment of the
edit**, with confident prose and a visibly growing memory. Panopticon has
strictly richer, provenanced data (real intents, real edits, edit lifecycle:
`landed` / `superseded` / `reverted` / `open`) but it is **pull-only** — people
and agents forget to consult it, so the better data loses.

The OpenWolf experience is constructed from four levers, none of which require
the underlying data to be accurate:

1. **Point-of-use surfacing** — fires as the edit happens, unprompted.
2. **Confident, engineer-register prose** — reads like a postmortem.
3. **Visible accumulation** — a memory that visibly grows builds trust.
4. **Borrowed credit** — the model's own competence gets attributed to the tool.

OpenWolf pays for this with fabrication: its "bug detection" infers
`root_cause` / `fix` from a regex over a diff and stores the guess as fact in a
mutable, self-consumed store. The failure mode is "confidently wrong memory
that edits itself into the next decision," and it is structurally
unobservable to the user.

## Goal

Reproduce levers 1–3 backed by Panopticon's **true, provenanced** data, so the
result is the strictly-dominant position: OpenWolf's experience, accurate data,
plus a confidence signal OpenWolf cannot fake ("this fix was reverted").

## Guiding constraint

**Proactive + noisy = trained out.** A point-of-use channel that is wrong often
enough teaches the reader to skip it, at which point we have lost the exact
advantage the feedback credited OpenWolf with. Therefore every phase past
Phase 0 is gated on a precision floor that is enforced by the eval.

The differentiator to preserve at all costs: every surfaced clause is anchored
to a stored record, and the edit-lifecycle verb (`landed` / `reverted` /
`open`) is always rendered. That honesty asymmetry is why the channel earns
trust over time instead of eroding it.

## Phases

### Design fact: first-prompt injection is disabled

UserPromptSubmit context injection is **off for the session's first prompt by
design**. A vague opener only matches ambient repo vocabulary, and SessionStart
history injection already covers session entry. Only mid-session prompts
inject. Enforced at the call site in `src/hooks/ingest.ts` (skip when
`isFirstUserPromptSubmit`). Consequence: the eval's FIRST set is a pure
*silence* assertion, and the precision gate only governs the LATER
(mid-session) path. The `is_first_user_prompt_submit` plumbing and the
`minMatchCount: isFirstPrompt ? undefined : 3` branch in `session-context.ts`
are now vestigial — flagged for Phase 0 cleanup.

### Phase 0 — Lock the LATER precision gate (gate; do first)

A file-scoped injector fires far more often than the prompt-scoped one and
amplifies whatever precision the retrieval layer has. The amplifier must not
ship on a leaky base.

Baseline (`feat/proactive-pointofuse-context`, full local DB):

- FIRST (17): now fully silent by design — assert `with_context=0`.
- LATER (25): `with_context=11`, `useful_hits=14/17`, `avg_context_score=0.96`,
  usefulness high=4 / medium=5 / low=2 / none=0. The only tail is 2
  weak-overlap `low` cases (`later #10`, `later #19`) off one weak link.

Work:

- Make the FIRST eval set assert silence; remove vestigial first-prompt
  branches in `session-context.ts`.
- Add a real pass/fail gate to `scripts/eval-userprompt-context.ts` (today it
  only `exitCode=1` on a crash, `:401`). LATER policy: **zero
  `none`-but-context**, and a hard cap on weak-overlap `low` (baseline = 2).
- Re-run `pnpm eval:userprompt` to confirm green at the locked floor.

**Files:** `scripts/eval-userprompt-context.ts`, `src/hooks/ingest.ts`,
`src/hooks/session-context.ts`, `src/session_summaries/query.ts`.

**Done when:** FIRST asserts silence; LATER green at an enforced precision
floor with zero unexplained false positives; eval exits non-zero on
regression.

### Phase 1 — File-scoped PreToolUse injector (core)

- New builder `buildPreToolUseFileContext(data)` in
  `src/hooks/session-context.ts`, mirroring `buildUserPromptSubmitLocalContext`.
- Dispatch case for `PreToolUse` where `tool_name ∈ {Write, Edit, MultiEdit}`;
  target path from `tool_input.file_path`. `PreToolUse` is already registered
  in `hooks.json` → no manifest change.
- Retrieval: existing `fileOverview({ file_path, … })` (`query.ts:1053`,
  already fuses `whyCode` + `recentWorkOnPath`). No new query code.
- **Precision gate:** emit only with real provenance (a linked intent and/or
  recent edits with a meaningful lifecycle signal). No rows → return `null`
  early (also the perf fast-path).
- **Anti-nag:** dedupe per-file-per-session via existing session state so
  iterative edits to one file fire once, not every write.
- Config: `enablePreToolUseFileContextInjection` (default on, `envBool`
  pattern, independently disableable).

**Done when:** editing a file with history surfaces a terse note once; a file
with no history is silent; toggle works; unit tests cover gate + dedupe.

### Phase 2 — Engineer-register rendering

- Formatter collapsing `FileOverviewResult` into 1–3 confident clauses anchored
  to records, not a table.
- Always render the provenance verb (`landed` / `reverted` / `open`) — the line
  OpenWolf cannot write.

**Files:** `src/session_summaries/preview.ts` (or sibling), reused by Phase 1.

### Phase 3 — Visible accumulation

- One honest "accruing memory" line in the SessionStart injection / `status`:
  true counts of provenanced knowledge for the repo (sessions, paths with
  reverted-fix history, prior intents on likely files). No invented entries.

**Files:** `src/hooks/session-context.ts`, `src/mcp/server.ts` (`status`).

## Sequencing & risks

- Order: 0 → 1 → 2 → 3. Phase 1 is shippable with raw formatting; 2 and 3 are
  independent polish once 1 is behind the gate.
- **Top risk:** `PreToolUse` fires on every write — volume / perf / noise.
  Mitigated by the early-null gate, per-file-per-session dedupe, and a hard
  char cap reusing the existing `*_MAX_CHARS` discipline.
- **Eval coverage gap:** the harness is prompt-scoped; Phase 1 needs a small
  file-scoped corpus (path → expected surface/silent) added in Phase 0/1 so the
  precision gate covers the new surface.
