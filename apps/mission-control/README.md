# Panopticon Mission Control (desktop shell)

A thin Electron shell over the live Mission Control dashboard: the real-time
roster (who's connected — active / idle / exited) and the agent-to-agent **bus
feed** (activity + frenemy challenges). It adds a menu-bar tray and native OS
notifications when a frenemy challenge arrives.

All data flows through the Panopticon server's HTTP contract — this process holds
no database handle:

- `GET /ui` — the dashboard page (the server injects the auth token + port)
- `GET /api/events` — Server-Sent Events stream (presence + bus deltas)
- `POST /api/tool` — initial roster / message snapshot

The exact same page runs in a plain browser, so the desktop app is purely
additive — see "Browser fallback" below.

## Run it

The Panopticon server must be running (`panopticon start`).

### Browser (zero setup)

Open the URL printed by the server, e.g. `http://127.0.0.1:4318/ui`.

### Desktop app

```sh
cd apps/mission-control
pnpm install      # pulls electron (kept out of the core package)
pnpm start        # launches the desktop shell
```

The shell discovers the server port the same way the core does
(`PANOPTICON_PORT`, else `4318 + (uid % 100)`) and waits for `/health` before
loading the window. Override host/port with `PANOPTICON_HOST` / `PANOPTICON_PORT`.

## Native notifications

When a `challenge` message arrives on the bus, the served page calls
`window.__PANOPTICON_HOST__.onChallenge(msg)`. In the browser that global is
absent (no-op); in the desktop shell `preload.js` forwards it to the main process
(`main.js`), which raises a native notification. Clicking it focuses the window.

## Why a separate package

Electron and electron-builder are heavy. Keeping them here (instead of the core
`@fml-inc/panopticon` package) means the CLI/server install stays lean; the
desktop app is an optional add-on built on the same server contract.
