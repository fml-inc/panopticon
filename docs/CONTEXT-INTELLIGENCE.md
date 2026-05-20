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
is verified against Claude-style `PreToolUse` responses.

## Runtime Flags

The Panopticon server reads these flags at startup:

| Flag | Default | Surface | Notes |
|------|---------|---------|-------|
| `PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION` | `1` | `SessionStart` | Recent local session summaries for the current cwd. |
| `PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION` | `1` | `UserPromptSubmit` | Prompt-relevant local history for mid-session prompts. The first prompt in a session is intentionally silent. |
| `PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION` | `1` | `PreToolUse` edit tools | File provenance before `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` when the file has prior history. Deduped once per session/path. |
| `PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION` | `0` | `PreToolUse` `Read` | Short file provenance before reads when the file has prior history. Opt-in while measuring token/noise tradeoffs. |
| `PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW` | `0` | `file_overview` | Adds Code Review Graph-derived `code_intel` when a repo-local graph exists. |

Use `0`, `false`, `no`, or `off` to disable a flag. Use `1`, `true`, `yes`, or
`on` to enable it.

## Enabling Flags

For a one-off test, stop the existing server and start it with the desired
flags:

```bash
panopticon stop
PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION=1 \
PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW=1 \
panopticon start --force
```

For persistent use, put the flags in the shell environment that launches your
AI coding tool:

```bash
export PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION=1
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
provenance note before `Read` for files with existing Panopticon history. This
is currently opt-in because read operations are frequent and the token/noise
tradeoff is still being measured. The same session/path pair is emitted once.

Current read-time output is provenance-focused. It does not render Code Review
Graph relationships in the hook text; use `file_overview` when you want the
combined Panopticon plus CRG view.

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

Check that Panopticon sees CRG data:

```bash
PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW=1 panopticon start --force
panopticon file overview src/config.ts
```

The result should include a `code_intel` object with `status: "ready"` when the
repo graph exists. Without a graph, `file_overview` still returns Panopticon's
own provenance and reports Code Review Graph as unavailable.

To verify read-time injection, enable the flag, restart Panopticon, then read a
file with existing Panopticon provenance from a new agent session. The first
read for that session/path should include `Panopticon read context`; later
reads of the same path in the same session should be silent.
