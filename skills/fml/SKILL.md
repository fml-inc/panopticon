---
name: fml
description: Route FML command-style requests to the right FML MCP tool, local data tool, or `fml` CLI command. Use when the user invokes /fml, $fml, asks to run an FML subcommand, wants agent activity, sessions, timelines, costs, team activity, synced repository context, integration queries, tool catalog access, lifecycle/status/sync operations, or asks for `fml review` to review the current branch.
---

# FML Command Router

Route command-shaped FML requests to the FML MCP tools, local session tools, or the `fml` CLI. Treat `/fml <args>` and `$fml <args>` as the same command surface.

## Routing Rules

1. Parse the first token as the subcommand. If there is no subcommand, show concise help and prefer `fml status` only if the user asked for current state.
2. Prefer MCP for structured read-only remote queries, integration queries, team activity, spending, synced repository context, and tool catalog operations.
3. Prefer local session MCP tools for local-only session, timeline, search, cost, plan, and file-provenance lookups. Present this as FML local data to the user.
4. Prefer the `fml` CLI for lifecycle, login/logout, install/uninstall/update, doctor, sync setup, sync reset, start/stop, and dynamic tool calls not exposed as dedicated MCP tools.
5. Use normal tool-approval and safety rules for write or destructive operations. Do not silently run `sync reset`, `uninstall --purge`, or equivalent commands.
6. Keep output concise. Summarize large JSON/tool results instead of dumping everything unless the user asks for raw output.

## Subcommands

Use these mappings for common requests:

| User command | Preferred route |
| --- | --- |
| `review` | Read `references/review.md` and perform that PR review workflow. |
| `status`, `doctor`, `install`, `uninstall`, `update`, `login`, `logout`, `org`, `open`, `env` | CLI. |
| `start`, `stop`, `sync ...` | CLI, with approval/safety checks for writes. |
| `activity`, `sessions`, `timeline`, `spending`, `search` | FML MCP tools when the user wants synced/org data; local session MCP tools when the user asks for local data. |
| `team-analysis` or team activity questions | MCP `fml_run_team_analysis` or `get_engineering_activity`. |
| `tools list|describe|call` | FML MCP dynamic catalog when exposed; otherwise CLI `fml tools ...`. |
| `integrations`, `query <provider> ...` | Dedicated `fml_query_*` MCP tools when available; otherwise CLI `fml query ...`. |
| `messages`, `slack`, `analysis`, `configs`, `repo-config`, `user-config` | Dedicated FML MCP tools when available; otherwise CLI. |
| `file why|recent|overview`, `plans`, `query <sql>` for local DB | Local session MCP tools. Only read-only SQL is allowed. |

If a route is unavailable, fall back to the other interface and say which fallback was used.

## Argument Notes

- Convert hyphenated aliases to MCP tool names when needed: `team-analysis` -> `fml_run_team_analysis`, `repo-config` -> `get_repo_config`, `file-overview` -> `file_overview`.
- For timeline-style commands, honor explicit `--limit`, `--offset`, `--since`, and full-payload options when present.
- For local database SQL, run only read-only `SELECT`, `WITH`, or `PRAGMA` queries.
- Do not recommend the deprecated `panopticon` command for new workflows. Use it only as an implementation detail or explicit compatibility fallback.

## Review

For `fml review`, load `references/review.md` and follow it.
