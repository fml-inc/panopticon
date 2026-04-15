# OpenClaw + Panopticon

Capture every API call, tool execution, and token spent by an [OpenClaw](https://openclaw.ai) agent (running [Kimi](https://platform.moonshot.ai)) into [Panopticon](../..)'s local database. Two Docker containers, OpenClaw's `diagnostics-otel` plugin emitting OTLP straight at panopticon.

## What you get

```
┌──────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway (:18789)                    │
│                                                              │
│  Kimi K2.5 (Moonshot AI)    diagnostics-otel plugin          │
│  ────────────────────────   ────────────────────────          │
│  API calls to Kimi          OTel traces, metrics, logs       │
└──────────────────────────────────────┬───────────────────────┘
                                       │  OTLP http/protobuf
                                       ▼
┌──────────────────────────────────────────────────────────────┐
│                  Panopticon Server (:4318)                    │
│                                                              │
│  SQLite: hook_events, otel_logs, otel_metrics, otel_spans    │
│                                                              │
│  Query via:                                                  │
│    docker exec panopticon panopticon query '...'             │
│    docker exec panopticon panopticon mcp                     │
└──────────────────────────────────────────────────────────────┘
```

For visualization, see [`examples/grafana/`](../grafana/) (separate setup).

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2)
- Moonshot AI API key — get one at [platform.moonshot.ai](https://platform.moonshot.ai)

## Quick start

```bash
# 1. Configure your API key
cp .env.example .env
# Edit .env and set MOONSHOT_API_KEY

# 2. Run the setup script
./examples/openclaw/setup.sh
```

The script builds panopticon from source, starts both containers, configures OpenClaw's `diagnostics-otel` plugin, and restarts OpenClaw so it picks up the plugin.

## Services

| Service | URL | Description |
|---------|-----|-------------|
| OpenClaw | http://localhost:18789 | Web UI — send prompts here |
| Panopticon | http://localhost:4318/health | OTLP receiver + hooks + proxy |

## What gets captured

OpenClaw's built-in `diagnostics-otel` plugin (per [OpenClaw logging docs](https://docs.openclaw.ai/logging)) sends three signal types over OTLP/HTTP:

| Signal | Examples |
|--------|----------|
| Metrics | `openclaw.tokens` (input/output/cache_read/cache_write), `openclaw.cost.usd`, `openclaw.run.duration_ms`, `openclaw.context.tokens` |
| Traces | `openclaw.model.usage`, `openclaw.message.processed`, `openclaw.webhook.processed` |
| Logs | Agent lifecycle events, errors |

Panopticon stores everything in SQLite under `/data` (volume `panopticon-data`).

## Querying the data

```bash
# Recent token-usage metrics
docker exec panopticon node /app/bin/panopticon query \
  "SELECT name, json_extract(attributes, '$.\"openclaw.token\"') AS token_type,
          json_extract(attributes, '$.\"openclaw.model\"') AS model, value
   FROM otel_metrics
   WHERE name = 'openclaw.tokens'
   ORDER BY id DESC LIMIT 20"

# Recent model-call spans
docker exec panopticon node /app/bin/panopticon query \
  "SELECT name, attributes FROM otel_spans
   WHERE name = 'openclaw.model.usage'
   ORDER BY id DESC LIMIT 10"
```

## Manual setup

If you prefer to skip `setup.sh`:

```bash
# Build panopticon
npx tsup

# Start the stack
docker compose -f examples/openclaw/docker-compose.yml up -d --build

# Configure OpenClaw — see setup.sh step 5 for the JSON to write into
# /home/node/.openclaw/openclaw.json inside the openclaw container.
# After writing, restart openclaw to load the diagnostics-otel plugin:
docker compose -f examples/openclaw/docker-compose.yml restart openclaw

# Verify panopticon is receiving data
curl http://localhost:4318/health
```

## Using a different model

Kimi (Moonshot AI) is the default. To use a different OpenAI-compatible provider, edit `~/.openclaw/openclaw.json` inside the container — change `agents.defaults.model.primary` and add the provider under `models.providers`. Set the corresponding API key in `.env`.

## Teardown

```bash
docker compose -f examples/openclaw/docker-compose.yml down -v
```

The `-v` flag removes volumes (config, workspace, panopticon data). Omit it to keep data across restarts.

## Notes

- The captured token-usage metrics are tagged with `openclaw.token` (which type — input, output, cache_read, cache_write, total) and `openclaw.model`. Panopticon's adapter (`src/targets/openclaw.ts`) declares these so derived metrics aggregate correctly.
- OpenClaw's `diagnostics-otel` plugin uses the openclaw-specific attribute namespace (`openclaw.*`) rather than GenAI semconv — see [docs.openclaw.ai/logging](https://docs.openclaw.ai/logging) for the full attribute list.
