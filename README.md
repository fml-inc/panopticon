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

### Quick install (requires repo access + `gh` CLI)

```bash
curl -fsSL https://raw.githubusercontent.com/fml-inc/panopticon/main/install.sh | bash
```

Clones to `~/.panopticon`, builds, and runs `panopticon install`. Re-run to update.

### As a dependency (e.g. from fml)

```bash
# .npmrc — add once per project
@fml-inc:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
pnpm add @fml-inc/panopticon
```

CI gets `GITHUB_TOKEN` automatically. Locally, add `export GITHUB_TOKEN=$(gh auth token)` to your shell profile.

### From source

```bash
git clone https://github.com/fml-inc/panopticon.git && cd panopticon
pnpm install
panopticon install
```

This builds the project, registers it as a Claude Code plugin, initializes the database, symlinks the CLI to `~/.local/bin`, and configures OTel environment variables in your shell. Start a new Claude Code session to activate.

Options:

| Flag | Description |
|------|-------------|
| `--target <t>` | Target CLI: any registered vendor id (e.g. `claude`, `gemini`, `codex`) or `all` (default: `all`) |
| `--proxy` | Route API traffic through the panopticon proxy |
| `--desktop` | Install as MCP server for Claude Desktop instead |
| `--force` | Overwrite customized env vars with defaults |

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│       Claude Code / Gemini CLI / Codex CLI / Pi Agent        │
│                                                              │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────────┐  │
│  │ OTel SDK │     │ Plugin Hooks │     │ API requests     │  │
│  │          │     │ (hooks.json) │     │ (--proxy mode)   │  │
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
│                                       /proxy/codex (ws)      │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
          ┌─────────────────────────┐
          │    SQLite (WAL mode)    │
          │  ~/.local/share/        │
          │    panopticon/data.db   │
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

1. **Hook events** — Plugin hooks capture SessionStart, tool use (pre/post), prompts, subagent lifecycle, and session end. Rich payloads including tool inputs and outputs.

2. **OTel logs** — Native telemetry events: `user_prompt`, `api_request`, `tool_result`, `tool_decision`, `api_error`. Includes cost, token counts, durations, model info.

3. **OTel metrics** — Time series: `token.usage`, `cost.usage`, `session.count`, `active_time.total`, `lines_of_code.count`, `commit.count`, `pull_request.count`.

4. **API proxy** — Transparent HTTP/WebSocket proxy for Anthropic, OpenAI, Google AI, and Codex APIs. Captures request/response pairs and emits them as hook events and OTel data. Enable with `panopticon install --proxy`.

All pipelines are correlated by `session_id`.

5. **Sync** — Optional OTLP export that tails the local SQLite and POSTs merged events to a remote OTLP receiver. Merges hook events with their OTLP counterparts at sync time to produce unified records. Enable via the `@fml-inc/panopticon/sync` API.

## Supported tools

| Tool | Hooks | OTel | Proxy |
|------|-------|------|-------|
| Claude Code | Plugin hooks via `hooks.json` | Native OTel SDK | Anthropic API |
| Gemini CLI | Hooks via `settings.json` | Native OTel SDK | — |
| Codex CLI | Hooks via `config.toml` | — | WebSocket proxy |
| Pi | Extension events via `@panopticon/pi-extension` | — | Anthropic, OpenAI, Google AI |

Each CLI tool is implemented as a **vendor adapter** in `src/vendors/`. To add support for a new tool, create a single adapter file that declares the tool's config paths, hook events, shell env vars, event normalization rules, detection logic, and proxy routing — then register it in `src/vendors/index.ts`. See [Architecture](#architecture) for details.

## MCP tools

Once the plugin is loaded, these tools are available to Claude:

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
panopticon install          Build, register plugin, init DB, configure shell
  --target <t>              Target CLI: any vendor id or all (default: all)
  --proxy                   Route API traffic through the panopticon proxy
  --desktop                 Install as MCP server for Claude Desktop
  --force                   Overwrite customized env vars with defaults

panopticon start            Start the server (background)
panopticon stop             Stop the server
panopticon status           Show server status and database stats

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

## SDK

For programmatic use with the Claude Agent SDK:

```js
import { query } from "@anthropic-ai/claude-agent-sdk";
import { observe } from "@fml-inc/panopticon/sdk";

for await (const msg of observe(query({ prompt: "..." }))) {
  // use msg normally — panopticon captures everything in the background
}
```

Requires a running panopticon server.

## Sync

Export telemetry from the local SQLite to any remote OTLP receiver. Useful for syncing sandbox/VM agent data to a central instance, or forwarding to Grafana, Honeycomb, Datadog, etc.

```js
import { createSyncLoop } from "@fml-inc/panopticon/sync";

const sync = createSyncLoop({
  targets: [{
    name: "central",
    url: "https://otlp.example.com",
    token: "my-bearer-token",
  }],
  filter: { includeRepos: ["my-org/*"] },
});

sync.start();
// sync.stop() to shut down
```

The sync loop:
- Tails `hook_events`, `otel_logs`, and `otel_metrics` tables using watermarks
- Merges hook events with their OTLP counterparts at sync time (e.g. `UserPromptSubmit` hook + `claude_code.user_prompt` OTLP log → one unified OTLP log record)
- Serializes everything as standard OTLP JSON and POSTs to `{url}/v1/logs` and `{url}/v1/metrics`
- Retries with exponential backoff; catches up at 1s intervals, idles at 30s
- Watermarks stored in `{dataDir}/sync-watermarks.db` (separate from main data.db)

## Integrations

### Pi coding agent

A Pi extension that sends session events to the local Panopticon server, giving Pi the same telemetry depth as Claude Code and Gemini CLI.

```bash
pi install /path/to/panopticon/integrations/pi
```

Captures: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionEnd`. Fire-and-forget — never blocks the agent.

See [`integrations/pi/`](integrations/pi/) for details.

## Logs

Daemon stdout/stderr is written to platform-specific log directories:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Logs/panopticon/` |
| Linux | `~/.local/state/panopticon/logs/` |
| Windows | `%LOCALAPPDATA%/panopticon/logs/` |

Log files: `server.log`, `otlp-receiver.log`, `mcp-server.log`, `proxy.log`.

On macOS these are also visible in Console.app.

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

# Vendor-specific (set per --target)
CLAUDE_CODE_ENABLE_TELEMETRY=1           # Claude Code
ANTHROPIC_BASE_URL=http://localhost:4318/proxy/anthropic  # Claude Code (--proxy)
GEMINI_TELEMETRY_ENABLED=true            # Gemini CLI
GEMINI_TELEMETRY_TARGET=local            # Gemini CLI
GEMINI_TELEMETRY_USE_COLLECTOR=true      # Gemini CLI
GEMINI_TELEMETRY_OTLP_ENDPOINT=http://localhost:4318  # Gemini CLI
GEMINI_TELEMETRY_OTLP_PROTOCOL=http     # Gemini CLI
GEMINI_TELEMETRY_LOG_PROMPTS=true        # Gemini CLI
```

Vendor-specific env vars are declared by each vendor adapter in `src/vendors/`. New vendors can add their own vars without modifying the shell env configuration logic.

**Server configuration:**

| Env var | Default | Description |
|---|---|---|
| `PANOPTICON_DATA_DIR` | `~/.local/share/panopticon` | Data directory |
| `PANOPTICON_PORT` | `4318` | Unified server port |
| `PANOPTICON_HOST` | `127.0.0.1` | Server bind address |

## Database

SQLite with WAL mode at `~/.local/share/panopticon/data.db`.

| Table | Description |
|-------|-------------|
| `otel_logs` | OTel log records (api_request, tool_result, user_prompt, etc.) |
| `otel_metrics` | OTel metric data points (token usage, cost, active time, etc.) |
| `hook_events` | Plugin hook events with full payloads (tool inputs/outputs) |
| `hook_events_fts` | FTS5 full-text search index on hook payloads |
| `session_repositories` | Maps sessions to GitHub repositories |
| `session_cwds` | Maps sessions to working directories |
| `model_pricing` | Cached model pricing from OpenRouter |
| `schema_meta` | Internal schema version tracking |

Query directly:

```bash
sqlite3 ~/.local/share/panopticon/data.db "SELECT count(*) FROM hook_events"
```

Or ask Claude — it has the `panopticon_query` MCP tool for ad-hoc SQL.

## Development

```bash
pnpm install       # Install dependencies
pnpm dev           # Watch mode (tsup)
pnpm check         # Lint (Biome)
pnpm typecheck     # Type check
pnpm test          # Run tests (Vitest)
panopticon install # Rebuild and update plugin cache
```

Pre-commit hooks (via lefthook) run Biome formatting and type checking automatically.

After rebuilding, run `panopticon install` to sync changes to the plugin cache. Restart Claude Code to pick up the changes.

## Architecture

```
src/
├── cli.ts              CLI entry point (install, start/stop, query commands)
├── server.ts           Unified HTTP server (hooks, OTLP, proxy — single port)
├── sdk.ts              Claude Agent SDK shim (observe() wrapper)
├── config.ts           Panopticon paths, ports, defaults
├── log.ts              Log file paths (macOS/Linux/Windows)
├── repo.ts             Git repository detection
├── toml.ts             TOML read/write (for Codex config)
├── vendors/
│   ├── types.ts        VendorAdapter interface (config, hooks, events, detect, proxy)
│   ├── registry.ts     Map-based vendor registry (register, get, all)
│   ├── index.ts        Barrel — re-exports + registers all built-in vendors
│   ├── claude.ts       Claude Code adapter
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
│   ├── ingest.ts       Hook processing — uses vendor adapters for normalization
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
│   ├── reader.ts       Batch reads from SQLite + hook↔OTLP merge SQL
│   ├── serialize.ts    Convert rows → OTLP JSON (resourceLogs, resourceMetrics)
│   ├── watermark.ts    Watermark persistence (sync-watermarks.db)
│   └── post.ts         HTTP POST with retry + exponential backoff
├── proxy/
│   ├── server.ts       API proxy — routes built from vendor registry
│   ├── emit.ts         Event emission from proxy captures
│   ├── streaming.ts    SSE stream accumulation (Anthropic + OpenAI)
│   ├── ws-capture.ts   WebSocket message capture (Codex)
│   ├── sessions.ts     Proxy session tracking
│   └── formats/
│       ├── types.ts      Format parser interface
│       ├── anthropic.ts  Anthropic Messages API parser
│       ├── openai.ts     OpenAI Chat Completions parser
│       └── openai-responses.ts  OpenAI Responses API parser
integrations/
└── pi/
    ├── index.ts        Pi coding agent extension
    └── package.json    Pi package manifest
```

### Vendor adapters

Each supported coding tool is a self-contained adapter in `src/vendors/`. An adapter declares:

| Concern | What it specifies |
|---------|-------------------|
| **Config** | Directory, config file path, format (JSON/TOML) |
| **Hooks** | Event names, install-time config merge (`applyInstallConfig`) |
| **Shell env** | Vendor-specific env vars for the shell profile |
| **Events** | Event name mapping to canonical types, payload normalization, permission response format |
| **Detection** | Display name, `isInstalled()`, `isConfigured()` for doctor |
| **Proxy** | Upstream host (static or dynamic), path rewriting, accumulator type |

To add a new vendor, create `src/vendors/<name>.ts`, implement `VendorAdapter`, call `registerVendor()`, and add the import to `src/vendors/index.ts`. All consumers (install, doctor, hooks, proxy, shell env) pick it up automatically.
