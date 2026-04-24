# Session Summary Split Handoff

This document exists so the session-summary split can be resumed from another
machine without depending on local-only notes, worktrees, or branch state.

## Current State

- `origin/main` is at `721729b`
  - includes merged PR `#190` (`Add projection-backed session summary read model`)
  - includes merged PR `#191` (`Add session summary enrichment runtime`)
  - includes merged PR `#192` (`Relax Gemini scanner transcript discovery`)
- the next open tranche is PR `#193`
  - branch: `origin/split/pr3-attempt-backoff`
  - head: `fc929c8`
  - URL: <https://github.com/fml-inc/panopticon/pull/193>

## Remote Branches That Matter

### Historical Large Branch

- `origin/gus/session-summary-enrichment` at `714a32c`
- this is the original large branch before the split
- keep it only as historical/reference context, not as the branch to continue

### Split Branches

1. `origin/split/pr1-session-summary-projections` at `f10c1c7`
   - PR `#190`
   - deterministic projection-backed summaries only

2. `origin/split/pr2-session-summary-enrichment` at `1e7ad0f`
   - PR `#191`
   - additive LLM enrichment overlay/runtime

3. `origin/split/pr3-attempt-backoff` at `fc929c8`
   - PR `#193`
   - persisted retry/backoff for sync and summary refresh

### Related Side Fix

- `origin/fix/gemini-e2e-scanner` at `4f6e0e8`
- this was the Gemini transcript-path follow-up that became PR `#192`

## What To Use On Another Machine

If PR `#193` is still open:

```bash
git fetch origin --prune
git switch split/pr3-attempt-backoff
```

If PR `#193` has merged already:

```bash
git fetch origin --prune
git switch main
git pull --ff-only
```

## Next Planned Tranche

After PR `#193`, the remaining split is the synthetic/E2E harness tranche:

- synthetic collector integration coverage for sync backoff/recovery
- runner-availability/auth integration coverage for summary enrichment

That work should start from `main` after PR `#193` merges, not from the old
large branch.

## Local-Only Artifacts On The Original Machine

These existed locally on the source machine but are not required to continue:

- `notes/session-summary-pr-split-resume.md`
  - this document supersedes it
- local worktrees under `.worktrees/`
- local temp file `$tmp`
- a stash on `gus/structured-messages`
  - unrelated to the session-summary split
- intermediate local-only branches such as:
  - `work/pr2-summary-staleness-fix`
  - `pr-187-push`
  - other review/worktree branches created during the split

None of those are required to continue the split safely.

## Practical Rule

Treat GitHub as the source of truth for this split:

- merged state lives on `main`
- current in-flight state lives on `origin/split/pr3-attempt-backoff`
- the old large branch is reference-only

There is no essential session-summary split code that remains trapped only on
the original machine after this document is committed.
