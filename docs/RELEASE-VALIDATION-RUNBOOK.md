# Release Validation Runbook

This runbook is for release-candidate validation against a copied production
Panopticon data directory. It is intentionally separate from the clean-home E2E
harness in `test/e2e/scripts/test-sync-validation.sh`.

Use this when you want to validate:

- upgrade behavior on a real production-sized DB
- atomic reparse and derived-state rebuilds
- session preservation across reparse
- split core vs OTEL sync behavior
- manual rebuild execs on real sessions
- reinstall behavior on a real home directory

## Regressions Found In The April 2026 Pass

This runbook was written after validating `v0.2.8..HEAD` on a real production
DB and live home directory. That pass found and fixed:

1. Atomic reparse dropped sessions that only existed via hooks or OTEL.
   Files: `src/scanner/reparse.ts`, `src/scanner/reparse.test.ts`
2. Reinstall could leave target-specific shell env vars outside the managed
   panopticon block.
   Files: `src/setup.ts`, `src/cli.ts`, `src/setup.test.ts`
3. Codex reinstall clobbered existing
   `mcp_servers.panopticon.tools.*.approval_mode` overrides.
   Files: `src/targets/codex.ts`, `src/targets/codex.install.test.ts`
4. The sync E2E harness did not assert the multi-target shell env behavior.
   File: `test/e2e/scripts/test-sync-validation.sh`

One release risk is still open:

- On DBs that require startup atomic reparse, the server thread is currently
  blocked during rebuild. `/health` and `/api/tool` time out until reparse
  completes instead of returning a rebuild-pending response.

## Notes From The April 21 2026 RC Pass

- The copied production DB used in that pass was about 900 MB with 5667
  sessions. Startup atomic reparse completed successfully, but `Scanner ready`
  took 564.25s. On similar DBs, treat roughly 8 to 10 minutes as plausible as
  long as `scanner-status.json` keeps advancing.
- Use the exact tarball filename returned by `npm pack`, not
  `./fml-inc-panopticon-*.tgz`. If the workspace already has multiple matching
  tarballs, the glob can make the temp-prefix install ambiguous.
- `install --target all --proxy --force` touched
  `~/Library/Application Support/Claude/claude_desktop_config.json` and
  `~/.openclaw/openclaw.json` on the validation machine. Include them in the
  real-home backup and diff loops if those targets are installed.

## Prerequisites

- `pnpm`
- `node`
- `sqlite3`
- `curl`
- `jq`
- a production Panopticon data dir to copy, or at minimum a production
  `panopticon.db` plus its sibling `config.json`

## Suggested Variables

Set these first and reuse them for the whole run:

```bash
export PROD_DATA_DIR="/path/to/production/panopticon-data"
export PROD_DB="$PROD_DATA_DIR/panopticon.db"

export BACKUP_ROOT="/tmp/panopticon-release-backup-$(date +%Y%m%d-%H%M%S)"
export RC_DIR="/tmp/panopticon-rc-data"
export RC_PORT="4418"

export NPM_CACHE="/tmp/panopticon-npm-cache"
export RC_PREFIX="/tmp/panopticon-rc-prefix"
export RC_BIN="$RC_PREFIX/bin/panopticon"
export RC_NODE_ROOT="$RC_PREFIX/lib/node_modules/@fml-inc/panopticon"
export RC_SERVER="$RC_NODE_ROOT/dist/server.js"

export MOCK_SYNC_URL="http://127.0.0.1:9801"
```

If you are validating your current live machine as well:

```bash
export LIVE_HOME_BACKUP="$BACKUP_ROOT/home"
mkdir -p "$LIVE_HOME_BACKUP"
```

## 1. Capture Baseline And Backup

If the production data dir is on your current machine, back it up before doing
anything else:

```bash
mkdir -p "$BACKUP_ROOT"
sqlite3 "$PROD_DB" ".backup '$BACKUP_ROOT/panopticon.db'"
```

Capture a quick baseline:

```bash
sqlite3 "$PROD_DB" "
SELECT COUNT(*) AS sessions FROM sessions;
SELECT COUNT(*) AS hook_events FROM hook_events;
SELECT COUNT(*) AS otel_logs FROM otel_logs;
SELECT COUNT(*) AS otel_metrics FROM otel_metrics;
SELECT COUNT(*) AS orphan_otel_logs
FROM otel_logs
WHERE session_id IS NOT NULL
  AND session_id NOT IN (SELECT session_id FROM sessions);
SELECT COUNT(*) AS orphan_hook_events
FROM hook_events
WHERE session_id IS NOT NULL
  AND session_id NOT IN (SELECT session_id FROM sessions);
"
```

If you also want to validate reinstall behavior on a real home directory,
snapshot the files install will touch:

```bash
for p in \
  "$HOME/.zshrc" \
  "$HOME/.claude/settings.json" \
  "$HOME/.codex/config.toml" \
  "$HOME/.codex/hooks.json" \
  "$HOME/.gemini/settings.json" \
  "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
  "$HOME/.openclaw/openclaw.json" \
  "$HOME/Library/Application Support/panopticon/config.json" \
  "$HOME/Library/Application Support/panopticon/allowed.json" \
  "$HOME/Library/Application Support/panopticon/approvals.json"
do
  if [ -e "$p" ]; then
    mkdir -p "$BACKUP_ROOT$(dirname "$p")"
    cp -a "$p" "$BACKUP_ROOT$p"
  fi
done
```

## 2. Build The Exact Release Candidate

Use the current branch bits, not a stale global install:

```bash
pnpm typecheck
pnpm build
pnpm exec tsup --config scripts/test-sync-server.tsup.config.ts
PACK_TGZ="$(npm pack --cache "$NPM_CACHE" | tail -n 1)"
npm install -g \
  --prefix "$RC_PREFIX" \
  --cache "$NPM_CACHE" \
  --ignore-scripts \
  "./$PACK_TGZ"
```

The installed temp-prefix binaries are then:

- CLI: `$RC_BIN`
- server: `$RC_SERVER`
- mock sync receiver: `dist/test-sync-server.js` in the workspace

## 3. Prepare An Isolated Copy Of The Production Data Dir

Never point the RC directly at the live production dir during the first pass.

```bash
rm -rf "$RC_DIR"
mkdir -p "$RC_DIR"
sqlite3 "$PROD_DB" ".backup '$RC_DIR/panopticon.db'"
cp -a "$PROD_DATA_DIR/config.json" "$RC_DIR/config.json"
[ -f "$PROD_DATA_DIR/allowed.json" ] && cp -a "$PROD_DATA_DIR/allowed.json" "$RC_DIR/allowed.json"
[ -f "$PROD_DATA_DIR/approvals.json" ] && cp -a "$PROD_DATA_DIR/approvals.json" "$RC_DIR/approvals.json"
```

Start with no remote sync targets in the copied config:

```bash
jq '.sync.targets = []' "$RC_DIR/config.json" > "$RC_DIR/config.json.tmp"
mv "$RC_DIR/config.json.tmp" "$RC_DIR/config.json"
```

## 4. Start The RC Against The Copied Production DB

Run the server in a dedicated terminal:

```bash
PANOPTICON_DATA_DIR="$RC_DIR" \
PANOPTICON_PORT="$RC_PORT" \
node "$RC_SERVER"
```

If the copied DB predates `data_versions`, startup should trigger atomic
reparse automatically.

Watch progress:

```bash
cat "$RC_DIR/scanner-status.json"
```

Reproduce the current startup-blocking risk while reparse is active:

```bash
curl -sS --max-time 5 "http://127.0.0.1:$RC_PORT/health"

curl -sS --max-time 5 \
  -X POST "http://127.0.0.1:$RC_PORT/api/tool" \
  -H 'content-type: application/json' \
  --data '{"name":"search_intent","params":{"query":"sync","limit":1}}'
```

Current expected behavior on stale DBs:

- `scanner-status.json` advances through `reparse_*`
- both curls time out until reparse finishes

In the April 21 2026 pass, a 5667-session copied DB took 564.25s to reach
`Scanner ready`. If `scanner-status.json.updatedAtMs` keeps changing, that is
more likely normal rebuild cost than a hang.

Once reparse completes, both calls should succeed.

## 5. Validate The Upgraded Copied DB

Check migrations and data-version state:

```bash
sqlite3 "$RC_DIR/panopticon.db" "
SELECT component || '|' || version
FROM data_versions
ORDER BY component;

SELECT id
FROM schema_migrations
ORDER BY id;
"
```

The current RC should end with:

```text
claims.active|1
claims.projection|1
intent.from_hooks|2
intent.from_scanner|2
intent.landed_from_disk|2
scanner.raw|3
```

Compare sessions in the rebuilt copy against the original production DB:

```bash
sqlite3 "$RC_DIR/panopticon.db" "
ATTACH '$PROD_DB' AS prod;

SELECT COUNT(*)
FROM prod.sessions p
WHERE NOT EXISTS (
  SELECT 1 FROM main.sessions m WHERE m.session_id = p.session_id
);

SELECT COUNT(*)
FROM main.sessions m
WHERE NOT EXISTS (
  SELECT 1 FROM prod.sessions p WHERE p.session_id = m.session_id
);
"
```

Expected result: `0` then `0`.

Check that orphan counts did not get worse:

```bash
sqlite3 "$RC_DIR/panopticon.db" "
SELECT COUNT(*)
FROM otel_logs
WHERE session_id IS NOT NULL
  AND session_id NOT IN (SELECT session_id FROM sessions);

SELECT COUNT(*)
FROM hook_events
WHERE session_id IS NOT NULL
  AND session_id NOT IN (SELECT session_id FROM sessions);
"
```

Check that claim-backed APIs work after rebuild:

```bash
curl -sS \
  -X POST "http://127.0.0.1:$RC_PORT/api/tool" \
  -H 'content-type: application/json' \
  --data '{"name":"search_intent","params":{"query":"sync","limit":1}}'
```

## 6. Validate Session-Scoped Manual Rebuild Execs

Pick a real scanner-backed session:

```bash
SESSION_ID="$(
  sqlite3 "$RC_DIR/panopticon.db" \
    "SELECT session_id
     FROM sessions
     WHERE has_scanner = 1
     ORDER BY COALESCE(ended_at_ms, started_at_ms, created_at, 0) DESC
     LIMIT 1;"
)"
echo "$SESSION_ID"
```

Run all three session-scoped rebuild execs:

```bash
curl -sS -X POST "http://127.0.0.1:$RC_PORT/api/exec" \
  -H 'content-type: application/json' \
  --data "{\"command\":\"rebuild-claims-from-raw\",\"params\":{\"sessionId\":\"$SESSION_ID\"}}"

curl -sS -X POST "http://127.0.0.1:$RC_PORT/api/exec" \
  -H 'content-type: application/json' \
  --data "{\"command\":\"rebuild-intent-projection-from-claims\",\"params\":{\"sessionId\":\"$SESSION_ID\"}}"

curl -sS -X POST "http://127.0.0.1:$RC_PORT/api/exec" \
  -H 'content-type: application/json' \
  --data "{\"command\":\"reconcile-landed-status-from-disk\",\"params\":{\"sessionId\":\"$SESSION_ID\"}}"
```

These should return non-empty JSON results and should not require a full-DB
rebuild.

## 7. Validate Split Sync With A Mock Receiver

Start the mock receiver in a second terminal:

```bash
node dist/test-sync-server.js
```

Add a local sync target to the copied config:

```bash
PANOPTICON_DATA_DIR="$RC_DIR" PANOPTICON_PORT="$RC_PORT" \
  "$RC_BIN" sync add local-a "$MOCK_SYNC_URL"
```

Restart the isolated server so it reloads sync targets.

After restart, inspect pending work:

```bash
curl -sS -X POST "http://127.0.0.1:$RC_PORT/api/exec" \
  -H 'content-type: application/json' \
  --data '{"command":"sync-pending","params":{"target":"local-a"}}'

curl -sS "$MOCK_SYNC_URL/stats"
```

Reset and replay to check idempotence:

```bash
curl -sS -X POST "http://127.0.0.1:$RC_PORT/api/exec" \
  -H 'content-type: application/json' \
  --data '{"command":"sync-reset","params":{"target":"local-a"}}'
```

Validate the main sync invariants directly in SQLite:

```bash
sqlite3 "$RC_DIR/panopticon.db" "
SELECT COUNT(*) FROM target_session_sync WHERE synced_seq > sync_seq;
SELECT COUNT(*) FROM target_session_sync WHERE wm_otel_logs > 0;
"
```

Expected:

- `synced_seq > sync_seq` count is `0`
- at least some `wm_otel_logs` rows should become non-zero once OTEL sync runs

## 8. Optional: Real-Home Reinstall Validation

Only do this after the copied-data validation passes.

Restore any backed-up home files first if you want to test reinstall behavior
from a known baseline:

```bash
for p in \
  "$HOME/.zshrc" \
  "$HOME/.claude/settings.json" \
  "$HOME/.codex/config.toml" \
  "$HOME/.codex/hooks.json" \
  "$HOME/.gemini/settings.json" \
  "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
  "$HOME/.openclaw/openclaw.json"
do
  if [ -e "$BACKUP_ROOT$p" ]; then
    cp -a "$BACKUP_ROOT$p" "$p"
  fi
done
```

Run install from the current branch build:

```bash
node dist/cli.js install --target all --proxy --force
```

Diff the touched files against the backup:

```bash
for p in \
  "$HOME/.zshrc" \
  "$HOME/.claude/settings.json" \
  "$HOME/.codex/config.toml" \
  "$HOME/.codex/hooks.json" \
  "$HOME/.gemini/settings.json" \
  "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
  "$HOME/.openclaw/openclaw.json"
do
  printf '%s\n' "$p"
  diff -u "$BACKUP_ROOT$p" "$p" || true
  printf '\n'
done
```

What to check:

1. `.zshrc` or `.bashrc` has a single managed panopticon block that contains:
   the OTEL exporter vars, `CLAUDE_CODE_ENABLE_TELEMETRY`,
   `ANTHROPIC_BASE_URL`, and the `GEMINI_TELEMETRY_*` vars.
2. `~/.codex/config.toml` updates the `mcp_servers.panopticon.args` path
   without deleting existing `mcp_servers.panopticon.tools.*.approval_mode`
   entries. If install was run with `--proxy`, also verify
   `openai_base_url = "http://localhost:4318/proxy/codex"`.
3. `~/.codex/hooks.json` and the hook sections in `~/.gemini/settings.json`
   point at the current branch's `bin/hook-handler`. If install was run with
   `--proxy`, those hook commands should include `--proxy`.
4. `~/.gemini/settings.json`,
   `~/Library/Application Support/Claude/claude_desktop_config.json`, and
   `~/.openclaw/openclaw.json` point at the current branch's `bin/mcp-server`.
   If Claude Desktop or OpenClaw config did not exist before install, treat
   creation as expected and inspect the new file contents rather than expecting
   a diff.

If you specifically want to reproduce the Codex reinstall regression check on a
fresh home, seed a config like this before install:

```toml
[mcp_servers.panopticon]
command = "node"
args = ["/old/panopticon/bin/mcp-server"]

[mcp_servers.panopticon.tools.search_intent]
approval_mode = "approve"

[mcp_servers.panopticon.tools.query]
approval_mode = "deny"
```

Then rerun:

```bash
node dist/cli.js install --target codex --proxy --force
```

The `approval_mode` entries should still be present afterward.

## 9. Optional: Live DB Canary

After the copied-data validation passes, you can canary the actual production
home on the current branch:

```bash
node dist/cli.js install --target all --proxy --force
panopticon status
```

If the live DB still predates `data_versions`, `install` may immediately start
the server and trigger the same startup atomic reparse as the copied-data pass.
During that window, `panopticon status` should show `reparse_*` progress, and
`/health` plus `/api/tool` may time out until rebuild completes.

Recommended canary checks:

```bash
curl -sS "http://127.0.0.1:4318/health"

curl -sS -X POST "http://127.0.0.1:4318/api/tool" \
  -H 'content-type: application/json' \
  --data '{"name":"search_intent","params":{"query":"sync","limit":1}}'

sqlite3 "$PROD_DB" "
SELECT COUNT(*) FROM target_session_sync WHERE synced_seq > sync_seq;
SELECT COUNT(*) FROM target_session_sync WHERE wm_otel_logs > 0;
"
```

If you have multiple real remote sync targets, canary one target first and do
not reset all targets at once.

## Commands Used In The April 2026 Pass

These were the targeted automated checks run while landing the fixes:

```bash
pnpm exec vitest run \
  src/setup.test.ts \
  src/targets/codex.install.test.ts \
  src/scanner/reparse.test.ts

pnpm typecheck

bash -n test/e2e/scripts/test-sync-validation.sh
```

## Related Files

- `test/e2e/scripts/test-sync-validation.sh`
- `scripts/test-sync-server.ts`
- `src/scanner/reparse.ts`
- `src/scanner/reparse.test.ts`
- `src/setup.ts`
- `src/setup.test.ts`
- `src/cli.ts`
- `src/targets/codex.ts`
- `src/targets/codex.install.test.ts`
