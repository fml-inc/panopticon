# Open Questions

A running list of unresolved design questions for panopticon. These are not yet
committed work — they capture a problem, the options we've weighed, and where our
current thinking leans, so they can be discussed and refined with others.

---

## Correlating work across users

**Status:** open · **Owner:** TBD · **Leaning:** shared entity extraction (hard)

### Problem

panopticon today is strongest at the *git-based developer* scenario. We anchor
work to a person's machine through working directories (`session_cwds` /
`getPrimarySessionCwd`) and correlate signals *within* a session via `session_id`.
That's great for "what did **this** person do, where, and what did it cost."

But a large and growing share of AI-assisted work is **not SCM-based** — research,
ops, data wrangling, writing, support, one-off scripting — and even SCM-based work
spans **multiple people**. We currently have no good way to answer:

> "Several people are working on the same thing. How do we know that, and how do we
> stitch their sessions together into one view?"

The local cwd model breaks down here: two users working on "the same thing" will
have different absolute paths, different machines, and — for non-SCM work — no
shared repo identity to join on at all.

### What we have to join on today

- `session_id` — strong, but scoped to a single session on a single machine.
- working directories (`session_cwds`) — local and per-user; not portable.
- git repo identity (remote URL) — only present for SCM work, which is exactly the
  case we're trying to move *beyond*.

### Options considered

**1. Shared entity extraction / identification** — *leading candidate; strongest; also the hardest.*
Extract durable, portable entities from each user's work — repo-relative file paths,
symbol/function names, package names, ticket/issue IDs, PR numbers, URLs, error
signatures, distinctive identifiers — and build a cross-user index keyed on those
entities. Two users touching the same entities are doing related work, regardless of
machine, path, or whether git is involved.
- *Why strongest:* it's the only option that works for **non-SCM** work and degrades
  gracefully — the more entities we can reliably extract, the better the correlation,
  but it never depends on a single shared key existing.
- *Why hardest:* entity extraction is fuzzy. It needs normalization, deduplication,
  disambiguation (the same name meaning different things in different contexts), and a
  confidence model so we don't over-link unrelated work. This is real ML/heuristics
  surface area, not a schema change.

**2. Explicit shared identifiers.**
Join on identifiers that are already shared by construction: git remote URL / repo
identity, ticket IDs, PR numbers, deploy/run IDs.
- *Pro:* cheap, exact, high-precision when present.
- *Con:* only covers SCM- or ticket-tracked work — i.e. it does **not** close the gap
  that motivated this question. Best treated as a high-confidence signal that feeds
  option 1 rather than a standalone answer.

**3. Shared-artifact / content fingerprinting.**
Fingerprint the actual content touched (files, diffs, outputs) and match identical or
near-identical artifacts across users.
- *Pro:* concrete, doesn't depend on naming conventions.
- *Con:* privacy- and volume-sensitive; near-duplicate matching is its own hard
  problem; overlaps heavily with option 1 once you're extracting entities anyway.

**4. Temporal / time-window correlation.** — *least preferred; do not pursue as a primary mechanism.*
Correlate sessions that happen in overlapping time windows.
- *Why deprioritized:* time overlap is weak evidence of *related* work — it produces
  many false positives (people doing unrelated things at the same time) and misses
  related work done asynchronously. At best a tie-breaker on top of a real signal,
  never the basis for linkage.

### Current lean

Pursue **shared entity extraction (option 1)** as the long-term direction, using
**explicit shared identifiers (option 2)** as a high-precision input into it.
Explicitly **not** building correlation on **time-based windows (option 4)**.

### Open sub-questions

- Which entity types are reliable enough to extract and normalize first? (repo-relative
  paths and ticket/PR IDs look like the highest-precision starting point.)
- Where does extraction live — at capture time (hooks) or as a derived/offline pass?
- What's the data model for a cross-user entity index, and how does it relate to the
  existing per-session schema?
- How do we represent and surface a *confidence* that two users' work is related,
  rather than a hard yes/no?
- What are the privacy / data-sharing boundaries when correlating across users (and
  potentially across machines or orgs)?

### Non-goals (for now)

- Real-time cross-user linkage.
- Pulling in external social/communication graphs (Slack threads, calendars, reviews) —
  potentially a future signal, but out of scope for the core mechanism.
