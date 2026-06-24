---
name: fml
description: Route FML command-style requests to the right FML MCP tool, local data tool, or `fml` CLI command. Use when the user invokes /fml, $fml, asks to run an FML subcommand, wants agent activity, sessions, timelines, costs, team activity, synced repository context, integration queries, tool catalog access, lifecycle/status/sync operations, local/unsynced data, or asks for `fml review` to review the current branch.
---

<!-- fml-managed-agent-surface:v1 -->

# FML Command Router

Route command-shaped FML requests to the FML MCP tools, FML local MCP tools, or the `fml` CLI. Treat `/fml <args>` and `$fml <args>` as the same command surface.

## Routing Rules

1. Parse the first token as the subcommand. If there is no subcommand, show concise help and prefer `fml status` only if the user asked for current state.
2. Prefer MCP for structured read-only local data, remote queries, integration queries, team activity, spending, synced repository context, and tool catalog operations.
3. Use FML local MCP tools for common local/unsynced reads. Use `fml <command> --local` when MCP is unavailable or the user asked for the CLI, and `fml local <args...>` for local passthrough commands without a dedicated FML alias.
4. Prefer the `fml` CLI for lifecycle, login/logout, install/uninstall/update, doctor, sync setup, sync reset, start/stop, and dynamic tool calls not exposed as dedicated MCP tools.
5. If you are unsure whether a CLI command exists or need hidden/internal command coverage, run `fml commands` and route based on that inventory. Do not guess argument names for backend tools; use `fml tools describe <name> --json`.
6. Use normal tool-approval and safety rules for write or destructive operations. Do not silently run `sync reset`, `sync remove`, `uninstall --purge`, `tools call` against write-like integrations, `automation create/update/delete`, `memory write/delete`, analysis runs, or equivalent commands.
7. Keep output concise. Summarize large JSON/tool results instead of dumping everything unless the user asks for raw output.

## Subcommands

Use these mappings for common requests:

| User command | Preferred route |
| --- | --- |
| `review` | Read `references/review.md` and perform that PR review workflow. |
| `status`, `doctor`, `install`, `uninstall`, `update`, `login`, `logout`, `org`, `open`, `env` | CLI. |
| `start`, `stop`, `sync ...` | CLI, with approval/safety checks for writes. |
| `local <args...>` | CLI passthrough to local Panopticon data and diagnostics. |
| `activity`, `sessions`, `timeline`, `spending`, `search` | FML MCP tools when the user wants synced/org data; FML local MCP tools when the user asks for local/unsynced data. |
| `activity --local [--since X]` | MCP `fml_local_activity`; CLI fallback `fml activity --local ...`. |
| `sessions --local [--since X] [--limit N]` | MCP `fml_local_sessions`; CLI fallback `fml sessions --local ...`. |
| `timeline <session-id> --local [--limit N] [--offset N] [--full]` | MCP `fml_local_timeline`; CLI fallback `fml timeline ... --local`. |
| `spending --local [--since X] [--group-by K]` | MCP `fml_local_spending`; CLI fallback `fml spending --local ...`. |
| `search <query> --local [--since X] [--limit N] [--offset N] [--full]` | MCP `fml_local_search`; CLI fallback `fml search ... --local`. |
| `team-analysis` or team activity questions | MCP `fml_run_team_analysis` or `get_engineering_activity`. |
| `tools list|describe|call` | FML MCP dynamic catalog when exposed; otherwise CLI `fml tools ...`. |
| `integrations`, `query <provider> ...` | Dedicated `fml_query_*` MCP tools when available; otherwise CLI `fml query ...`. |
| `messages`, `slack`, `analysis`, `configs`, `repo-config`, `user-config` | Dedicated FML MCP tools when available; otherwise CLI. |
| `plans`, `query <sql>` for local DB | MCP `fml_local_plans` or `fml_local_query`. Only read-only SQL is allowed. |
| `file why|recent|overview` for local provenance | MCP `fml_local_why_code`, `fml_local_recent_work_on_path`, or `fml_local_file_overview`. |

If a route is unavailable, fall back to the other interface and say which fallback was used.

## Argument Notes

- Convert hyphenated aliases to MCP tool names when needed: `team-analysis` -> `fml_run_team_analysis`, `repo-config` -> `get_repo_config`, `file-overview --local` -> `fml_local_file_overview`.
- For timeline-style commands, honor explicit `--limit`, `--offset`, `--since`, and full-payload options when present.
- If a local passthrough includes `--help`, use `fml local -- <args...>` so the flag reaches the local command.
- For local database SQL, run only read-only `SELECT`, `WITH`, or `PRAGMA` queries.
- Do not recommend the deprecated `panopticon` command for new workflows. Use it only as an implementation detail or explicit compatibility fallback.

## Local Data

Use FML local MCP tools when the user asks for data on this machine before sync, data that has not reached FML cloud, or local-only diagnostics:

| Need | MCP tool |
| --- | --- |
| local activity | `fml_local_activity` |
| local sessions | `fml_local_sessions` |
| local timeline | `fml_local_timeline` |
| local hooks/prompts/plans audit | `fml_local_hook_timeline`, `fml_local_plans` |
| local spending | `fml_local_spending` |
| local text search | `fml_local_search` |
| local DB query | `fml_local_query` |
| local code provenance | `fml_local_why_code`, `fml_local_recent_work_on_path`, `fml_local_file_overview` |

Use the CLI when MCP is unavailable or the user explicitly asks to run a command:

```bash
fml activity --local --since 24h
fml sessions --local --since 7d --limit 20
fml timeline <session-id> --local --full
fml spending --local --since 7d --group-by model
fml search "query text" --local --since 7d
```

For local commands without dedicated FML aliases, use `fml local <args...>`. This is a passthrough to the local Panopticon CLI while keeping the user-facing surface under FML.

## Safety Notes

- Never print, copy, or summarize files named like `auth.*.json` under the FML data directory.
- Do not export or invent tokens. Use `fml login --device` for sandbox auth and `fml sync-token` only when a command requires it.
- If an auth, network, or sync command fails, report the exact command and key error. Do not retry indefinitely.

## Review

For `fml review`, load `references/review.md` and follow it.
