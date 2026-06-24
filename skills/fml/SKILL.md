---
name: fml
description: Route FML command-style requests to the right FML MCP tool, local data tool, or `fml` CLI command. Use when the user invokes /fml, $fml, asks to run an FML subcommand, wants agent activity, sessions, timelines, costs, team activity, synced repository context, integration queries, tool catalog access, lifecycle/status/sync operations, local/unsynced data, or asks for `fml review` to review the current branch.
---

<!-- fml-managed-agent-surface:v1 -->

# FML Command Router

Route command-shaped FML requests to the FML MCP tools, local session tools, or the `fml` CLI. Treat `/fml <args>` and `$fml <args>` as the same command surface.

## Routing Rules

1. Parse the first token as the subcommand. If there is no subcommand, show concise help and prefer `fml status` only if the user asked for current state.
2. Prefer MCP for structured read-only remote queries, integration queries, team activity, spending, synced repository context, and tool catalog operations.
3. Use `fml <command> --local` for common local/unsynced data reads, and `fml local <args...>` for local Panopticon passthrough commands without a dedicated FML alias.
4. Prefer the `fml` CLI for lifecycle, login/logout, install/uninstall/update, doctor, sync setup, sync reset, start/stop, local data, and dynamic tool calls not exposed as dedicated MCP tools.
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
| `activity`, `sessions`, `timeline`, `spending`, `search` | FML MCP tools when the user wants synced/org data; CLI with `--local` when the user asks for local/unsynced data. |
| `activity --local [--since X]` | CLI `fml activity --local ...`. |
| `sessions --local [--since X] [--limit N]` | CLI `fml sessions --local ...`. |
| `timeline <session-id> --local [--limit N] [--offset N] [--full]` | CLI `fml timeline ... --local`. |
| `spending --local [--since X] [--group-by K]` | CLI `fml spending --local ...`. |
| `search <query> --local [--since X] [--limit N] [--offset N] [--full]` | CLI `fml search ... --local`. |
| `team-analysis` or team activity questions | MCP `fml_run_team_analysis` or `get_engineering_activity`. |
| `tools list|describe|call` | FML MCP dynamic catalog when exposed; otherwise CLI `fml tools ...`. |
| `integrations`, `query <provider> ...` | Dedicated `fml_query_*` MCP tools when available; otherwise CLI `fml query ...`. |
| `messages`, `slack`, `analysis`, `configs`, `repo-config`, `user-config` | Dedicated FML MCP tools when available; otherwise CLI. |
| `file why|recent|overview`, `plans`, `query <sql>` for local DB | Local session MCP tools. Only read-only SQL is allowed. |

If a route is unavailable, fall back to the other interface and say which fallback was used.

## Argument Notes

- Convert hyphenated aliases to MCP tool names when needed: `team-analysis` -> `fml_run_team_analysis`, `repo-config` -> `get_repo_config`, `file-overview` -> `file_overview`.
- For timeline-style commands, honor explicit `--limit`, `--offset`, `--since`, and full-payload options when present.
- If a local passthrough includes `--help`, use `fml local -- <args...>` so the flag reaches the local command.
- For local database SQL, run only read-only `SELECT`, `WITH`, or `PRAGMA` queries.
- Do not recommend the deprecated `panopticon` command for new workflows. Use it only as an implementation detail or explicit compatibility fallback.

## Local Data

Use `--local` when the user asks for data on this machine before sync, data that has not reached FML cloud, or local-only diagnostics:

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
