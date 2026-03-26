# Panopticon

<div align="center">
  <img src="panopticon.jpg" alt="Panopticon — Willey Reveley, 1791" width="480">
  <br>
  <em>Elevation and plan of Jeremy Bentham's Panopticon, drawn by Willey Reveley in 1791</em>
</div>

<br>

Self-contained observability for AI coding tools. Captures OpenTelemetry signals, hook events, and API traffic from Claude Code, Gemini CLI, and Codex CLI — stored in SQLite, queryable via MCP.

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
```

Options:

| Flag | Description |
|------|-------------|
| `--target <t>` | Target: `claude`, `gemini`, `codex`, `claude-desktop`, or `all` (default: `all`) |
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
│          Claude Code / Gemini CLI / Codex CLI                │
│                                                              │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────────┐  │
│  │ OTel SDK │     │ Plugin Hooks │     │ API requests     │  │
│  │          │     │              │     │ (--proxy mode)   │  │
│  └────┬─────┘     └──────┬───────┘     └────────┬─────────┘  │
└───────┼──────────────────┼──────────────────────┼────────────┘
        │                  │                      │
        ▼                  ▼                      ▼
┌──────────────────────────────────────────────────────────────┐
│              Unified Panopticon Server (:4318)               │
│                                                              │
│  /v1/logs, /v1/metrics   /hooks       /proxy/anthropic       │
│  (OTLP ingest)           (hook JSON)  /proxy/openai          │
│                                       /proxy/google          │
│                                       /proxy/codex           │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
          ┌─────────────────────────┐
          │    SQLite (WAL mode)    │
          │                         │
          │   (platform-specific    │
          │    data directory)      │
          └─────┬─────────────┬─────┘
                │             │
                ▼             ▼
       ┌────────────┐  ┌───────────────┐
       │ MCP Server │  │  Sync Loop    │
       │  (stdio)   │  │  (optional)   │
       │            │  │               │
       │ panopticon │  │ merge → OTLP  │
       │ query tools│  │ → remote POST │
       └────────────┘  └───────────────┘
```

**Four data pipelines feed one database:**

1. **Hook events** — Plugin hooks capture SessionStart, tool use (pre/post), prompts, and session end. Rich payloads including tool inputs and outputs.

2. **OTel logs** — Native telemetry events: API requests/responses, tool calls, user prompts, config, model routing. Includes cost, token counts, durations, model info.

3. **OTel metrics** — Time series: `token.usage`, `cost.usage`, `session.count`, `active_time.total`, `lines_of_code.count`, `commit.count`, `pull_request.count`.

4. **API proxy** — Transparent HTTP proxy for Anthropic, OpenAI, and Google AI APIs. Captures request/response pairs and emits them as hook events and OTel data. Enable with `panopticon install --proxy`.

All pipelines are correlated by `session_id`.

**Sync** (optional) — OTLP export that tails the local SQLite and POSTs merged events to a remote OTLP receiver. Useful for forwarding to Grafana, Honeycomb, Datadog, etc.

## Supported tools

| Tool | Hooks | OTel | Proxy | Notes |
|------|-------|------|-------|-------|
| Claude Code | Plugin marketplace | Native OTel SDK | Anthropic API | Full hook + OTel coverage |
| Gemini CLI | `settings.json` hooks | Native OTel SDK (HTTP) | Google AI API | All tool events via hooks; rich OTel (API latency, model routing, config) |
| Codex CLI | `hooks.json` | Native OTel SDK (HTTP) | OpenAI API | PreToolUse/PostToolUse require Codex 0.117+ |
| Claude Desktop | MCP server | — | — | MCP query tools only |

Each tool is implemented as a **target adapter** in `src/targets/`. To add support for a new tool, create a single adapter file that declares config paths, hook events, shell env vars, event normalization, detection logic, and proxy routing — then register it in `src/targets/index.ts`.

## MCP tools

Once installed, these tools are available to the AI coding tool via MCP:

| Tool | Description |
|------|-------------|
| `panopticon_sessions` | List recent sessions with stats (event count, tools used, cost) |
| `panopticon_session_timeline` | Chronological events for a session (hooks + OTel merged) |
| `panopticon_tool_stats` | Per-tool aggregates: call count, success/failure |
| `panopticon_costs` | Token/cost breakdowns by session, model, or day |
| `panopticon_summary` | Activity summary for a time window (sessions, prompts, tools, files, costs) |
| `panopticon_plans` | Plans created via ExitPlanMode with full markdown content |
| `panopticon_search` | Full-text search across hook payloads (FTS5) and OTel log bodies |
| `panopticon_get_event` | Fetch full untruncated details for a specific event by source and ID |
| `panopticon_query` | Raw read-only SQL against the database |
| `panopticon_status` | Database row counts |
| `panopticon_permissions_show` | Show current permission approvals and allowed tools/commands |
| `panopticon_permissions_apply` | Apply permission rules (allowed tools/commands via PreToolUse hook) |

## CLI

```
panopticon install          Register hooks, init DB, configure shell
  --target <t>              Target: claude, gemini, codex, claude-desktop, all (default: all)
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

panopticon logs [daemon]    View daemon logs (server, otlp, mcp, proxy)
  -f, --follow              Follow log output (like tail -f)
  -n <lines>                Number of lines to show (default 50)

panopticon sessions         List recent sessions with stats
  --limit <n>               Max sessions to return (default 20)
  --since <duration>        Time filter (e.g. "24h", "7d")
panopticon timeline <id>    Chronological events for a session
panopticon tools            Per-tool usage aggregates
panopticon costs            Token usage and cost breakdowns
  --group-by <g>            Group by session, model, or day
panopticon summary          Activity summary
panopticon plans            List plans from ExitPlanMode events
panopticon search <query>   Full-text search across all events
panopticon event <src> <id> Get full details for a specific event
panopticon query <sql>      Raw read-only SQL query
panopticon db-stats         Show database row counts

panopticon prune            Delete old data from the database
  --older-than 30d          Max age (default: 30d)
  --dry-run                 Show estimate without deleting
  --vacuum                  Reclaim disk space after pruning
  --yes                     Skip confirmation prompt

panopticon refresh-pricing  Fetch latest model pricing from OpenRouter
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

Log files: `server.log`, `mcp-server.log`, `hook-handler.log`, `proxy.log`.

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
| `otel_logs` | OTel log records (api_request, tool_result, user_prompt, etc.) |
| `otel_metrics` | OTel metric data points (token usage, cost, active time, etc.) |
| `hook_events` | Plugin hook events with full payloads (tool inputs/outputs, tool results) |
| `hook_events_fts` | FTS5 full-text search index on hook payloads |
| `session_repositories` | Maps sessions to GitHub repositories |
| `session_cwds` | Maps sessions to working directories |
| `model_pricing` | Cached model pricing from OpenRouter |
| `schema_meta` | Internal schema version tracking |

Query directly with `panopticon query` or via the `panopticon_query` MCP tool.

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
├── log.ts              Log file paths (macOS/Linux/Windows)
├── repo.ts             Git repository detection
├── toml.ts             TOML read/write (for Codex config)
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
│   ├── store.ts        Data storage (insert hooks, OTel, sessions)
│   ├── prune.ts        Data retention / pruning
│   └── pricing.ts      Model pricing cache (OpenRouter)
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
│   └── proto.ts        Protocol buffer definitions
├── sync/
│   ├── index.ts        Public API (createSyncLoop, resetWatermarks)
│   ├── types.ts        Interfaces (SyncTarget, SyncOptions, MergedEvent, OTLP types)
│   ├── loop.ts         Poll loop with debounced scheduling
│   ├── reader.ts       Batch reads from SQLite + hook/OTLP dedup
│   ├── serialize.ts    Convert rows → OTLP JSON (resourceLogs, resourceMetrics)
│   ├── watermark.ts    Watermark persistence (sync-watermarks.db)
│   └── post.ts         HTTP POST with retry + exponential backoff
└── proxy/
    ├── server.ts       API proxy — routes built from target registry
    ├── emit.ts         Event emission from proxy captures
    ├── streaming.ts    SSE stream accumulation (Anthropic + OpenAI)
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

To add a new target, create `src/targets/<name>.ts`, implement `TargetAdapter`, call `registerTarget()`, and add the import to `src/targets/index.ts`. All consumers (install, uninstall, doctor, hooks, proxy, shell env) pick it up automatically.
