# Counterfactual Replay Eval Plan

This plan is for measuring actual token and wall-clock savings from context
injection by replaying historical sessions through multiple treatment arms.

The historical ROI eval is the broad deterministic proxy. Replay is the stricter
follow-up: it spends agent tokens, reconstructs a repository checkout at the
historical anchor, runs each arm in an isolated worktree, and judges whether the
arm accomplished the same scoped outcome.

## Scope

Replay arms:

- `none`: no Panopticon injection, no Code Review Graph prompt context.
- `panop`: Panopticon SessionStart plus UserPromptSubmit injection.
- `crg`: compact Code Review Graph prompt context only.
- `panop+crg`: Panopticon SessionStart plus UserPromptSubmit injection with
  compact Code Review Graph prompt context.

The replay harness currently disables PreToolUse read/edit injection in all
arms. That keeps replay point-in-time fair because file overview/read provenance
does not yet have a replay-safe historical view.

## Preconditions

- Run from `main` after the eval harness has merged, so artifacts correspond to
  a stable code version.
- Local Panopticon data must include the historical sessions being replayed.
- PR-backed scenarios need merge commits available in the local repository.
- The selected agent runner must be installed and authenticated.
- For `crg` and `panop+crg`, build Code Review Graph in the target repository:

```bash
code-review-graph build
code-review-graph status
```

## Valid Metric Gates

A token/time reduction is reliable only when every requested arm:

- completes successfully
- emits token metrics
- exposes the expected Panopticon injection instrumentation
- matches the exact expected PR file set for PR-backed scenarios
- is judged `accomplished`

If those gates do not pass, the run is still useful as harness/candidate
diagnostics, but it should not be reported as actual token or time savings.

## Phase 1: Candidate Fixture

Prefer PR-backed scenarios because the judge can compare each arm against a
merged PR's actual file scope. Plain historical sessions can still be replayed,
but the oracle is weaker because it is goal-equivalence only.

Use the PR scenario hydration utility when starting from PR candidate rows:

```bash
pnpm eval:hydrate-pr-scenarios -- \
  .tmp/evals/replay-counterfactual/pr-candidates.json \
  .tmp/evals/replay-counterfactual/scenarios.json
```

Keep generated fixture files under `.tmp/evals/replay-counterfactual/`.

## Phase 2: Dry-Run Selection

Run a dry plan before spending agent tokens:

```bash
pnpm eval:replay -- \
  --fixture-file .tmp/evals/replay-counterfactual/scenarios.json \
  --action-pair \
  --only-measurable \
  --candidate-label strong \
  --max-expected-files 5 \
  --arms none,panop,panop+crg \
  --limit 20 \
  --result-json .tmp/evals/replay-counterfactual/dry-run.json \
  --report-markdown .tmp/evals/replay-counterfactual/dry-run.md
```

Inspect the dry-run report before executing. Drop or tighten candidates if many
rows are filtered for weak relevance, missing prompts, missing merge parents, or
large expected PR scope.

## Phase 3: Tiny Execution Pilot

First execute one or two scenarios with only `none` and `panop`:

```bash
pnpm eval:replay -- \
  --fixture-file .tmp/evals/replay-counterfactual/scenarios.json \
  --action-pair \
  --only-measurable \
  --candidate-label strong \
  --max-expected-files 5 \
  --arms none,panop \
  --limit 2 \
  --execute \
  --result-json .tmp/evals/replay-counterfactual/pilot-none-panop.json \
  --report-markdown .tmp/evals/replay-counterfactual/pilot-none-panop.md
```

Use this pilot to verify worktree cleanup, token capture, hook instrumentation,
judge output, and strict metric readiness. Do not add more arms until the basic
two-arm replay is producing interpretable results.

## Phase 4: Diagnose Blockers

Read the report's strict readiness table and blocker counts. Common blockers:

- missing token metrics from the runner
- missing expected injection events
- agent output changed the wrong file set
- replay window selected discovery or planning prompts instead of action prompts
- judge marked one or more arms `partial` or `failed`

Fix blocker classes by improving fixture selection, replay window selection, or
instrumentation. Do not scale the run while most rows fail strict gates.

## Phase 5: Add Code Review Graph

Once `none` versus `panop` has strict-ready pairs, run the three-arm comparison:

```bash
pnpm eval:replay -- \
  --fixture-file .tmp/evals/replay-counterfactual/scenarios.json \
  --action-pair \
  --only-measurable \
  --candidate-label strong \
  --max-expected-files 5 \
  --arms none,panop,panop+crg \
  --limit 5 \
  --execute \
  --result-json .tmp/evals/replay-counterfactual/pilot-with-crg.json \
  --report-markdown .tmp/evals/replay-counterfactual/pilot-with-crg.md
```

If `panop+crg` hurts exact-scope success or judge outcomes, inspect the compact
CRG context before optimizing for token/time deltas.

## Phase 6: Scale

After the pilots show a reasonable strict-ready rate, scale to 10-20
strict-ready pairs. Use prior-result overlays to avoid rerunning completed rows:

```bash
pnpm eval:replay -- \
  --fixture-file .tmp/evals/replay-counterfactual/scenarios.json \
  --prior-result-json .tmp/evals/replay-counterfactual/pilot-with-crg.json \
  --skip-prior-strict-ready \
  --action-pair \
  --only-measurable \
  --candidate-label strong \
  --max-expected-files 5 \
  --arms none,panop,panop+crg \
  --limit 20 \
  --execute \
  --result-json .tmp/evals/replay-counterfactual/scaled-with-crg.json \
  --report-markdown .tmp/evals/replay-counterfactual/scaled-with-crg.md
```

## Reporting

Report strict token/time savings only over strict-ready pairs. Include:

- scenario count
- strict-ready pair count
- token delta and percent token savings
- wall-clock delta and percent time savings
- exact-scope success rate
- judge outcome counts
- context overhead per treatment arm
- top blocker counts for excluded rows

Keep the historical ROI eval alongside replay results. Historical ROI gives
coverage over a broad local corpus; replay gives a smaller but stronger actual
token/time measurement.
