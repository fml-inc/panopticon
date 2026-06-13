# How did you orchestrate Claude's work?

Our strategy had a nice recursion to it: the orchestration technique *became* the product. We directed Claude with a plan-first, layer-by-layer loop, and the verifier in that loop is the very thing we shipped — Frenemy, a second Opus agent that reviews work as it lands.

**1. Plan first, then build in shippable layers.** We opened with `/plan` and had Opus produce a single design brief that decomposed the work into independent layers (presence → message bus → hook delivery → Frenemy → live chat), one PR per layer, each landing on a running base branch. The brief was the contract; every session worked against it. It even embedded a deep-research pass (web search + adversarial fact-check, 24/25 claims verified) to settle the multi-agent-debate protocol before we built on it.
→ Brief: [`docs/FRENEMY-BRIEF.md`](docs/FRENEMY-BRIEF.md)

**2. Tight build→pack→test→install loop per layer.** Each layer was built, type-checked, unit-tested, packed, and installed into the live global CLI before moving on — so we were dogfooding the real binary, not a dev build, throughout. Layers landed as PRs #275–#283.

**3. A verifier agent — built, then turned on ourselves.** Frenemy is the orchestration loop made concrete. `panopticon frenemy` runs a long-poll loop that wakes on workspace activity, hands the **actual git diff** of what changed to a headless Opus critic governed by a fixed review rubric, and posts `CHALLENGE`/`SKIP` findings onto the bus. We ran it against our own build — Opus reviewing Opus, live — and it caught real bugs we fixed (a test passing for the wrong reason; a compile error). The rubric is a real, inspectable prompt (priority order: correctness → edge cases → security → reinvention → maintainability; bias toward SKIP so it doesn't nitpick).
→ Verifier + rubric: [`src/frenemy/driver.ts`](src/frenemy/driver.ts) (`FRENEMY_PERSONA`, `runFrenemyOnce`, `createFrenemyLoop`)

**4. Deterministic scaffolding around a thin model call.** The driver is deliberately dumb plumbing: it decides *what* to review (roster + new-since-cursor activity + diff) and the model only *judges*. Cursors bookmark unreviewed work, role-gating stops the reviewer from reviewing itself into a storm, and the long-poll means zero model calls while the room is idle. This keeps the model's job small and the orchestration auditable.

**5. Multiple parallel sessions, coordinated and observed.** Several Claude sessions ran at once in the same workspace — a builder, the Frenemy reviewer, and a separate Mission Control UI session in its own worktree — coordinating over the bus and observed through Panopticon's roster/presence. We used the product to orchestrate its own construction, which is also how we have the cost/usage numbers and the bus record of the reviews.

**6. Custom surfaces (not CLAUDE.md).** Direction went through a `/panopticon` slash command and skill, the `panopticon frenemy` / `panopticon chat` CLI subcommands, and a persistent file-based memory rather than a CLAUDE.md. (We did not use a CLAUDE.md or a separate workflow-runner script — the "workflow script" here is the Frenemy driver itself.)
→ Surfaces: [`commands/panopticon.md`](commands/panopticon.md), [`skills/panopticon/SKILL.md`](skills/panopticon/SKILL.md), [`src/cli.ts`](src/cli.ts) (`frenemy`, `chat` commands)

## Links
- **Brief / design rubric:** [`docs/FRENEMY-BRIEF.md`](docs/FRENEMY-BRIEF.md)
- **Verifier agent + review rubric (prompt):** [`src/frenemy/driver.ts`](src/frenemy/driver.ts)
- **Orchestration surfaces:** [`commands/panopticon.md`](commands/panopticon.md), [`skills/panopticon/SKILL.md`](skills/panopticon/SKILL.md), [`src/cli.ts`](src/cli.ts)
