# Context Injection And Code Review Graph

Panopticon has two context surfaces:

- Pull context through MCP and CLI tools such as `why_code`,
  `recent_work_on_path`, and `file_overview`.
- Push context through hook `additionalContext`, emitted at session start,
  prompt submit, or point of tool use.

Push context is deliberately conservative. It is deterministic, bounded, and
silent when Panopticon does not have matching local history. Treat any injected
text as background memory only; the current user request and current file
contents always win.

MCP pull tools also keep default output bounded. Long-history tools return
compact rows unless the request includes `fullPayloads: true`; use that escape
hatch for audits where exact prompt text, tool JSON, or full summary detail is
more important than token budget.

Targets that do not consume hook `additionalContext` still record hook events,
but may not show injected text to the model. The current point-of-use read path
is verified against Claude/Codex-style `PreToolUse` responses.

## Runtime Flags

The Panopticon server reads these flags at startup:

| Flag | Default | Surface | Notes |
|------|---------|---------|-------|
| `PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION` | `1` | `SessionStart` | Recent local session summaries for the current cwd. |
| `PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION` | `1` | `UserPromptSubmit` | Prompt-relevant local history for mid-session prompts. The first prompt in a session is intentionally silent. |
| `PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION` | `1` | `PreToolUse` edit tools | File provenance before `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` when the file has prior history. Deduped once per session/path. |
| `PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION` | `1` | `PreToolUse` `Read` | Short file provenance before reads when the file has prior history. Deduped once per session/path. |
| `PANOPTICON_ENABLE_CONTEXT_NOTICES` | `1` | Hook stderr | One-line human-visible receipts when point-of-use file context is surfaced. |
| `PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW` | `0` | `file_overview` | Adds Code Review Graph-derived `code_intel` when a repo-local graph exists. |

Use `0`, `false`, `no`, or `off` to disable a flag. Use `1`, `true`, `yes`, or
`on` to enable it.

## Enabling Flags

For a one-off test with Code Review Graph enrichment, stop the existing server
and start it with the desired flag:

```bash
panopticon stop
PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW=1 \
panopticon start --force
```

For persistent overrides, put the flags in the shell environment that launches
your AI coding tool:

```bash
export PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW=1
```

Then restart Panopticon and open a new Claude Code, Gemini CLI, Codex CLI, or
Pi session:

```bash
panopticon stop
panopticon start --force
```

`panopticon install` does not add experimental feature flags automatically.

If hooks auto-start the server, the hook process inherits the environment from
the agent process. In that case, update the shell profile, start a new terminal
or agent session, and let `SessionStart` start Panopticon with the new flags.

## Employee Rollout Checklist

Use this checklist for canary users who should exercise all context
intelligence surfaces:

```bash
panopticon install

export PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION=1
export PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION=1
export PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION=1
export PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION=1
export PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW=1

cd /path/to/repo
code-review-graph build
code-review-graph status

panopticon stop
panopticon start --force
panopticon doctor
panopticon status
```

`doctor` and `status` report:

- current context-injection flags
- configured hook targets and source identity (`explicit` or `native`)
- recent context-eligible hook volume for `SessionStart`, `UserPromptSubmit`,
  `PreToolUse Read`, and `PreToolUse` edit tools
- Code Review Graph readiness for the current repository

For field feedback, ask users to report missing context, noisy read context,
hook latency, hook timeouts, and `code_intel` states other than `ready`.

## Injection Behavior

### SessionStart

`PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION=1` emits recent session
summary previews scoped to the current cwd. It is intended to orient a resumed
or recurring task without requiring an MCP lookup.

### UserPromptSubmit

`PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION=1` emits prompt-matched
local context after the session is already underway. The first user prompt is
silent by design because broad opener prompts tend to match ambient repository
vocabulary and duplicate SessionStart context.

### PreToolUse For Edits

`PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION=1` emits a short
provenance note before supported edit tools touch a file with existing
Panopticon history. Files with no prior provenance stay silent. The same
session/path pair is emitted once to avoid nagging during iterative edits.

### PreToolUse For Reads

`PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION=1` emits a shorter
provenance note before `Read` for files with existing Panopticon history. The
same session/path pair is emitted once, and the flag can be set to `0` when
comparing discovery churn or token/noise tradeoffs.

Current read-time output is provenance-focused. It does not render Code Review
Graph relationships in the hook text; use `file_overview` when you want the
combined Panopticon plus CRG view.

### Context Notices

`PANOPTICON_ENABLE_CONTEXT_NOTICES=1` emits a single hook stderr line when
point-of-use file context is surfaced. The full payload remains in structured
`additionalContext`; the stderr notice is only a concise receipt for humans.
Edit notices fire whenever edit-time file context is injected. Read notices are
more conservative and fire only for high-history reads, such as reverted,
superseded, or frequently edited paths.

## Code Review Graph Enrichment

When `PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW=1`, `file_overview` tries to
read `.code-review-graph/graph.db` from the target repository root and adds a
`code_intel` block with graph-derived related files.

Panopticon does not start or maintain Code Review Graph. Build the graph in
each repository you want enriched:

```bash
pipx install code-review-graph
cd /path/to/repo
code-review-graph build
code-review-graph status
```

For ongoing use:

```bash
code-review-graph update
# or
code-review-graph watch
```

To expose Code Review Graph as its own MCP server for agents, run:

```bash
code-review-graph install
```

That is independent of Panopticon's `file_overview` enrichment. Panopticon only
needs the local `.code-review-graph/graph.db` file.

## Verification

After enabling the flags, check that Panopticon sees the flags, hooks,
activity, and CRG data:

```bash
PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW=1 panopticon start --force
panopticon doctor
panopticon status
panopticon file overview src/config.ts
```

`doctor` and `status` should include context intelligence diagnostics. The
`file_overview` result should include a `code_intel` object with
`status: "ready"` when the repo graph exists. Without a graph, `file_overview`
still returns Panopticon's own provenance and reports Code Review Graph as
unavailable.

To verify read-time injection, restart Panopticon, then read a file with
existing Panopticon provenance from a new agent session. The first read for
that session/path should include `Panopticon read context`; later reads of the
same path in the same session should be silent.

## Historical ROI Eval

Use the historical context eval for a broad, deterministic ROI proxy over local
sessions. It does not replay agent output. Instead, it asks whether a selected
injection feature set would have surfaced files or sessions the historical
agent later discovered before its first edit.

The default matrix compares `none`, `panop`, and `panop+optimized-crg` with all
Panopticon token injection surfaces enabled: `SessionStart`,
`UserPromptSubmit`, and `PreToolUse`.

```bash
pnpm eval:panop-historical -- \
  --limit 30 \
  --output-json .tmp/evals/historical/default-30.json \
  --report-markdown .tmp/evals/historical/default-30.md
```

Run one injection feature set at a time when measuring a specific surface:

```bash
pnpm eval:panop-historical -- \
  --limit 30 \
  --injection-features pretooluse \
  --output-json .tmp/evals/historical/pretooluse-30.json \
  --report-markdown .tmp/evals/historical/pretooluse-30.md
```

To build a deterministic real-session sample that exercises every selected hook
surface, use hook coverage mode:

```bash
pnpm eval:panop-historical -- \
  --limit 30 \
  --hook-coverage \
  --require-hook-coverage \
  --include-automated \
  --output-json .tmp/evals/historical/hook-coverage-30.json \
  --report-markdown .tmp/evals/historical/hook-coverage-30.md
```

`--hook-coverage` scans a larger deterministic candidate pool, picks real
sessions whose actual reconstructed Panop contexts emit each selected surface,
then fills the remaining sample in normal recency order.

Useful options:

- `--injection-features all` measures all three surfaces together and is the
  default.
- `--injection-features reliable` measures only the narrower SessionStart plus
  UserPromptSubmit set.
- `--injection-features sessionstart`, `userpromptsubmit`, or `pretooluse`
  measures one surface.
- `--include-original-crg` adds the original Code Review Graph-only arm for
  comparison.
- `--hook-coverage` chooses a sample that tries to cover every selected hook
  surface.
- `--require-hook-coverage` fails the run if any selected surface has zero
  injected events.
- `--hook-coverage-candidate-limit N` controls how many real session candidates
  are scanned in hook coverage mode.
- `--fixture-file PATH` restricts the sample to session IDs from a replay
  fixture.

The report's token savings are a discovery-token proxy: matched historical read
tokens minus injected context tokens. Treat wall-clock time as directional until
strict replay produces enough comparable pairs.

For the stricter token/time measurement path that actually replays historical
sessions through treatment arms, see [REPLAY-EVAL-PLAN.md](REPLAY-EVAL-PLAN.md).
