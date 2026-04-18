# Derived Metrics Ideas

Ideas for higher-level metrics computed from data panopticon already captures.
Sourced from reviewing community projects (claude-code-otel, claude_telemetry,
anthropics/claude-code-monitoring-guide) and our own data.

## Tool acceptance rate

**Source data**: `PreToolUse`, `PostToolUse`, `PostToolUseFailure` hook events

Compute per-tool acceptance vs rejection rates. A low acceptance rate on a
specific tool (e.g. Write at 65%) signals Claude is proposing bad edits there.
Could surface in a future `tool_stats` MCP tool (or a field on `summary`) as
`acceptance_rate` alongside `call_count`.

Stretch: track acceptance rate over time to see if prompt engineering or model
upgrades improve tool accuracy.

## Cache efficiency

**Source data**: `token.usage` OTel metrics with type attribute
(`input`, `output`, `cache_creation`, `cache_read`)

Panopticon already ingests these but only aggregates total tokens and cost.
A cache hit ratio (`cache_read / (cache_read + cache_creation + input)`) would
show whether prompt caching is working or if you're paying for redundant context
on every request.

Could be a new field in `costs` or a standalone `cache_efficiency` MCP tool.

## Session cost efficiency

**Source data**: `otel_costs` + `hook_events` (tool counts, lines changed)

Cost-per-tool-call, cost-per-commit, cost-per-PR, cost-per-line-changed.
These normalize raw cost against output and let you compare sessions:
a $5 session that produced 3 PRs is more efficient than a $5 session that
produced 1. Useful for the summary/reporting layer.

## Automated periodic reports

**Source data**: `summary` MCP tool + external integrations (Linear, GitHub)

A skill or cron prompt that runs `summary` for a time window, pulls
in Linear/GitHub activity, and generates a standup or weekly report. The
monitoring-guide project does this with a prompt template + `claude -p`. We
could ship a `/report` skill that does it natively.

## Idle vs active time ratio

**Source data**: `active_time.total` OTel metric + session start/end timestamps

Claude Code emits `active_time.total` but panopticon doesn't surface it.
Comparing active time to wall-clock session duration shows how much time Claude
spent thinking/working vs waiting for user input. Useful for understanding
session patterns.

## Error rate by model

**Source data**: `api_error` OTel log events with model and status code attributes

Track error rates (rate limits, overloaded, auth failures) per model over time.
Helps decide when to switch models or identifies quota issues before they become
blockers.

## Prompt complexity vs cost correlation

**Source data**: `user_prompt` OTel logs (with `OTEL_LOG_USER_PROMPTS=1`) +
session cost

Correlate prompt length/complexity with session cost and token usage. Long
prompts that produce cheap sessions might indicate well-scoped tasks; short
prompts with expensive sessions might indicate vague instructions that cause
thrashing.

Requires prompt logging to be enabled — opt-in only.

## Subagent overhead

**Source data**: `SubagentStart`, `SubagentStop` hook events + parent session cost

Track what fraction of a session's cost and tokens are consumed by subagents
vs the main agent. Helps evaluate whether subagent delegation is efficient or
just burning tokens on context duplication.
