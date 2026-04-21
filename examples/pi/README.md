# Pi + Panopticon

Capture session events from a [Pi coding agent](https://pi.dev) into [Panopticon](../..)'s local database. Pi emits events via a TypeScript extension that POSTs to panopticon's `/hooks` endpoint.

## What you get

```
┌──────────────────────────────────────────────────────────────┐
│                    Pi Coding Agent                             │
│                                                              │
│  Extension emits events ─────────────────────────────────────│
│  session_start, input, tool_call, tool_result,             │
│  session_shutdown ──────────────────────────────────────────│
│                                                              │
│  via fire-and-forget HTTP POST to panopticon:4318/hooks     │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP POST
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                  Panopticon Server (:4318)                    │
│                                                              │
│  /hooks          →  Hook event storage                       │
│  SQLite: hook_events, sessions                                │
└──────────────────────────────────────────────────────────────┘
```

Unlike OpenClaw, Pi does not emit native OTel telemetry. Observability is purely via the extension's HTTP events.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2)
- Anthropic API key — [console.anthropic.com](https://console.anthropic.com)

## Quick start

```bash
# 1. Configure API keys
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY

# 2. Run the setup script
./examples/pi/setup.sh
```

The script builds panopticon from source, starts both containers, installs Pi and the panopticon extension inside the Pi container, and runs a test prompt.

## End-to-end test

After `setup.sh` completes, run a prompt through Pi interactively:

```bash
docker compose -f examples/pi/docker-compose.yml exec pi bash
pi
```

`setup.sh` prints a `hook_events` row count at the end of its run — re-run it (or use the queries below) to confirm new events landed.

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Panopticon | http://localhost:4318/health | Hook receiver |

## What gets captured

The panopticon extension for Pi captures these event types:

| Event | Description |
|-------|-------------|
| `SessionStart` | Pi session initialized |
| `UserPromptSubmit` | User submitted a prompt |
| `PreToolUse` | Tool call about to execute |
| `PostToolUse` | Tool completed successfully |
| `PostToolUseFailure` | Tool failed |
| `SessionEnd` | Session shutting down |

Each event includes `session_id`, `tool_name`, `tool_input`, `cwd`, and `repository` (if detectable via git).

## Querying the data

```bash
# All Pi events
docker exec panopticon panopticon query \
  "SELECT event_type, tool_name, COUNT(*) as n FROM hook_events
   WHERE target = 'pi' GROUP BY event_type, tool_name"

# Recent tool calls
docker exec panopticon panopticon query \
  "SELECT event_type, tool_name, tool_input FROM hook_events
   WHERE target = 'pi' AND event_type LIKE '%Tool%'
   ORDER BY id DESC LIMIT 20"

# Sessions
docker exec panopticon panopticon query \
  "SELECT session_id, COUNT(*) as events, MIN(cwd) as cwd
   FROM hook_events WHERE target = 'pi'
   GROUP BY session_id"
```

## How the extension works

The panopticon extension (`src/targets/pi/extension.ts`) is bundled via esbuild and installed to Pi's extensions directory. At runtime:

1. Pi loads the extension on startup
2. Extension generates a unique `session_id` for the session
3. For each event (`session_start`, `input`, `tool_call`, `tool_result`, `session_shutdown`), the extension POSTs to `http://panopticon:4318/hooks`
4. Panopticon's hook handler processes the event and stores it in SQLite

The extension connects to `PANOPTICON_HOST` (default `127.0.0.1`) on `PANOPTICON_PORT` (default `4318`). In the Docker setup, `PANOPTICON_HOST` is set to `panopticon` (the Docker service name) so the Pi container can reach the Panopticon server.

Events are fire-and-forget — failures are silently swallowed so the agent is never blocked.

## Manual setup

If you prefer to skip `setup.sh`:

```bash
# Build panopticon (includes bundling the extension)
pnpm build

# Start containers
docker compose -f examples/pi/docker-compose.yml up -d --build

# Install pi in the container
docker compose -f examples/pi/docker-compose.yml exec pi \
  npm install -g @mariozechner/pi-coding-agent

# Copy the bundled extension to Pi's project-local discovery directory
# Pi discovers extensions from <cwd>/.pi/extensions/*.js and ~/.pi/agent/extensions/
docker compose -f examples/pi/docker-compose.yml exec pi bash -c \
  'mkdir -p /workspace/.pi/extensions && cp /opt/panopticon/dist/targets/pi/extension.js /workspace/.pi/extensions/panopticon.js'

# Run pi with the extension (the extension is auto-discovered from the project-local dir)
docker compose -f examples/pi/docker-compose.yml exec pi bash
pi
```

For a non-Docker install (your local machine), the panopticon CLI does this automatically:

```bash
panopticon install --target pi
```

This copies the bundled extension to `~/.pi/agent/extensions/panopticon.js`.

## Teardown

```bash
docker compose -f examples/pi/docker-compose.yml down -v
```

The `-v` flag removes volumes (panopticon data). Omit it to keep data across restarts.

## Limitations

- **No OTel** — Pi doesn't emit native OpenTelemetry. All observability is via the extension.
- **No session scanner** — Pi doesn't write session files. Token usage is not captured.
- **No API proxy** — Pi routes API calls directly through its provider configuration. Panopticon's proxy capture is not active for Pi.
- **Server must be running** — The extension requires `panopticon start` (or the container running) before Pi sessions will capture events.
