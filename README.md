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
git clone <repo-url> && cd panopticon
npm install
node bin/panopticon install
```

This builds the project, registers it as a Claude Code plugin, initializes the database, and configures OTel environment variables in your shell. Start a new Claude Code session to activate.

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
| `panopticon_search` | Text search across all event payloads and attributes |
| `panopticon_query` | Raw read-only SQL against the database |
| `panopticon_status` | Database row counts |

## CLI

```bash
panopticon install   # Build, register plugin, init DB, configure shell
panopticon start     # Start OTLP receiver (background)
panopticon stop      # Stop OTLP receiver
panopticon status    # Show receiver status and DB stats
```

The OTLP receiver auto-starts on `SessionStart` via hook, so manual start/stop is rarely needed.

## Environment variables

Set by `panopticon install` in your shell profile:

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
npx tsup          # Build
npx tsup --watch  # Watch mode
node bin/panopticon install  # Rebuild and update plugin cache
```

After rebuilding, run `node bin/panopticon install` to sync changes to the plugin cache. Restart Claude Code to pick up the changes.
