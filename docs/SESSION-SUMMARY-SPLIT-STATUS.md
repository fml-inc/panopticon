# Session Summary Split Status

This document records the final state of the session-summary split after the
split PR sequence merged. It remains useful as historical context and as a
pointer to the next follow-up tranche, but it is no longer an active handoff
document.

## Current State

As of April 25, 2026:

- `origin/main` is at `a2cad38`
- the split sequence is merged:
  - PR `#190` added projection-backed session summary reads
  - PR `#191` added session summary enrichment runtime
  - PR `#192` relaxed Gemini scanner transcript discovery
  - PR `#193` added persisted retry/backoff for sync and summary refresh
- new work should branch from `main`, not from the old split branches

## Historical Branches

These branches remain useful only as reference context:

- `origin/gus/session-summary-enrichment` at `714a32c`
  - the original pre-split branch
- `origin/pr-193` at `a9379a6`
  - the GitHub PR ref used during review
- `origin/split/pr3-attempt-backoff` at `e74784f`
  - the final split branch merged via PR `#193`

## What To Use On Another Machine

Use `main`:

```bash
git fetch origin --prune
git switch main
git pull --ff-only
```

## Next Planned Tranche

The next follow-up tranche after the merge is the synthetic/E2E harness work:

- synthetic collector integration coverage for sync backoff and recovery
- runner-availability and auth integration coverage for summary enrichment

That work should start from `main`.

## Practical Rule

Treat GitHub `main` as the source of truth for the session-summary split.
Historical split branches are reference-only.
