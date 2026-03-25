# OpenClaw + Panopticon + Grafana

End-to-end observability for [OpenClaw](https://openclaw.ai) with [Kimi](https://platform.moonshot.ai) (Moonshot AI). Three Docker containers — OpenClaw, Panopticon, and Grafana — wired together so you can see every API call, tool execution, and token spent.

## What you get

```
┌──────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway (:18789)                    │
│                                                              │
│  Kimi K2.5 (Moonshot AI)    diagnostics-otel plugin          │
│  ────────────────────────   ────────────────────────          │
│  API calls to Kimi          OTel traces, metrics, logs       │
└──────────┬──────────────────────────────┬────────────────────┘
           │                              │
           │  (future: proxy capture)     │  OTLP http/protobuf
           │                              │
           ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│                  Panopticon Server (:4318)                    │
│                                                              │
│  SQLite: hook_events, otel_logs, otel_metrics                │
│                          │                                   │
│                    sync loop (OTLP JSON)                     │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                  Grafana OTEL LGTM (:3001)                   │
│                                                              │
│  Loki (logs)  ·  Mimir (metrics)  ·  Tempo (traces)         │
│                                                              │
│  Dashboard: API calls, tokens, tools, prompts, latency       │
└──────────────────────────────────────────────────────────────┘
```

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

The script builds panopticon from source, starts all three containers, configures OpenClaw's diagnostics plugin, and provisions a Grafana dashboard.

## Services

| Service | URL | Description |
|---------|-----|-------------|
| OpenClaw | http://localhost:18789 | Web UI — send prompts here |
| Panopticon | http://localhost:4318/health | OTLP receiver + hooks + proxy |
| Grafana | http://localhost:3001 | Dashboard (admin / admin) |

## What gets captured

OpenClaw's built-in `diagnostics-otel` plugin sends telemetry to Panopticon via OTLP:

| Signal | Data |
|--------|------|
| Metrics | Token usage, cost, context size, run duration |
| Traces | Model call spans, tool execution spans |
| Logs | Agent lifecycle events, errors |

Panopticon stores everything in SQLite, then syncs to Grafana's OTLP collector for visualization.

## Dashboard panels

| Panel | Shows |
|-------|-------|
| API Calls Over Time | Request volume by model (stacked time series) |
| Token Usage by Type | Input/output tokens by model |
| Tool Calls | Tool call frequency (bar chart) |
| Events by Type | Event distribution (pie chart) |
| Recent Prompts | Last 50 user prompts with timestamps |

## Manual setup

If you prefer to do it step by step instead of using `setup.sh`:

```bash
# Build panopticon
npx tsup

# Start containers
docker compose -f examples/openclaw/docker-compose.yml up -d --build

# Configure OpenClaw (exec into container)
docker exec openclaw openclaw config set diagnostics.otel.enabled true
docker exec openclaw openclaw config set diagnostics.otel.endpoint http://panopticon:4318

# Check panopticon is receiving data
curl http://localhost:4318/health
```

## Using a different model

Kimi (Moonshot AI) is configured by default, but OpenClaw supports any OpenAI-compatible provider. To use a different model, modify the OpenClaw config inside the container:

```bash
# Example: use OpenAI GPT-4o instead
docker exec openclaw openclaw models set openai/gpt-4o
```

Set the corresponding API key in your `.env` file (e.g., `OPENAI_API_KEY`).

## Teardown

```bash
docker compose -f examples/openclaw/docker-compose.yml down -v
```

The `-v` flag removes volumes (config, workspace, panopticon data). Omit it to keep data across restarts.

## Notes

- The "Recent Prompts" dashboard panel shows user prompts in plain text. If sharing Grafana access, consider removing this panel.
- OpenClaw's `diagnostics-otel` plugin follows [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), so the data works with any GenAI-aware observability backend.
- Kimi's API is fully OpenAI-compatible — same `/v1/chat/completions` endpoint. No custom parser needed in panopticon.
