# Panopticon

<div align="center">
  <img src="panopticon.jpg" alt="Panopticon — Willey Reveley, 1791" width="480">
  <br>
  <em>Elevation and plan of Jeremy Bentham's Panopticon, drawn by Willey Reveley in 1791</em>
</div>

<br>

Self-contained observability for Claude Code. Captures native OpenTelemetry signals and hook events to SQLite, queryable via MCP from within Claude Code itself.

No Docker, no external services. Just Node.js.

## Install

```bash
git clone https://github.com/fml-inc/panopticon.git && cd panopticon
pnpm install
panopticon install
```

This builds the project, registers it as a Claude Code plugin, initializes the database, symlinks the CLI to `~/.local/bin`, and configures OTel environment variables in your shell. Start a new Claude Code session to activate.

Use `panopticon install --force` to overwrite customized environment variables with defaults.

## How it works

```
┌─────────────────────────────────────────────────┐
│                  Claude Code                     │
│                                                  │
│  ┌──────────┐           ┌──────────────┐         │
│  │ OTel SDK │ HTTP/     │ Plugin Hooks │ stdin   │
│  │          │ protobuf  │ (hooks.json) │ JSON    │
│  └────┬─────┘           └──────┬───────┘         │
└───────┼────────────────────────┼─────────────────┘
        │                        │
        ▼                        ▼
┌───────────────┐      ┌─────────────────┐
│ OTLP Receiver │      │  Hook Handler   │
│ :4318         │      │  (bin/hook)     │
│ /v1/logs      │      │                 │
│ /v1/metrics   │      │                 │
└───────┬───────┘      └────────┬────────┘
        │                       │
        ▼                       ▼
┌─────────────────────────────────────┐
│           SQLite (WAL mode)         │
│  ~/.local/share/panopticon/data.db  │
│                                     │
│  otel_logs | otel_metrics | hooks   │
└──────────────────┬──────────────────┘
                   │
                   ▼
          ┌────────────────┐
          │   MCP Server   │
          │   (stdio)      │
          │                │
          │ panopticon_*   │
          │ query tools    │
          └────────────────┘
```

**Three data pipelines feed one database:**

1. **Hook events** — Plugin hooks capture SessionStart, tool use (pre/post), prompts, subagent lifecycle, and session end. Rich payloads including tool inputs and outputs.

2. **OTel logs** — Native Claude Code events: `user_prompt`, `api_request`, `tool_result`, `tool_decision`, `api_error`. Includes cost, token counts, durations, model info.

3. **OTel metrics** — Time series: `token.usage`, `cost.usage`, `session.count`, `active_time.total`, `lines_of_code.count`, `commit.count`, `pull_request.count`.

All three are correlated by `session_id`.

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

## CLI

```
panopticon install          Build, register plugin, init DB, configure shell
  --force                   Overwrite customized env vars with defaults
panopticon start            Start the OTLP receiver (background)
panopticon stop             Stop the OTLP receiver
panopticon status           Show receiver/sync status, DB stats, watermarks
panopticon prune            Delete old data from the database
  --older-than 30d            Max age (default: 30d)
  --synced-only               Only delete rows already synced
  --dry-run                   Show estimate without deleting
  --vacuum                    Reclaim disk space after pruning
  --yes                       Skip confirmation prompt
panopticon sync setup       Configure sync targets (interactive)
panopticon sync start       Start the sync daemon (background)
panopticon sync stop        Stop the sync daemon
panopticon sync status      Show per-target sync progress and watermarks
panopticon sync reset [t]   Reset sync watermarks (all or per-target)
```

The OTLP receiver auto-starts on `SessionStart` via hook, so manual start/stop is rarely needed.

## Sync

The sync daemon pushes local data to one or more remote backends. Run `panopticon sync setup` to configure interactively.

Config lives at `~/.local/share/panopticon/sync.json`:

```json
{
  "backendType": "fml",
  "targets": [
    { "name": "prod", "url": "https://api.example.com" }
  ],
  "allowedOrgs": ["my-org"],
  "orgDirs": { "/Users/me/work/my-org": "my-org" },
  "batchSize": 20,
  "intervalMs": 30000
}
```

- **backendType** — `"fml"` (default) posts to FML Convex endpoints. `"otlp"` posts logs and metrics in standard OTLP wire format (`/v1/logs`, `/v1/metrics`).
- **targets** — Multiple backends with independent per-table watermarks.
- **allowedOrgs** — Only sync data from these GitHub orgs. Use `"*"` for all. Empty list = sync nothing (fail-closed).
- **orgDirs** — Map local directories to org names for non-git workspaces.

Authentication uses a GitHub token via `PANOPTICON_GITHUB_TOKEN` or `gh auth token`.

## Configuration

**Environment variables** set by `panopticon install` in your shell profile:

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1           # Required to enable OTel
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_LOG_TOOL_DETAILS=1                  # Include MCP/skill names in events
OTEL_LOG_USER_PROMPTS=1                  # Include prompt content in events
OTEL_METRIC_EXPORT_INTERVAL=10000        # Flush metrics every 10s
```

**Server configuration:**

| Env var | Default | Description |
|---|---|---|
| `PANOPTICON_DATA_DIR` | `~/.local/share/panopticon` | Data directory |
| `PANOPTICON_OTLP_PORT` | `4318` | OTLP receiver port |
| `PANOPTICON_OTLP_HOST` | `0.0.0.0` | OTLP receiver bind address |
| `PANOPTICON_GITHUB_TOKEN` | — | GitHub token for sync authentication |

## Database

SQLite with WAL mode at `~/.local/share/panopticon/data.db`. Three tables:

- `otel_logs` — OTel log records (api_request, tool_result, user_prompt, etc.)
- `otel_metrics` — OTel metric data points (token usage, cost, active time, etc.)
- `hook_events` — Plugin hook events with full payloads (tool inputs/outputs)

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
panopticon install # Rebuild and update plugin cache
```

Pre-commit hooks (via lefthook) run Biome formatting and type checking automatically.

After rebuilding, run `panopticon install` to sync changes to the plugin cache. Restart Claude Code to pick up the changes.

## Architecture

```
src/
├── cli.ts              CLI entry point (install, start/stop, prune, sync)
├── config.ts           Paths, ports, defaults
├── db/
│   ├── schema.ts       SQLite schema, migrations, WAL + incremental auto-vacuum
│   ├── query.ts        Query helpers for MCP tools
│   └── prune.ts        Data retention / pruning
├── hooks/
│   └── handler.ts      Hook event ingestion (stdin JSON → gzipped SQLite)
├── mcp/
│   └── server.ts       MCP server with query tools
├── otlp/
│   └── server.ts       HTTP OTLP receiver (protobuf + JSON)
└── sync/
    ├── daemon.ts        Background sync loop (multi-target, FML + OTLP backends)
    ├── client.ts        HTTP client, batching, GitHub auth
    ├── mapper.ts        DB rows → API payloads
    └── state.ts         Per-target watermark persistence
```
