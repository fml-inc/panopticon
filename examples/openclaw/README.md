# OpenClaw + Panopticon

Capture every API call, tool execution, and token spent by an [OpenClaw](https://openclaw.ai) agent into [Panopticon](../..)'s local database. Multi-provider (Moonshot + Anthropic) — OpenClaw routes each provider through panopticon's proxy for full request/response capture AND emits OTel telemetry from its `diagnostics-otel` plugin.

## What you get

```
┌──────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway (:18789)                    │
│                                                              │
│  Kimi + Claude            diagnostics-otel plugin            │
│  ────────────────────     ────────────────────────           │
│  baseUrls rewritten to    OTel traces, metrics, logs         │
│  panopticon:4318/proxy/*                                     │
└─────────┬────────────────────────────┬───────────────────────┘
          │ HTTP (proxied upstream)    │ OTLP http/protobuf
          ▼                            ▼
┌──────────────────────────────────────────────────────────────┐
│                  Panopticon Server (:4318)                    │
│                                                              │
│  /proxy/moonshot/*  →  api.moonshot.ai                       │
│  /proxy/anthropic/* →  api.anthropic.com                     │
│  /v1/{traces,metrics,logs} → OTLP receiver                   │
│                                                              │
│  SQLite: hook_events, otel_logs, otel_metrics, otel_spans    │
└──────────────────────────────────────────────────────────────┘
```

For visualization, see [`examples/grafana/`](../grafana/) (separate setup).

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2)
- At least one of:
  - Moonshot AI API key — [platform.moonshot.ai](https://platform.moonshot.ai)
  - Anthropic API key — [console.anthropic.com](https://console.anthropic.com)

## Quick start

```bash
# 1. Configure API keys (set one or both)
cp .env.example .env
# Edit .env and set MOONSHOT_API_KEY and/or ANTHROPIC_API_KEY

# 2. Run the setup script
./examples/openclaw/setup.sh
```

The script builds panopticon from source, starts both containers, and configures OpenClaw with:
- the `diagnostics-otel` plugin pointed at `panopticon:4318`
- each configured provider's `baseUrl` rewritten to `http://panopticon:4318/proxy/<id>` so every request/response is captured
- a default agent pointed at whichever provider is configured (moonshot preferred when both are set)

## End-to-end test

After `setup.sh` completes:

1. Open the OpenClaw UI at [http://localhost:18789](http://localhost:18789).
2. Send a prompt. If you set both keys, send a second prompt after switching the model in the UI (Kimi ↔ Claude) to exercise both providers.
3. Verify capture:

   ```bash
   ./examples/openclaw/verify-capture.sh
   ```

   By default this checks whichever providers have keys set in `.env`. Override with explicit ids when you want:

   ```bash
   ./examples/openclaw/verify-capture.sh anthropic        # just anthropic
   ./examples/openclaw/verify-capture.sh moonshot anthropic
   ```

   Exits non-zero if any checked provider has no proxy rows or if OTel stopped flowing.

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
# Proxy capture — which providers have we seen traffic for?
docker exec panopticon panopticon query \
  "SELECT target, COUNT(*) FROM hook_events
   WHERE target IN ('moonshot', 'anthropic')
   GROUP BY target"

# Recent token-usage metrics (from OpenClaw's diagnostics-otel plugin)
docker exec panopticon panopticon query \
  "SELECT name, json_extract(attributes, '$.\"openclaw.token\"') AS token_type,
          json_extract(attributes, '$.\"openclaw.model\"') AS model, value
   FROM otel_metrics
   WHERE name = 'openclaw.tokens'
   ORDER BY id DESC LIMIT 20"

# Recent model-call spans
docker exec panopticon panopticon query \
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

## Adding more providers

`setup.sh` configures Moonshot + Anthropic because those are the two this example targets. Panopticon's provider registry (`src/providers/builtin.ts`) also knows openai, google, deepseek, groq, xai, and mistral — any of these can be added by editing `~/.openclaw/openclaw.json` inside the container to add another entry under `models.providers`, with `baseUrl: "http://panopticon:4318/proxy/<id>"`. Providers panopticon doesn't know will fail at proxy time; leave them unrewritten if you want to use them untouched.

For a non-example install (your own OpenClaw), the panopticon CLI does the rewrite for you:

```bash
panopticon install --target openclaw --proxy
```

This iterates every configured provider and rewrites the known ones' `baseUrl` to the proxy. Unknown providers get a warning and are left alone.

## Teardown

```bash
docker compose -f examples/openclaw/docker-compose.yml down -v
```

The `-v` flag removes volumes (config, workspace, panopticon data). Omit it to keep data across restarts.

## Notes

- The captured token-usage metrics are tagged with `openclaw.token` (which type — input, output, cache_read, cache_write, total) and `openclaw.model`. Panopticon's adapter (`src/targets/openclaw.ts`) declares these so derived metrics aggregate correctly.
- OpenClaw's `diagnostics-otel` plugin uses the openclaw-specific attribute namespace (`openclaw.*`) rather than GenAI semconv — see [docs.openclaw.ai/logging](https://docs.openclaw.ai/logging) for the full attribute list.
