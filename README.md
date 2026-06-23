# Panopticon

<div align="center">
  <img src="panopticon.jpg" alt="Panopticon — Willey Reveley, 1791" width="480">
  <br>
  <em>Elevation and plan of Jeremy Bentham's Panopticon, drawn by Willey Reveley in 1791</em>
</div>

<br>

Self-contained observability for AI coding tools. Captures OpenTelemetry signals, hook events, API traffic, and local session files from Claude Code, Gemini CLI, Codex CLI, and Pi — stored in SQLite, queryable via MCP.

No Docker, no external services. Just Node.js.

## Install

```bash
npm install -g @fml-inc/panopticon
panopticon install
```

This initializes the database, registers hooks and MCP servers in each detected tool, and configures OTel environment variables in your shell. Start a new session to activate.

To install for a specific tool only:

```bash
panopticon install --target claude
panopticon install --target gemini
panopticon install --target codex
panopticon install --target claude-desktop
panopticon install --target pi
panopticon install --target hermes
```

Claude Desktop stores the absolute Node executable path in its MCP config
because macOS GUI launches often do not inherit the shell `PATH`. CLI targets
use a portable `node` command so installs can move between Node versions.

Options:

| Flag | Description |
|------|-------------|
| `--target <t>` | Target: `claude`, `gemini`, `codex`, `claude-desktop`, `pi`, `hermes`, or `all` (default: `all`) |
| `--proxy` | Route API traffic through the panopticon proxy |
| `--force` | Overwrite customized env vars with defaults |

### From source

```bash
git clone https://github.com/fml-inc/panopticon.git && cd panopticon
pnpm install && pnpm build
npm pack
npm install -g ./fml-inc-panopticon-*.tgz
panopticon install
```

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│     Claude Code / Gemini CLI / Codex CLI / Pi               │
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌────────┐  │
│  │ OTel SDK │  │ Plugin Hooks │  │ Session   │  │  API   │  │
│  │          │  │              │  │ Files     │  │ Proxy  │  │
│  └────┬─────┘  └──────┬───────┘  └─────┬─────┘  └───┬────┘  │
└───────┼───────────────┼───────────────┼──────────────┼───────┘
        │               │               │              │
        ▼               ▼               │              ▼
┌───────────────────────────────────────┼──────────────────────┐
│        Unified Panopticon Server (:4318)                     │
│                                       │                      │
│  /v1/logs, /v1/metrics   /hooks       │  /proxy/anthropic    │
│  (OTLP ingest)           (hook JSON)  │  /proxy/openai       │
│                                       │  /proxy/google       │
└──────────────────────┬────────────────┼──────────────────────┘
                       │                │
                       ▼                ▼
          ┌─────────────────────────────────────┐
          │         SQLite (WAL mode)           │
          │                                     │
          │  sessions (unified, all sources)    │
          │  hook_events / otel_logs / metrics  │
          │  scanner_turns / scanner_events     │
          └──┬──────────┬──────────────┬────────┘
             │          │              │
             ▼          ▼              ▼
      ┌──────────┐ ┌────────────┐ ┌──────────────┐
      │   MCP    │ │    Sync    │ │   Scanner    │
      │  Server  │ │   Loops    │ │ + Summaries  │
      │ (stdio)  │ │   (OTLP)   │ │  (poll/idle) │
      └──────────┘ └────────────┘ └──────────────┘
```

**Five data pipelines feed one database:**

1. **Hook events** — Plugin hooks capture SessionStart, tool use (pre/post), prompts, and session end. Rich payloads including tool inputs and outputs.

2. **OTel logs** — Native telemetry events: API requests/responses, tool calls, user prompts, config, model routing. Includes cost, token counts, durations, model info.

3. **OTel metrics** — Time series: `token.usage`, `cost.usage`, `session.count`, `active_time.total`, `lines_of_code.count`, `commit.count`, `pull_request.count`.

4. **Session file scanner** — Reads local JSONL/JSON session files written by each CLI. Extracts per-turn token usage (input, output, cache read, cache creation, reasoning), tool calls, API errors, agent reasoning, and file snapshots. More complete than OTel for token data (captures ~2x the turns) and provides historical backfill for sessions before panopticon was installed.

5. **API proxy** — Transparent HTTP proxy for Anthropic, OpenAI, and Google AI APIs. Captures request/response pairs and emits them as hook events and OTel data. Enable with `panopticon install --proxy`.

All pipelines feed a **unified sessions table** — each session accumulates data from whichever sources are active, in any order, via COALESCE upserts.

**Sync** (optional) — OTLP export that tails the local SQLite and POSTs merged events to a remote OTLP receiver. Useful for forwarding to Grafana, Honeycomb, Datadog, etc.

**Scanner** — Polls local CLI session files every 60 seconds. Extracts per-turn token usage and events that OTel misses (reasoning tokens, cache breakdowns, tool calls with arguments/output, API errors with retry metadata). Backfills historical sessions from before panopticon was installed.

## Daemon runtime

The installed daemon is one unified server process.

- The scanner loop starts first.
- Core sync and OTel sync loops start only after the scanner reports ready.
- Session-summary enrichment and legacy summary generation run from the
  scanner's idle path.
- Prune runs on startup and then hourly.
- Most loop bodies are still serial today: file parsing, touched-session
  rebuilds, legacy summary generation, and per-target sync advancement all
  happen one unit at a time. Session-summary enrichment now uses a bounded
  async runner pool.

For the full execution model, current invariants, and the planned
concurrency/workpooling follow-up, see
[docs/DAEMON-EXECUTION-MODEL.md](docs/DAEMON-EXECUTION-MODEL.md).

## Supported tools

| Tool | Hooks | OTel | Scanner | Proxy | Notes |
|------|-------|------|---------|-------|-------|
| Claude Code | Plugin marketplace | Native OTel SDK | `~/.claude/projects/` JSONL | Anthropic API | Full coverage; scanner captures API errors, file snapshots |
| Gemini CLI | `settings.json` hooks | Native OTel SDK (HTTP) | `~/.gemini/tmp/` JSON | Google AI API | Scanner captures tool calls, reasoning thoughts |
| Codex CLI | `hooks.json` | Native OTel SDK (HTTP) | `~/.codex/sessions/` JSONL | OpenAI API | Scanner captures tool calls, reasoning tokens, agent messages |
| Claude Desktop | MCP server | — | — | — | MCP query tools only |
| Pi | Extension (HTTP) | — | `~/.pi/agent/sessions/` JSONL | — | Extension and scanner capture hooks, normalized messages, assistant responses/tool calls/tokens when Pi exposes them; see [Pi coverage](docs/PI-COVERAGE.md) |
| Hermes Agent | User plugin (HTTP) | — | `~/.hermes/state.db` SQLite | — | Plugin captures native observer hooks with turn/API/tool correlation IDs; scanner backfills durable sessions and messages |

Each tool is implemented as a **target adapter** in `src/targets/`. To add support for a new tool, create a single adapter file that declares config paths, hook events, shell env vars, event normalization, detection logic, and proxy routing — then register it in `src/targets/index.ts`.

## MCP tools

Once installed, these tools are available to the AI coding tool via MCP:

Projection-backed summary views are gated by
`PANOPTICON_ENABLE_SESSION_SUMMARY_PROJECTIONS=1`. `why_code`,
`recent_work_on_path`, and `file_overview` remain available without that flag,
but they become much richer once projections are enabled.

| Tool | Description |
|------|-------------|
| `sessions` | List recent sessions with stats (tokens, cost, model, project) |
| `timeline` | Messages and tool calls for a session, including child sessions (forks, subagents) |
| `costs` | Token usage and cost breakdowns by session, model, or day |
| `summary` | Activity summary — sessions, prompts, tools, files, costs. Ideal for standup updates |
| `plans` | Plans created via ExitPlanMode with full markdown content |
| `search` | Full-text search across events and messages (FTS5) |
| `get` | Fetch full untruncated details for a record by source and ID |
| `query` | Raw read-only SQL against the database |
| `status` | Database row counts |
| `intent_for_code` | Chronological prompt history for a file, annotated with whether each edit's inserted content survived |
| `search_intent` | Search the prompt-to-edit index by prompt text, touched files, and landed ratio |
| `outcomes_for_intent` | Session-end outcome view for one intent: landed, churned, and unreconciled edits |
| `session_summaries` (gated) | Explicit session-derived summaries with provenance metadata, one row per session |
| `session_summary_detail` (gated) | Full detail for one session summary, including member intents and touched files |
| `why_code` | Best current local provenance explanation for a file path and optional line |
| `recent_work_on_path` | Recent local intents, edits, and summaries that touched a file |
| `file_overview` | File-centric overview with aggregate counts, best explanation, recent work, and related files |

## Agent command and skill

`panopticon install --target claude` installs a Claude Code `/panopticon`
command, and `panopticon install --target pi` installs a Pi `/panopticon`
prompt command. `panopticon install --target codex` installs a Codex
`$panopticon` skill. All accept command-style arguments and route read-only
queries to MCP tools when possible, falling back to the `panopticon` CLI for
lifecycle and maintenance operations.

The old `panopticon-review` and `pr-review` skills have moved to:

```text
/panopticon review
```

MCP tools that can return long histories are compact by default to keep agent
context bounded. `sessions`, `timeline`, `summary`, `search`,
`intent_for_code`, `search_intent`, `outcomes_for_intent`,
`session_summaries`, and `session_summary_detail` accept `fullPayloads: true`
when a caller needs the raw untruncated result. `get`, `query`, `costs`,
`plans`, `why_code`, `recent_work_on_path`, and `file_overview` already return
their direct result shapes.

## Context injection and code intelligence

Panopticon can proactively return bounded `additionalContext` from hooks instead
of waiting for the agent to call an MCP tool. These injections are deterministic
and provenance-backed; they stay silent when Panopticon has no relevant local
history.

| Surface | Flag | Default | Behavior |
|---------|------|---------|----------|
| Session start history | `PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION` | `1` | Adds recent local session history for the current cwd on `SessionStart` |
| Prompt-relevant history | `PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION` | `1` | Adds prompt-matched local history on mid-session `UserPromptSubmit`; the first prompt is intentionally silent |
| Edit-time file provenance | `PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION` | `1` | Adds file provenance before edit tools when the file has prior history; deduped once per session/path |
| Read-time file provenance | `PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION` | `1` | Adds short provenance before `Read` for files with prior history; deduped once per session/path |
| Code Review Graph enrichment | `PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW` | `0` | Adds `code_intel` to `file_overview` when the repo has `.code-review-graph/graph.db` |

Flags are read by the Panopticon server at startup. For a one-off test with
Code Review Graph enrichment:

```bash
panopticon stop
PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW=1 \
panopticon start --force
```

For persistent overrides, add the desired `export PANOPTICON_...` lines to the
same shell profile that launches your AI coding tool, then restart Panopticon
and start a new agent session.

### Employee rollout checklist

Use this checklist for canary users who should run all context intelligence
surfaces:

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

`doctor` and `status` should show the context flags, hook targets with source
identity, recent context-eligible hook activity, and Code Review Graph
readiness. Ask canary users to report missing context, noisy context, hook
latency, hook timeouts, and `code_intel` states other than `ready`.

To use Code Review Graph enrichment, install/build Code Review Graph in each
repo you want enriched:

```bash
pipx install code-review-graph   # or: pip install code-review-graph
cd /path/to/repo
code-review-graph build
code-review-graph status
```

Panopticon reads the repo-local `.code-review-graph/graph.db` directly. If the
graph is missing or stale, `file_overview` still works and reports
`code_intel.status: unavailable` or returns older graph-derived relationships.
Use `code-review-graph update` or `code-review-graph watch` to keep the graph
fresh. To expose Code Review Graph as its own MCP server, also run
`code-review-graph install`.

## Docs

- [Daemon execution model](docs/DAEMON-EXECUTION-MODEL.md) explains the current scanner/sync/summary/prune loop topology and the planned concurrency/workpooling follow-up.
- [Context injection and Code Review Graph](docs/CONTEXT-INTELLIGENCE.md) explains the proactive context flags, runtime semantics, and CRG setup.
- [Session summaries and code provenance](docs/LOCAL-WORKSTREAMS-V1.md) explains the local read model behind `why_code`, `recent_work_on_path`, `file_overview`, and the projection-backed session summary views.
- [Durable IDs and provenance foundation plan](docs/DURABLE-IDS-PLAN.md) captures the remaining repo/file provenance and evidence-ref follow-up work.
- [Inference interfaces](docs/INFERENCE-INTERFACES.md) defines the deterministic-fallback and optional-LLM contract for future enrichments.
- [Release validation runbook](docs/RELEASE-VALIDATION-RUNBOOK.md) covers validating changes against a copied production-sized DB and real home-directory config.
- [Pi coverage matrix and verification](docs/PI-COVERAGE.md) documents Pi hook, message, assistant response, token, scanner, headless, and limitation coverage with SQL verification queries.
- [Session summary split status](docs/SESSION-SUMMARY-SPLIT-STATUS.md) records the merged state of the session-summary split and the next post-merge harness tranche.

## CLI

```
panopticon install          Register hooks, init DB, configure shell
  --target <t>              Target: claude, gemini, codex, claude-desktop, pi, hermes, all (default: all)
  --proxy                   Route API traffic through the panopticon proxy
  --disable-sync            Disable remote sync and skip Git detection
  --force                   Overwrite customized env vars with defaults

panopticon uninstall        Remove hooks, shell config, and optionally all data
  --target <t>              Uninstall from a specific target only
  --purge                   Also remove database and all data

panopticon update           Show instructions to update via npm

panopticon start            Start the server (background)
  --force                   Bypass native start-failure backoff
panopticon stop             Stop the server
panopticon status           Show server status and database stats
panopticon doctor           Check system health, server, database, and configuration

panopticon logs [daemon]    View daemon logs (otlp, mcp)
  -f, --follow              Follow log output (like tail -f)
  -n <lines>                Number of lines to show (default 50)

panopticon sessions         List recent sessions with stats
  --limit <n>               Max sessions to return (default 20)
  --since <duration>        Time filter (e.g. "24h", "7d")
panopticon timeline <id>    Get messages and tool calls for a session
  --limit <n>               Max messages to return (default 50)
  --offset <n>              Number of messages to skip
  --full                    Return full content instead of truncated
panopticon costs            Token usage and cost breakdowns
  --group-by <g>            Group by session, model, or day
panopticon summary          Activity summary
panopticon plans            List plans from ExitPlanMode events
panopticon search <query>   Full-text search across events and messages
panopticon print <src> <id> Get full details for a record by source and ID
panopticon query <sql>      Raw read-only SQL query
panopticon db-stats         Show database row counts
panopticon storage          Read-only storage diagnostics
  --json                    Output as JSON
  --limit <n>               Max largest files and DB objects to show

panopticon sync enable            Enable remote sync
panopticon sync disable           Disable remote sync
panopticon sync add <name> <url>  Add or update a sync target
panopticon sync remove <name>     Remove a sync target
panopticon sync list              List sync targets
panopticon sync reset [target]    Reset sync watermarks (re-syncs all data)
panopticon sync watermark <target> [table]
  --set <value>                   Show or override a sync watermark

panopticon prune            Delete old data from the database
  --older-than 30d          Max age (default: 30d)
  --dry-run                 Show estimate without deleting
  --vacuum                  Reclaim disk space after pruning
  --yes                     Skip confirmation prompt

panopticon file overview <path>   Aggregate local provenance for a file
panopticon file why <path>        Best current explanation for a file or line
panopticon file recent <path>     Recent local history for a file

panopticon scan             Trigger a synchronous scan pass on the server
  --no-summaries            Skip summary generation during the scan

panopticon refresh-pricing  Fetch latest model pricing from LiteLLM
panopticon permissions show Show current approval rules
panopticon permissions preview Compute permission diff from JSON on stdin
panopticon permissions apply Apply permission rules (JSON from stdin)
```

The server auto-starts on `SessionStart` via hook, so manual start/stop is rarely needed.

## Logs

Daemon stdout/stderr is written to platform-specific log directories:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Logs/panopticon/` |
| Linux | `~/.local/state/panopticon/logs/` |
| Windows | `%LOCALAPPDATA%/panopticon/logs/` |

Log files: `server.log`, `otlp-receiver.log`, `mcp-server.log`, `proxy.log`, `hook-handler.log`. Daemon logs rotate before each native daemon spawn when they exceed the configured size.

## Configuration

**Environment variables** set by `panopticon install` in your shell profile:

- macOS/Linux: written into `~/.zshrc` or `~/.bashrc`, plus a dedicated
  `env.sh` in the panopticon data directory for non-interactive shells.
- Windows: written into both `~/Documents/PowerShell/Profile.ps1` and
  `~/Documents/WindowsPowerShell/Profile.ps1`, each of which sources
  `%APPDATA%/panopticon/env.ps1`. A companion `%APPDATA%/panopticon/env.cmd`
  is also written for manual `cmd.exe` use.

```bash
# Shared OTel (always set)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_LOG_TOOL_DETAILS=1
OTEL_LOG_USER_PROMPTS=1
OTEL_METRIC_EXPORT_INTERVAL=10000

# Target-specific (set per --target)
CLAUDE_CODE_ENABLE_TELEMETRY=1           # Claude Code
ANTHROPIC_BASE_URL=http://localhost:4318/proxy/anthropic  # Claude Code (--proxy only)
GEMINI_TELEMETRY_ENABLED=true            # Gemini CLI
GEMINI_TELEMETRY_TARGET=local            # Gemini CLI
GEMINI_TELEMETRY_OTLP_ENDPOINT=http://localhost:4318  # Gemini CLI
GEMINI_TELEMETRY_OTLP_PROTOCOL=http     # Gemini CLI
GEMINI_TELEMETRY_LOG_PROMPTS=true        # Gemini CLI
```

Target-specific env vars are declared by each target adapter in `src/targets/`.

**Server configuration:**

| Env var | Default | Description |
|---|---|---|
| `PANOPTICON_DATA_DIR` | Platform-specific (see below) | Data directory |
| `PANOPTICON_PORT` | `4318` | Unified server port |
| `PANOPTICON_HOST` | `127.0.0.1` | Server bind address |
| `PANOPTICON_LOG_LEVEL` | `info` | Minimum log level for daemon logs and `hook-handler.log` (`silly`, `trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `PANOPTICON_LOG_ROTATE_BYTES` | `10485760` | Rotate a daemon log before startup when it reaches this size; `0` disables rotation |
| `PANOPTICON_LOG_ROTATE_FILES` | `5` | Number of rotated daemon log files to keep; `0` disables rotation |
| `PANOPTICON_SERVER_START_BACKOFF_SCHEDULE_MS` | `5000,15000,30000,60000,120000,300000` | Consecutive native daemon start-failure delays before another spawn attempt |
| `PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION` | `1` | Enable recent-history `SessionStart` context injection |
| `PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION` | `1` | Enable prompt-relevant mid-session `UserPromptSubmit` context injection |
| `PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION` | `1` | Enable edit-time file provenance injection for supported `PreToolUse` edit tools |
| `PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION` | `1` | Enable read-time provenance injection for `PreToolUse` `Read` |
| `PANOPTICON_ENABLE_CODE_INTEL_FILE_OVERVIEW` | `0` | Enable Code Review Graph enrichment inside `file_overview` |

`hook-handler.log` now keeps server startup, warnings, and errors at the default `info` level. Per-event success-path lines are only written when `PANOPTICON_LOG_LEVEL=debug` (or lower).

Data directory defaults:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/panopticon/` |
| Linux | `~/.local/share/panopticon/` |
| Windows | `%APPDATA%/panopticon/` |

## Database

SQLite with WAL mode. Location depends on platform (see data directory above).

| Table | Description |
|-------|-------------|
| `sessions` | Unified session metadata — aggregated from hooks, OTel, and scanner |
| `messages` | Parsed messages (user, assistant, system) with token usage and DAG metadata |
| `tool_calls` | Tool invocations extracted from messages, with inputs, results, and durations |
| `otel_logs` | OTel log records (api_request, tool_result, user_prompt, etc.) |
| `otel_metrics` | OTel metric data points (token usage, cost, active time, etc.) |
| `otel_spans` | OTel trace spans |
| `hook_events` | Plugin hook events with full payloads (tool inputs/outputs, tool results) |
| `scanner_turns` | Per-turn token usage from session files (input, output, cache, reasoning) |
| `scanner_events` | Tool calls, errors, reasoning, file snapshots from session files |
| `scanner_file_watermarks` | Byte offsets for incremental session file parsing |
| `session_repositories` | Maps sessions to GitHub repositories |
| `session_cwds` | Maps sessions to working directories |
| `model_pricing` | Cached model pricing from LiteLLM |
| `watermarks` | Sync watermarks for OTLP export targets |
| `target_session_sync` | Per-target session sync state |

Query directly with `panopticon query` or via the `query` MCP tool.

## Development

```bash
pnpm install       # Install dependencies
pnpm dev           # Watch mode (tsup)
pnpm check         # Lint (Biome)
pnpm typecheck     # Type check
pnpm test          # Run tests (Vitest)
```

To test the full install flow:

```bash
pnpm build && npm pack
npm install -g ./fml-inc-panopticon-*.tgz
panopticon install --target claude
```

For release validation against a copied production-sized DB and real home
config, see `docs/RELEASE-VALIDATION-RUNBOOK.md`.

## Architecture

The code tree below is useful for orientation. For runtime loop ordering,
serialization boundaries, and the concurrency/workpooling roadmap, see
[docs/DAEMON-EXECUTION-MODEL.md](docs/DAEMON-EXECUTION-MODEL.md).

```
src/
├── cli.ts              CLI entry point (install, uninstall, start/stop, query commands)
├── server.ts           Unified HTTP server + scanner/sync/prune runtime bootstrap
├── sdk.ts              SDK shim (observe() wrapper)
├── config.ts           Panopticon paths, ports, defaults
├── setup.ts            Install/uninstall logic
├── log.ts              Log file paths (macOS/Linux/Windows)
├── repo.ts             Git repository detection
├── toml.ts             TOML read/write (for Codex config)
├── doctor.ts           System health checks
├── sentry.ts           Error reporting
├── eventConfig.ts      Event type configuration
├── unified-config.ts   Unified config management
├── api/
│   ├── client.ts       API client for CLI/MCP queries via server
│   ├── routes.ts       Server-side API route handlers
│   └── util.ts         API utilities
├── targets/
│   ├── types.ts        TargetAdapter interface (config, hooks, events, detect, proxy)
│   ├── registry.ts     Map-based target registry (register, get, all)
│   ├── index.ts        Barrel — re-exports + registers all built-in targets
│   ├── claude.ts       Claude Code adapter
│   ├── claude-desktop.ts Claude Desktop adapter
│   ├── gemini.ts       Gemini CLI adapter
│   ├── codex.ts        Codex CLI adapter
│   ├── pi.ts           Pi adapter
│   └── hermes.ts       Hermes Agent adapter
├── db/
│   ├── schema.ts       SQLite schema, migrations, WAL + auto-vacuum
│   ├── query.ts        Query helpers for MCP tools and CLI
│   ├── store.ts        Data storage (insert hooks, OTel, upsert sessions)
│   ├── prune.ts        Data retention / pruning
│   ├── sync-prune.ts   Sync-aware pruning
│   └── pricing.ts      Model pricing cache (LiteLLM)
├── scanner/
│   ├── index.ts        Public API (createScannerLoop, scanOnce)
│   ├── loop.ts         Scanner scheduler — discover, parse, archive, rebuild touched sessions
│   ├── reader.ts       Byte-offset file reader (only reads new lines)
│   ├── store.ts        Scanner DB operations (turns, events, watermarks, session upsert)
│   ├── reconcile.ts    Compare scanner vs hooks/OTLP token data per session
│   ├── reparse.ts      Re-parse session files from scratch
│   ├── categories.ts   Tool call categorization
│   └── types.ts        ScannerHandle, ScannerOptions
├── hooks/
│   ├── handler.ts      Hook event handler (stdin JSON → server)
│   ├── ingest.ts       Hook processing — uses target adapters for normalization
│   └── permissions.ts  PreToolUse permission enforcement
├── mcp/
│   ├── server.ts       MCP server with query tools
│   └── permissions.ts  Permission management MCP tools
├── otlp/
│   ├── server.ts       HTTP OTLP receiver (protobuf + JSON)
│   ├── decode-logs.ts  OTel log record decoding
│   ├── decode-metrics.ts OTel metric decoding
│   ├── decode-traces.ts OTel trace/span decoding
│   └── proto.ts        Protocol buffer definitions
├── sync/
│   ├── index.ts        Public API (createSyncLoop, resetWatermarks)
│   ├── types.ts        Interfaces (SyncTarget, SyncOptions, MergedEvent, OTLP types)
│   ├── config.ts       Sync target configuration
│   ├── registry.ts     Sync target registry
│   ├── loop.ts         Sync scheduler — core and OTel loop instances share this implementation
│   ├── reader.ts       Batch reads from SQLite + hook/OTLP dedup
│   ├── watermark.ts    Watermark persistence
│   └── post.ts         HTTP POST with retry + exponential backoff
├── summary/
│   ├── index.ts        Session summary public API
│   ├── llm.ts          Optional LLM summary/enrichment helpers
│   └── loop.ts         Legacy `sessions.summary` generation pass
├── archive/
│   ├── index.ts        Archive public API
│   ├── backend.ts      Archive backend interface
│   └── local.ts        Local filesystem archive
├── workspaces/
│   ├── index.ts        Workspace detection
│   ├── superset.ts     Workspace superset logic
│   └── types.ts        Workspace types
└── proxy/
    ├── server.ts       API proxy — routes built from target registry
    ├── emit.ts         Event emission from proxy captures
    ├── streaming.ts    SSE stream accumulation (Anthropic + OpenAI)
    ├── ws-capture.ts   WebSocket traffic capture
    ├── sessions.ts     Proxy session tracking
    └── formats/
        ├── types.ts      Format parser interface
        ├── anthropic.ts  Anthropic Messages API parser
        ├── openai.ts     OpenAI Chat Completions parser
        └── openai-responses.ts  OpenAI Responses API parser
```

### Target adapters

Each supported coding tool is a self-contained adapter in `src/targets/`. An adapter declares:

| Concern | What it specifies |
|---------|-------------------|
| **Config** | Directory, config file path, format (JSON/TOML) |
| **Hooks** | Event names, install-time config merge, uninstall cleanup |
| **Shell env** | Target-specific env vars for the shell profile / PowerShell profile |
| **Events** | Event name mapping to canonical types, payload normalization, permission response format |
| **Detection** | Display name, `isInstalled()`, `isConfigured()` for doctor |
| **Proxy** | Upstream host (static or dynamic), path rewriting, accumulator type |
| **Scanner** | `discover()` finds session files on disk, `parseFile()` extracts turns + events |

To add a new target, create `src/targets/<name>.ts`, implement `TargetAdapter`, call `registerTarget()`, and add the import to `src/targets/index.ts`. All consumers (install, uninstall, doctor, hooks, proxy, shell env, scanner) pick it up automatically.
