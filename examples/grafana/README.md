# Grafana Dashboard for Panopticon

Visualize your AI coding tool usage — API calls, token consumption, tool usage, prompts, and errors — in Grafana via the Panopticon sync module.

## What you get

A pre-built dashboard with 8 panels:

| Panel | Type | Shows |
|-------|------|-------|
| API Calls Over Time | Time series | Request volume by model (stacked) |
| Token Usage by Type | Time series | Input/output tokens by model |
| Tool Calls | Bar chart | Tool call frequency (horizontal bars) |
| Events by Type | Pie chart | SessionStart, PreToolUse, PostToolUse, etc. |
| API Calls by Model | Pie chart | Model distribution |
| Recent Prompts | Log viewer | Last 50 user prompts with timestamps |
| Tool Failures | Time series | PostToolUseFailure events by tool |
| API Latency | Time series | Average response time in ms |

## Prerequisites

- Docker (for the Grafana OTEL LGTM stack)
- Panopticon installed and running (`panopticon install && panopticon start`)

## Quick start

```bash
# One command — starts Grafana, waits for it, provisions the dashboard, and configures sync
./examples/grafana/setup.sh
```

Then restart panopticon to start syncing:

```bash
panopticon stop && panopticon start
```

Open http://localhost:3001/d/panopticon-main (admin / admin).

## Manual setup

If you prefer to do it step by step:

```bash
# 1. Start the Grafana OTEL LGTM stack (Grafana + Loki + Tempo + Mimir + OTLP collector)
docker compose -f examples/grafana/docker-compose.yml up -d

# 2. Wait for Grafana to be ready
curl -sf http://localhost:3001/api/health

# 3. Add a sync target pointing at the OTLP collector
panopticon sync add local-grafana http://localhost:14318

# 4. Restart panopticon to start syncing
panopticon stop && panopticon start

# 5. Verify sync is running
panopticon status
```

The sync module tails the local SQLite database and POSTs merged OTLP records to the Grafana collector every 1-30 seconds. Existing data will backfill automatically.

## Architecture

```
Claude Code / Gemini CLI / Codex CLI
        │
        ▼
   Panopticon (SQLite)
        │
        │ sync loop (OTLP JSON)
        ▼
   OTLP Collector (:14318)
        │
        ├─→ Loki (logs — hook events, API requests)
        ├─→ Mimir (metrics — token usage, cost)
        └─→ Tempo (traces — not used yet)
        │
        ▼
   Grafana (:3001)
```

## Ports

| Port | Service |
|------|---------|
| 3001 | Grafana UI |
| 14318 | OTLP HTTP receiver |

## Teardown

```bash
docker compose -f examples/grafana/docker-compose.yml down
panopticon sync remove local-grafana
```

## Notes

- The "Recent Prompts" panel shows user prompts in plain text. If your Grafana instance is shared, consider removing this panel or restricting access.
- Sync is additive — removing the sync target doesn't delete data already in Grafana.
- The sync module uses watermarks to track progress. If you need to re-sync from scratch: stop panopticon, delete `sync-watermarks.db` from the data directory, restart.
