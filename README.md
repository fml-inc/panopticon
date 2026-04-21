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
```

Options:

| Flag | Description |
|------|-------------|
| `--target <t>` | Target: `claude`, `gemini`, `codex`, `claude-desktop`, `pi`, or `all` (default: `all`) |
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
      ┌──────────┐ ┌──────────┐ ┌───────────┐
      │   MCP    │ │  Sync    │ │  Scanner  │
      │  Server  │ │  Loop    │ │  Loop     │
      │ (stdio)  │ │ (OTLP)  │ │ (60s poll)│
      └──────────┘ └──────────┘ └───────────┘
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

## Supported tools

| Tool | Hooks | OTel | Scanner | Proxy | Notes |
|------|-------|------|---------|-------|-------|
| Claude Code | Plugin marketplace | Native OTel SDK | `~/.claude/projects/` JSONL | Anthropic API | Full coverage; scanner captures API errors, file snapshots |
| Gemini CLI | `settings.json` hooks | Native OTel SDK (HTTP) | `~/.gemini/tmp/` JSON | Google AI API | Scanner captures tool calls, reasoning thoughts |
| Codex CLI | `hooks.json` | Native OTel SDK (HTTP) | `~/.codex/sessions/` JSONL | OpenAI API | Scanner captures tool calls, reasoning tokens, agent messages |
| Claude Desktop | MCP server | — | — | — | MCP query tools only |
| Pi | Extension (HTTP) | — | — | — | Extension emits hook events via fire-and-forget HTTP to panopticon server |

Each tool is implemented as a **target adapter** in `src/targets/`. To add support for a new tool, create a single adapter file that declares config paths, hook events, shell env vars, event normalization, detection logic, and proxy routing — then register it in `src/targets/index.ts`.

## MCP tools

Once installed, these tools are available to the AI coding tool via MCP:

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

## CLI

```
panopticon install          Register hooks, init DB, configure shell
  --target <t>              Target: claude, gemini, codex, claude-desktop, pi, all (default: all)
  --proxy                   Route API traffic through the panopticon proxy
  --force                   Overwrite customized env vars with defaults

panopticon uninstall        Remove hooks, shell config, and optionally all data
  --target <t>              Uninstall from a specific target only
  --purge                   Also remove database and all data

panopticon update           Show instructions to update via npm

panopticon start            Start the server (background)
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

panopticon sync add <name> <url>  Add or update a sync target
panopticon sync remove <name>     Remove a sync target
panopticon sync list              List sync targets
panopticon sync reset [target]    Reset sync watermarks (re-syncs all data)

panopticon prune            Delete old data from the database
  --older-than 30d          Max age (default: 30d)
  --dry-run                 Show estimate without deleting
  --vacuum                  Reclaim disk space after pruning
  --yes                     Skip confirmation prompt

panopticon refresh-pricing  Fetch latest model pricing from LiteLLM
panopticon permissions show Show current approval rules
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

Log files: `server.log`, `otlp-receiver.log`, `mcp-server.log`, `proxy.log`, `hook-handler.log`.

## Configuration

**Environment variables** set by `panopticon install` in your shell profile:

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

## Architecture

```
src/
├── cli.ts              CLI entry point (install, uninstall, start/stop, query commands)
├── server.ts           Unified HTTP server (hooks, OTLP, proxy — single port)
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
│   └── codex.ts        Codex CLI adapter
├── db/
│   ├── schema.ts       SQLite schema, migrations, WAL + auto-vacuum
│   ├── query.ts        Query helpers for MCP tools and CLI
│   ├── store.ts        Data storage (insert hooks, OTel, upsert sessions)
│   ├── prune.ts        Data retention / pruning
│   ├── sync-prune.ts   Sync-aware pruning
│   └── pricing.ts      Model pricing cache (LiteLLM)
├── scanner/
│   ├── index.ts        Public API (createScannerLoop, scanOnce)
│   ├── loop.ts         Poll loop — discovers files via target adapters, incremental parse
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
│   ├── loop.ts         Poll loop with debounced scheduling
│   ├── reader.ts       Batch reads from SQLite + hook/OTLP dedup
│   ├── watermark.ts    Watermark persistence
│   └── post.ts         HTTP POST with retry + exponential backoff
├── summary/
│   ├── index.ts        Session summary public API
│   ├── llm.ts          LLM-powered summary generation
│   └── loop.ts         Background summary generation loop
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
| **Shell env** | Target-specific env vars for the shell profile |
| **Events** | Event name mapping to canonical types, payload normalization, permission response format |
| **Detection** | Display name, `isInstalled()`, `isConfigured()` for doctor |
| **Proxy** | Upstream host (static or dynamic), path rewriting, accumulator type |
| **Scanner** | `discover()` finds session files on disk, `parseFile()` extracts turns + events |

To add a new target, create `src/targets/<name>.ts`, implement `TargetAdapter`, call `registerTarget()`, and add the import to `src/targets/index.ts`. All consumers (install, uninstall, doctor, hooks, proxy, shell env, scanner) pick it up automatically.
