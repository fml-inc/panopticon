# Open Source Readiness Review

## What works well

**Target adapter pattern** — This is the architectural highlight. `TargetAdapter` decomposes every vendor concern (config paths, hook formats, event normalization, proxy routing, detection) into a single self-contained file. Adding a new coding tool is genuinely a single-file exercise. The registry is clean, consumers iterate without hardcoded branches. This is the kind of extensibility that attracts contributors.

**Single-process, single-port server** — Everything on `:4318` (OTLP, hooks, proxy, health check) is a strong ergonomic choice. One process to manage, one port to open, one thing to debug. The server.ts routing is ~100 lines and immediately readable.

**SQLite-only, no Docker** — This is a killer feature for adoption. Zero infrastructure requirements. WAL mode, auto-vacuum, auto-prune — it just works. The "no external services" pitch in the README is genuine.

**CLI as thin UI over library** — `index.ts` exports everything the CLI can do. This means programmatic consumers (the SDK shim, the sync module, other tools) get first-class access. Good foundation for an ecosystem.

**Doctor command** — Structured diagnostics with clear pass/warn/fail output. This will save a lot of "it's not working" issue traffic.

---

## Things to address before open sourcing

### 1. Branding / namespace cleanup

The package is `@fml-inc/panopticon` with `publishConfig` pointing at GitHub Packages. References to `fml-inc` and `fml` are scattered:

- `package.json` name, repository URL, publishConfig
- README install URLs (`fml-inc/panopticon`)
- Claude adapter: `plugins["fml@local-plugins"]` in both `applyInstallConfig` and `removeInstallConfig`
- SDK import example in README: `@fml-inc/panopticon/sdk`
- `config.ts`: marketplace paths reference `claude-plugins`

Decision needed: will this go to npm public under a new scope, stay on GitHub Packages under a new org, or go unscoped? This affects every import example in the README.

### 2. Core config leaks Claude-specific concerns

`config.ts` defines `CLAUDE_DIR`, `pluginCacheDir`, `marketplaceDir`, `marketplaceManifest` — these are Claude Code implementation details that belong in the Claude target adapter, not the shared config module. The target adapter pattern is set up to handle this; these values just haven't been moved there yet. External consumers (or a hypothetical Cursor adapter) shouldn't have to see Claude marketplace paths in the core config.

Similarly, `config.ts` still carries legacy fields (`pidFile`, `otlpPort`, `otlpHost`, `proxyPort`, `proxyHost`) from before the unified server. Dead weight.

### 3. Shell env modification is risky

`setup.ts:configureShellEnv` directly writes to `~/.zshrc` or `~/.bashrc`. This is the single riskiest user-facing operation:

- No `--dry-run` to preview changes
- Shell detection via `$SHELL` is fragile (doesn't handle fish, nushell, etc.)
- No `panopticon uninstall` that reverses the shell changes (I see `removeInstallConfig` per-target, but no corresponding shell cleanup)
- If it corrupts the rc file, the user can't open a new terminal

For open source, this needs at minimum: (a) print-to-stdout mode so users can paste themselves, (b) fish/nushell handling (even if just "not supported, here's what to add"), (c) a clean uninstall path.

### 4. Too many package exports for v0.1.0

`package.json` exports 15 subpaths: `./sdk`, `./db`, `./types`, `./query`, `./server`, `./setup`, `./prune`, `./pricing`, `./permissions`, `./doctor`, `./repo`, `./scanner`, `./sync`, `./targets`. Many of these are internal concerns (`./db`, `./prune`, `./pricing`, `./repo`) that don't need to be public API. Every export is a semver contract.

Consider collapsing to 4-5: `.` (main library), `./sdk`, `./sync`, `./targets`, and maybe `./server`. Everything else can be accessed through the main export.

### 5. Port 4318 conflict

Port 4318 is the standard OTLP gRPC port. Reusing it is clever (tools send OTel there by default), but if someone already runs an OpenTelemetry Collector, they'll get `EADDRINUSE`. The current behavior is to silently exit with code 0 ("already running") — which will be very confusing if it's actually a *different* collector.

The health check at `/health` returning panopticon-specific JSON would help disambiguate, but the startup logic should at least log a warning or check the `/health` response to confirm it's actually panopticon.

### 6. Files to clean up

- `fml-inc-panopticon-0.1.0.tgz` is in the repo root and would be committed. Add `*.tgz` to `.gitignore`.
- `install.sh` is deleted on this branch with no replacement — the README still references it.
- `DERIVED-METRICS.md` — is this for users or internal? If internal, don't ship it.
- `doctor.ts:339` has a stray `import path from "node:path"` at the end of the file (after the closing brace of `doctor()`).

### 7. The `scanner.ts` module

This reads Claude Code's full config hierarchy (managed, user, project settings, hooks, MCP servers, commands, agents, rules, skills, permissions). It's exported as `./scanner`. For open source, it's worth deciding: is this a general-purpose utility or a Claude-Code-specific power tool? If the latter, it should probably live under `targets/` or be documented as Claude-specific.

### 8. Sentry is a hard dependency

`@sentry/node` is in `dependencies` (not optional). `sentry.ts` is imported unconditionally in `server.ts`. For an open source tool, most users won't want Sentry. The init is gated on having a DSN, which is good, but the 200KB+ dependency is always there. Consider making it a peer/optional dependency, or lazy-importing it.

### 9. README tone for OSS

The README is well-structured but written for internal consumption:

- Pi agent integration references `@panopticon/pi-extension` which isn't published
- SDK example imports from `@anthropic-ai/claude-agent-sdk` — is that public?
- The Sync section uses `@fml-inc/panopticon/sync`
- "as a dependency (e.g. from fml)" — meaningless to external users

For open source, lead with the problem statement (you're using AI coding tools, you want to see what they're doing), then the one-liner install, then show what you get. The architecture diagram is great — keep it.

---

## Architecture assessment

The architecture is genuinely clean. The target adapter pattern, the unified server, the SQLite-only approach, and the library-first design are all solid choices that will hold up. The main work is cosmetic/namespace cleanup, reducing the public API surface, and hardening the install/uninstall flow for users who aren't you.

The biggest risk for adoption isn't code quality — it's the shell modification step. If you can make install non-destructive (print env vars for the user to add, or use a separate sourceable file like `~/.panopticon/env.sh` instead of modifying .zshrc), that alone will prevent 80% of the "I installed it and now my terminal is broken" issues.
