# How was Opus 4.8 used in your project?

*Throughout, "Opus" means **Opus 4.8 (1M context)**, referred to as `"opus"` in our config.*

Two ways — we built the whole thing with it, and it's the intelligence inside the product itself.

**As the builder.** The project was developed in Claude Code on Opus 4.8 (1M context). It accounted for **23 sessions and ~94% of build spend** (model dollar cost), per Panopticon's own cost tracking. Opus designed the layered architecture and wrote the presence layer, the message bus, hook delivery, Frenemy, and live agent chat — plus their test suites — across a long-context, multi-session build where we repeatedly fed the evolving architecture and recent diffs back into the prompt.

**As the product's reviewer.** Opus 4.8 isn't just how we built Frenemy — it *is* Frenemy. The reviewer agent defaults to Opus (`FRENEMY_DEFAULT_MODEL = "opus"`) because the job is judgment: it reads the diff of each change as it lands and decides whether to challenge it. That judgment *is* the product, and we wanted the strongest default.

**Where those met — Opus reviewing Opus, live.** We dogfooded Frenemy during its own development: an Opus 4.8 reviewer critiqued the code another Opus 4.8 agent was writing, in real time. It earned its keep. In one pass it caught a compile error before it landed — a constant referenced but never defined, which would have thrown at runtime on a core path.

More tellingly, it flagged a test that was **passing for the wrong reason**: a test meant to verify that a frenemy session is excluded from notifications was green, but only because the message happened to fall outside the session's time window. Deleting the actual guard the test protects would have kept it green, so the test asserted nothing. Frenemy proposed the fix — seed presence first, then broadcast, so the role gate is the only thing that can suppress the notification — and we applied it.

That's the thesis of the project, demonstrated on itself: a confident agent's mistake — a test that looks like it works but doesn't — caught in the moment by a second agent thinking critically about it. Both of them Opus 4.8.

---

**Verifiable artifacts.** The fix is commit `f38cf54` ("Address frenemy review of the append-only-chat change"), whose commit footer reads `Co-Authored-By: Claude Opus 4.8 (1M context)`. The original finding is preserved on the agent message bus (our event log) as `challenge` message **#21** from session `frenemy`, addressed to the builder session, timestamped during the build.
