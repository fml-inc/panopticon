---
name: panopticon
description: Route Panopticon command-style requests to the right Panopticon MCP tool or CLI command. Use when the user invokes /panopticon, $panopticon, asks to run a Panopticon subcommand, wants recent sessions, timelines, costs, summaries, plans, search, SQL, file provenance, permissions, lifecycle status, sync/prune/scan operations, or asks for `panopticon review` to review the current branch.
---

# Panopticon Command Router

Route command-shaped Panopticon requests to either Panopticon MCP tools or the `panopticon` CLI. Treat `/panopticon <args>` and `$panopticon <args>` as the same command surface.

## Routing Rules

1. Parse the first token as the subcommand. If there is no subcommand, show concise help and prefer a lightweight `summary` or `status` lookup only if the user asked for current state.
2. Prefer MCP for read-only data queries because it returns structured, compact results.
3. Prefer the CLI for lifecycle, log, sync, prune, scan, install, uninstall, update, and doctor operations.
4. Use normal tool-approval and safety rules for write or destructive operations. Do not silently run `prune`, `sync reset`, `permissions apply`, `uninstall --purge`, or equivalent commands.
5. Keep output concise. Summarize large JSON/tool results instead of dumping everything unless the user asks for raw output.

## Subcommands

Use these mappings for common requests:

| User command | Preferred route |
| --- | --- |
| `review` | Read `references/review.md` and perform that PR review workflow. |
| `chat [send\|wait]` | Read `references/chat.md`; live agent-to-agent conversation over the bus (`panopticon chat send`/`wait`). |
| `sessions [--since X] [--limit N]` | MCP `sessions`. |
| `timeline <session-id> [--limit N] [--offset N] [--full]` | MCP `timeline`. |
| `summary [--since X]` | MCP `summary`. |
| `costs [--group-by session|model|day] [--since X]` | MCP `costs`. |
| `plans [--since X] [--limit N]` | MCP `plans`. |
| `search <query>` | MCP `search`. |
| `query <sql>` | MCP `query`; only read-only SQL is allowed. |
| `get <source> <id>` or `print <source> <id>` | MCP `get`. |
| `hook-timeline [filters]` | MCP `hook_timeline`. |
| `session-summaries [filters]` | MCP `session_summaries`. |
| `session-summary-detail <session-id>` | MCP `session_summary_detail`. |
| `intent-for-code <path>` | MCP `intent_for_code`. |
| `search-intent <query>` | MCP `search_intent`. |
| `outcomes-for-intent <id>` | MCP `outcomes_for_intent`. |
| `file overview <path>` | MCP `file_overview`. |
| `file why <path> [line]` | MCP `why_code`. |
| `file recent <path>` | MCP `recent_work_on_path`. |
| `permissions show|preview|apply` | MCP permissions tools when available; otherwise CLI. |
| `status`, `doctor`, `logs`, `start`, `stop`, `install`, `uninstall`, `update` | CLI. |
| `scan`, `refresh-pricing`, `prune`, `sync ...` | CLI, with approval/safety checks for writes. |

If a route is unavailable, fall back to the other interface and say which fallback was used.

## Argument Notes

- Convert hyphenated aliases to MCP tool names when needed: `session-summary-detail` -> `session_summary_detail`, `file-overview` -> `file_overview`.
- For `file why`, pass a numeric trailing argument as `line`.
- For `timeline --full`, set `fullPayloads: true`.
- For compact list commands, honor explicit `--limit`, `--offset`, `--since`, `--group-by`, and repository/path filters when present.

## Review

For `panopticon review`, load `references/review.md` and follow it. This replaces the old `panopticon-review` and `pr-review` skill/command names; do not invoke or recommend the legacy names.
