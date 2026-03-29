# Panopticon: Upstream Sync & Full Observability

## What we have today

Panopticon runs locally on each developer's machine and collects data from three sources:

- **Hooks** — real-time events from Claude Code, Codex, and Gemini (tool calls, prompts, session lifecycle)
- **OTLP** — native OpenTelemetry from each CLI (token metrics, log events)
- **Scanner** — parsed from CLI session files on disk (per-turn token usage, tool calls, errors, reasoning traces)

All three sources upsert into a unified **sessions table** — each session accumulates data from whichever sources are active, in any order. An **API proxy** mode is available as an alternative to scanner for environments where session files aren't accessible.

Every record carries three attributes: **target** (which CLI), **source** (data shape: hooks/otel/scanner), and **emitter** (local vs proxy).

## What we're building

### 1. Sync everything upstream via OTLP

The existing sync loop pushes hooks and OTLP data to Grafana. We're adding:

- **Scanner turns** → OTLP metrics (per-turn token usage with model/type breakdowns)
- **Scanner events** → OTLP logs (tool calls, errors, reasoning, file snapshots)
- **Session summaries** → OTLP logs (pre-aggregated session metadata, tokens from all sources)
- **OTLP traces** → store and forward spans (per-operation latency, causality)

Sessions sync via a dirty flag — when any source updates a session, it re-syncs within 5 seconds.

### 2. Mesh deployment

Any panopticon instance can be both a receiver and a forwarder. A developer's laptop syncs to a team hub; the hub syncs to an org-level instance or Grafana. Data carries its provenance (`target`, `source`, `emitter`) through every hop.

```
Developer laptops → Team hub (panopticon) → Grafana / Neon
```

### 3. Debounced sync

Minimum batch threshold (10 records) with a maximum wait (5 seconds) to reduce HTTP overhead during bursty activity while keeping latency low enough for live observation via Grafana's live tail.

## Data coverage by CLI

| Data | Claude Code | Codex | Gemini |
|---|---|---|---|
| Session lifecycle | hooks | hooks | hooks |
| Per-turn tokens | scanner ✓ OTLP | scanner ✓ | scanner ✓ OTLP |
| Cache breakdown | scanner (read + creation) | scanner (read) | scanner (read) |
| Reasoning tokens | — | scanner ✓ | scanner ✓ |
| Tool calls | scanner + hooks | scanner ✓ | scanner ✓ |
| API errors/retries | scanner ✓ | — | — |
| File edit snapshots | scanner ✓ | — | — |
| Agent reasoning | — | scanner ✓ | scanner ✓ |
| API latency | proxy mode | proxy mode | proxy mode |
| OTel traces/spans | planned | planned | — |

## Session data model

One row per session, built incrementally from all sources:

| Field | Source |
|---|---|
| target, started_at_ms, ended_at_ms, cwd, first_prompt | hooks or scanner or OTLP (first available) |
| permission_mode, agent_version | hooks |
| model, models (set), cli_version, scanner_file_path | scanner |
| total_input/output/cache_read/cache_creation/reasoning_tokens | scanner (authoritative) |
| otel_input/output/cache_read/cache_creation_tokens | OTLP (for comparison) |
| turn_count | scanner |
| sources | set: "hooks,otel,scanner" |
| emitter | "local" or "proxy" |
| repository | resolved from cwd (git remote) |

## Server-side storage (future)

For org-scale (1000+ engineers, year of data): Neon Postgres with session summaries pre-aggregated by panopticon. Raw scanner turns/events available for drill-down. Estimated ~300M rows/year, ~30-50GB compressed. Session files optionally archived to S3 for full conversation replay.
