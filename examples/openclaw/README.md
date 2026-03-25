# OpenClaw + Panopticon

Capture telemetry from [OpenClaw](https://openclaw.ai) sessions — tool calls, model usage (Kimi, GPT, Claude, etc.), token consumption, and agent lifecycle events — using Panopticon's three capture layers.

> **Status**: This example is a preview. Full OpenClaw vendor adapter support is coming in a future release. The steps below work today using OpenClaw's built-in diagnostics plugin and Panopticon's OTLP receiver.

## How it works

OpenClaw sends data to Panopticon through three independent channels:

```
OpenClaw Gateway
  │
  ├─ diagnostics-otel plugin ──→ Panopticon OTLP receiver (:4318)
  │   (traces, metrics, logs)     /v1/logs, /v1/metrics
  │
  ├─ Kimi API calls ────────────→ Panopticon proxy (:4318)
  │   (via base URL override)     /proxy/moonshot → api.moonshot.ai
  │
  └─ hook plugin (future) ──────→ Panopticon hooks endpoint (:4318)
      (lifecycle events)          /hooks
```

| Layer | What it captures | Setup |
|-------|-----------------|-------|
| **OTel** | Token usage, cost, model calls, tool execution, session state | Enable `diagnostics-otel` plugin |
| **Proxy** | Full API request/response pairs for Kimi (OpenAI-compatible) | Set Moonshot base URL to proxy |
| **Hooks** | Session lifecycle, tool results (when OpenClaw ships more events) | Install hook plugin (future) |

## Prerequisites

- Panopticon installed and running (`panopticon install && panopticon start`)
- OpenClaw installed ([docs.openclaw.ai](https://docs.openclaw.ai))

## Setup

### 1. Enable OpenClaw's diagnostics-otel plugin

```bash
openclaw plugin enable diagnostics-otel
```

Then configure it to point at Panopticon. Add to your OpenClaw config (`~/.openclaw/config.json` or `~/.openclaw/config.yaml`):

```json
{
  "diagnostics": {
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 1.0
    }
  }
}
```

Or via environment variable:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### 2. Route Kimi API calls through the proxy (optional)

If you're using Kimi (Moonshot AI) as your model, you can route API traffic through the Panopticon proxy to capture full request/response pairs. Kimi's API is OpenAI-compatible, so the existing OpenAI parser handles it with zero configuration.

Set the Moonshot base URL in your OpenClaw provider config:

```json
{
  "providers": {
    "moonshot": {
      "baseUrl": "http://localhost:4318/proxy/moonshot"
    }
  }
}
```

> **Note**: The `moonshot` proxy route requires the OpenClaw vendor adapter (coming soon). For now, you can use the `openai` route since Kimi is OpenAI-compatible:
> ```json
> { "baseUrl": "http://localhost:4318/proxy/openai" }
> ```

### 3. Restart OpenClaw

```bash
openclaw restart
```

## Verify

Check that data is flowing:

```bash
# OTel data from diagnostics plugin
panopticon query "SELECT body, attributes FROM otel_logs ORDER BY id DESC LIMIT 5"

# Metrics (token usage, cost)
panopticon query "SELECT name, value, attributes FROM otel_metrics ORDER BY id DESC LIMIT 5"

# If proxy is enabled — API request/response capture
panopticon query "SELECT event_type, tool_name FROM hook_events WHERE source = 'proxy' ORDER BY id DESC LIMIT 5"
```

## What gets captured

### Via OTel (diagnostics-otel plugin)

| Signal | Data |
|--------|------|
| Metrics | Token usage, cost, context size, run duration, message-flow counters |
| Traces | Model call spans, tool execution spans, webhook processing |
| Logs | Agent lifecycle events, errors |

### Via Proxy (Kimi API)

| Data | Extracted by |
|------|-------------|
| User prompts | `openaiParser` (last user message) |
| Tool calls | `openaiParser` (response tool_calls) |
| Token usage | `openaiParser` (prompt_tokens, completion_tokens) |
| Model info | `openaiParser` (model field) |

## Notes

- OpenClaw's `diagnostics-otel` plugin follows [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), so traces work with any GenAI-aware backend.
- Kimi's API is a drop-in for OpenAI's — same `/v1/chat/completions` endpoint, same request/response format. No custom parser needed.
- A full OpenClaw vendor adapter (with `panopticon install --target openclaw`) is planned, which will automate the setup described here.
