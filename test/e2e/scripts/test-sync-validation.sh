#!/usr/bin/env bash
# E2E test: Comprehensive sync + data correctness validation
#
# Superset of the per-CLI tests (test-claude.sh, test-codex.sh, test-gemini.sh)
# and the Grafana sync test (test-grafana.sh). Validates:
#   1. Install artifacts per CLI (settings, hooks, shell env)
#   2. Real coding sessions generate organic telemetry
#   3. Column correctness across all tables (schema, types, nullability)
#   4. Cross-table session_id correlation
#   5. Proxy capture (api_request with model/duration/status)
#   6. Sync to a panopticon-protocol receiver with zero data loss
#   7. Watermarks advance to completion
#
# Requires at least one API key. Best results with all three for cross-CLI coverage.
set -euo pipefail
source /opt/e2e/scripts/lib.sh

# ─── Configuration ────────────────────────────────────────────────────────────

PANO_URL="http://localhost:4318"
# Mock panopticon-protocol sync receiver spawned in Phase 2 (test-sync-server.ts)
MOCK_SYNC_URL="http://localhost:9801"
TOOL="sync-validation"

# Self-contained coding tasks — each exercises Read/Write/Bash tool use
TASKS=(
  "Write fib.py with a function that returns the nth Fibonacci number iteratively. Create test_fib.py that asserts fib(0)==0, fib(1)==1, fib(10)==55. Run python3 test_fib.py."
  "Write fizzbuzz.py that prints FizzBuzz for numbers 1 to 30. Run it with python3 fizzbuzz.py."
  "Create sample.txt containing 'the quick brown fox jumps over the lazy dog the quick brown fox'. Write word_count.py that reads sample.txt and prints each word with its count. Run it."
  "Write calc.py with add subtract multiply divide functions. Write test_calc.py testing each including divide-by-zero raising ValueError. Run python3 test_calc.py."
  "Read all .py files in the current directory. Add a one-line docstring to any function that lacks one. Show the final version of each file you changed."
)

# ─── Phase 1: Prerequisites ──────────────────────────────────────────────────
log_phase 1 "Prerequisites"

HAS_CLAUDE="" HAS_CODEX="" HAS_GEMINI=""
[ -n "${ANTHROPIC_API_KEY:-}" ] && HAS_CLAUDE=1
[ -n "${OPENAI_API_KEY:-}" ]    && HAS_CODEX=1
[ -n "${GEMINI_API_KEY:-}" ]    && HAS_GEMINI=1

if [ -z "$HAS_CLAUDE" ] && [ -z "$HAS_CODEX" ] && [ -z "$HAS_GEMINI" ]; then
  log_skip "No API keys set (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)"
  exit 0
fi

AVAILABLE=""
[ -n "$HAS_CLAUDE" ] && AVAILABLE="${AVAILABLE} claude"
[ -n "$HAS_CODEX" ]  && AVAILABLE="${AVAILABLE} codex"
[ -n "$HAS_GEMINI" ] && AVAILABLE="${AVAILABLE} gemini"
log_info "Available CLIs:${AVAILABLE}"

# ─── Phase 2: Clean Install ──────────────────────────────────────────────────
log_phase 2 "Clean Install"

npm uninstall -g fml panopticon 2>/dev/null || true
rm -rf "$HOME/.local/share/panopticon" "$HOME/.config/panopticon" 2>/dev/null || true
log_info "Cleared prior installs and data"

if ! command -v panopticon &>/dev/null; then
  log_fail "panopticon CLI not found in PATH"; print_summary
fi

# Install once for all supported targets to avoid repeated daemon
# restarts against the same local DB during setup.
panopticon install --target all --proxy --force
log_pass "panopticon install --target all --proxy"

# Spawn the mock panopticon-protocol sync receiver in the background. This
# replaces the old setup that pointed sync at LGTM — #116 unified the sync
# protocol to /v1/sync and removed OTLP serialization, so LGTM can no longer
# receive panopticon sync data. The mock writes incoming rows into its own
# sqlite DBs and exposes GET /stats for the test to query.
log_info "Starting mock sync receiver on localhost:9801..."
node /opt/panopticon/dist/test-sync-server.js \
  > /tmp/test-sync-server.log 2>&1 &
MOCK_SYNC_PID=$!
# shellcheck disable=SC2064
trap "kill ${MOCK_SYNC_PID} 2>/dev/null || true" EXIT

# Wait for the mock server to accept connections
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "${MOCK_SYNC_URL}/stats" >/dev/null 2>&1; then
    log_pass "Mock sync receiver is up at ${MOCK_SYNC_URL}"
    break
  fi
  sleep 1
  if [ "$i" = "10" ]; then
    log_fail "Mock sync receiver did not start within 10s"
    cat /tmp/test-sync-server.log 2>/dev/null || true
    print_summary
  fi
done

# Configure panopticon to sync into the mock receiver. `panopticon sync add`
# is an API call into the running server that writes the target to the
# config file — but the server loads cfg.sync.targets ONCE at startup and
# never reloads, so we must stop + start to pick up the new target.
# (`panopticon install` happened to start a server at the end of Phase 3;
# that server's in-memory config has zero sync targets.)
panopticon sync add e2e-sync-val "$MOCK_SYNC_URL"
log_pass "Sync target 'e2e-sync-val' added -> $MOCK_SYNC_URL"

SYNC_TARGETS=$(panopticon sync list 2>/dev/null || echo "")
if echo "$SYNC_TARGETS" | grep -q "e2e-sync-val"; then
  log_pass "Sync target persisted in config"
else
  log_fail "Sync target not found in 'sync list'"
fi

log_info "Restarting panopticon so the new sync target takes effect..."
panopticon stop 2>/dev/null || true
# Give the daemon a moment to actually release its port
sleep 1
panopticon start
wait_for_server 30
log_pass "Panopticon restarted with sync target loaded"

# ─── Phase 3: Verify Install Artifacts ───────────────────────────────────────
log_phase 3 "Verify Install Artifacts"

assert_file_exists "$DB_PATH" "Database file"
assert_file_exists "$HOME/.bashrc" "Shell RC file"
assert_grep "$HOME/.bashrc" "OTEL_EXPORTER_OTLP_ENDPOINT" "OTel endpoint in .bashrc"

if [ -n "$HAS_CLAUDE" ]; then
  log_info "── Claude artifacts ──"
  assert_file_exists "$HOME/.claude/settings.json" "Claude settings.json"
  assert_grep "$HOME/.claude/settings.json" "panopticon" "Claude plugin registered"
  assert_grep "$HOME/.bashrc" "CLAUDE_CODE_ENABLE_TELEMETRY=1" \
    "Claude telemetry env var in .bashrc"
  assert_grep "$HOME/.bashrc" "ANTHROPIC_BASE_URL=http://localhost:4318/proxy/anthropic" \
    "Claude proxy env var in .bashrc"
fi

if [ -n "$HAS_CODEX" ]; then
  log_info "── Codex artifacts ──"
  assert_file_exists "$HOME/.codex/config.toml" "Codex config.toml"
  assert_grep "$HOME/.codex/config.toml" "codex_hooks" "Codex hooks enabled"
  assert_file_exists "$HOME/.codex/hooks.json" "Codex hooks.json"
  assert_grep "$HOME/.codex/hooks.json" "panopticon" "Codex hooks reference panopticon"
fi

if [ -n "$HAS_GEMINI" ]; then
  log_info "── Gemini artifacts ──"
  assert_file_exists "$HOME/.gemini/settings.json" "Gemini settings.json"
  assert_grep "$HOME/.gemini/settings.json" "hooks" "Gemini hooks configured"
  assert_grep "$HOME/.gemini/settings.json" "mcpServers" "Gemini MCP server registered"
  assert_grep "$HOME/.bashrc" "GEMINI_TELEMETRY_ENABLED=true" \
    "Gemini telemetry enabled env var in .bashrc"
  assert_grep "$HOME/.bashrc" "GEMINI_TELEMETRY_OTLP_ENDPOINT=http://localhost:4318" \
    "Gemini OTLP endpoint env var in .bashrc"
fi

# ─── Phase 4: Start Server + Doctor ──────────────────────────────────────────
log_phase 4 "Start Server + Doctor"

panopticon start
wait_for_server 30
log_pass "Panopticon server is running"

DOCTOR_OUTPUT=$(panopticon doctor --json 2>/dev/null || echo "{}")
log_info "Doctor output: $DOCTOR_OUTPUT"

if echo "$DOCTOR_OUTPUT" | jq -e '.checks[] | select(.label == "Database") | select(.status == "ok")' >/dev/null 2>&1; then
  log_pass "Doctor: Database ok"
else
  log_fail "Doctor: Database not ok"
fi

log_info "── Fresh-home MCP stdio smoke ──"
MCP_SMOKE_HOME="$(mktemp -d /tmp/pano-mcp-home.XXXXXX)"
if (
  cd /opt/panopticon
  env HOME="$MCP_SMOKE_HOME" node --input-type=module <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/mcp/server.js"],
  cwd: process.cwd(),
  env: { ...process.env, HOME: process.env.HOME },
});

const client = new Client({ name: "e2e-mcp-smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
if (!tools.tools.some((tool) => tool.name === "query")) {
  throw new Error("query tool was not exposed by the MCP server");
}

const result = await client.callTool({
  name: "query",
  arguments: { sql: "SELECT 1 AS ok" },
});
const text = result.content.find((item) => item.type === "text")?.text ?? "";
const rows = JSON.parse(text);
if (!Array.isArray(rows) || rows[0]?.ok !== 1) {
  throw new Error(`Unexpected query result: ${text}`);
}

await client.close();
EOF
); then
  log_pass "Fresh-home MCP server starts and answers query over stdio"
else
  log_fail "Fresh-home MCP stdio smoke failed"
  rm -rf "$MCP_SMOKE_HOME"
  print_summary
fi

assert_file_exists \
  "$MCP_SMOKE_HOME/.local/state/panopticon/logs/mcp-server.log" \
  "Fresh-home MCP log file"
rm -rf "$MCP_SMOKE_HOME"

# Source env vars (OTel endpoints, proxy URLs) written by install
# shellcheck disable=SC1090
source "$HOME/.bashrc" 2>/dev/null || true

# ─── Phase 5: Run Coding Sessions ────────────────────────────────────────────
log_phase 5 "Run Coding Sessions"

# Create initial workspace content
echo "# Panopticon Test Project" > /workspace/README.md
echo "This is a test file for E2E validation." >> /workspace/README.md

SESSIONS_RUN=0

if [ -n "$HAS_CLAUDE" ]; then
  log_info "── Claude Code sessions ──"
  rm -f /workspace/*.py /workspace/*.txt 2>/dev/null || true

  for i in 0 1 2; do
    log_info "Claude session $((i + 1))/3: ${TASKS[$i]:0:60}..."
    claude --print "${TASKS[$i]}" --max-turns 3 --model claude-haiku-4-5-20251001 \
      --allowedTools "Bash Write Edit Read Glob Grep" 2>&1 || log_info "Claude session $((i + 1)) exited"
    sleep 3
    SESSIONS_RUN=$((SESSIONS_RUN + 1))
  done
  log_pass "Claude: 3 sessions completed"
fi

if [ -n "$HAS_CODEX" ]; then
  log_info "── Codex sessions ──"
  rm -f /workspace/*.py /workspace/*.txt 2>/dev/null || true

  for i in 0 1; do
    log_info "Codex session $((i + 1))/2: ${TASKS[$i]:0:60}..."
    codex exec "${TASKS[$i]}" --full-auto --model o4-mini 2>&1 || log_info "Codex session $((i + 1)) exited"
    sleep 3
    SESSIONS_RUN=$((SESSIONS_RUN + 1))
  done
  log_pass "Codex: 2 sessions completed"
fi

if [ -n "$HAS_GEMINI" ]; then
  log_info "── Gemini sessions ──"
  rm -f /workspace/*.py /workspace/*.txt 2>/dev/null || true

  for i in 0 1; do
    log_info "Gemini session $((i + 1))/2: ${TASKS[$i]:0:60}..."
    gemini -p "${TASKS[$i]}" --yolo --model gemini-2.0-flash 2>&1 || log_info "Gemini session $((i + 1)) exited"
    sleep 3
    SESSIONS_RUN=$((SESSIONS_RUN + 1))
  done
  log_pass "Gemini: 2 sessions completed"
fi

log_pass "Total sessions run: ${SESSIONS_RUN}"

# ─── Phase 6: Database Validation ────────────────────────────────────────────
log_phase 6 "Database Validation"

# Give trailing telemetry a moment to land
sleep 10

wait_for_db_rows hook_events 4 30 || true
wait_for_db_rows otel_logs 1 15 || true
wait_for_db_rows otel_metrics 1 15 || true

dump_db_debug
dump_db_samples

# ── 6a: Structural checks ────────────────────────────────────────────────────

assert_db_count "SELECT COUNT(*) FROM hook_events;" 4 \
  "hook_events: >= 4 total rows"

assert_db_not_empty \
  "SELECT 1 FROM hook_events WHERE event_type = 'SessionStart' LIMIT 1;" \
  "hook_events: has SessionStart"

assert_db_not_empty \
  "SELECT 1 FROM hook_events WHERE event_type = 'UserPromptSubmit' LIMIT 1;" \
  "hook_events: has UserPromptSubmit"

# PreToolUse: required for Claude/Gemini, best-effort for Codex
if [ -n "$HAS_CLAUDE" ] || [ -n "$HAS_GEMINI" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM hook_events WHERE event_type = 'PreToolUse' LIMIT 1;" \
    "hook_events: has PreToolUse"
else
  PRE_TOOL_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM hook_events WHERE event_type = 'PreToolUse';" 2>/dev/null || echo "0")
  if [ "$PRE_TOOL_COUNT" -gt 0 ]; then
    log_pass "hook_events: has PreToolUse (${PRE_TOOL_COUNT} rows)"
  else
    log_info "hook_events: no PreToolUse (Codex --full-auto may not emit tool hooks)"
  fi
fi

# PostToolUse or session completion
POST_OR_END_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM hook_events WHERE event_type IN ('PostToolUse','SessionEnd','Stop');" 2>/dev/null || echo "0")
if [ "$POST_OR_END_COUNT" -gt 0 ]; then
  log_pass "hook_events: has PostToolUse or session completion (${POST_OR_END_COUNT} rows)"
else
  log_info "hook_events: no PostToolUse/SessionEnd/Stop (may not appear with limited turns)"
fi

assert_db_count \
  "SELECT COUNT(DISTINCT session_id) FROM hook_events;" "$SESSIONS_RUN" \
  "hook_events: >= ${SESSIONS_RUN} distinct sessions"

assert_db_count "SELECT COUNT(*) FROM otel_logs;" 1 \
  "otel_logs: >= 1 row"

assert_db_count "SELECT COUNT(*) FROM otel_metrics;" 1 \
  "otel_metrics: >= 1 row"

# ── 6b: hook_events column correctness ───────────────────────────────────────

assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE session_id IS NULL OR session_id = '';" \
  "hook_events: all session_id values are non-empty"

assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE event_type NOT IN ('SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop');" \
  "hook_events: all event_type values are canonical"

assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE timestamp_ms < 1700000000000 OR timestamp_ms > (strftime('%s','now') + 60) * 1000;" \
  "hook_events: all timestamp_ms values are reasonable epoch ms"

assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE event_type IN ('PreToolUse','PostToolUse','PostToolUseFailure')
     AND (tool_name IS NULL OR tool_name = '');" \
  "hook_events: tool_name populated for all tool events"

assert_db_zero \
  "SELECT COUNT(*) FROM hook_events WHERE payload IS NULL;" \
  "hook_events: payload is never NULL"

assert_db_zero \
  "SELECT COUNT(*) FROM hook_events WHERE length(payload) = 0;" \
  "hook_events: payload is never empty"

assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE event_type = 'UserPromptSubmit'
     AND user_prompt IS NOT NULL AND user_prompt != ''
   LIMIT 1;" \
  "hook_events: user_prompt populated for UserPromptSubmit"

# Fidelity: prompt text should contain part of our coding task
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE event_type = 'UserPromptSubmit'
     AND (user_prompt LIKE '%fib%' OR user_prompt LIKE '%Fibonacci%' OR user_prompt LIKE '%fizzbuzz%')
   LIMIT 1;" \
  "hook_events: user_prompt contains our test prompt text"

# cwd populated for SessionStart
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE event_type = 'SessionStart'
     AND cwd IS NOT NULL AND cwd LIKE '%workspace%'
   LIMIT 1;" \
  "hook_events: cwd is /workspace for SessionStart"

# target column always populated
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events WHERE target IS NULL OR target = '';" \
  "hook_events: target column is always populated"

# CLI-specific tool name checks
if [ -n "$HAS_CLAUDE" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM hook_events
     WHERE tool_name IN ('Read','Write','Edit','Bash','Glob','Grep','Agent','WebFetch','WebSearch')
     LIMIT 1;" \
    "hook_events: has recognized Claude Code tool name"
fi

if [ -n "$HAS_CLAUDE" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM hook_events WHERE target = 'claude' LIMIT 1;" \
    "hook_events: target is 'claude' for Claude sessions"
fi
if [ -n "$HAS_CODEX" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM hook_events WHERE target = 'codex' LIMIT 1;" \
    "hook_events: target is 'codex' for Codex sessions"
fi
if [ -n "$HAS_GEMINI" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM hook_events WHERE target = 'gemini' LIMIT 1;" \
    "hook_events: target is 'gemini' for Gemini sessions"
fi

# ── 6c: otel_metrics column correctness ──────────────────────────────────────

# Token metrics may not be present with cheaper models (e.g. Haiku doesn't do
# tool calls in --print mode, generating no proxy traffic and thus no token
# metrics). Check if present and validate content; otherwise best-effort.
TOKEN_METRIC_COUNT=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM otel_metrics
   WHERE name IN ('token.usage','claude_code.token.usage','gen_ai.client.token.usage','gemini_cli.token.usage');" \
  2>/dev/null || echo "0")

if [ "$TOKEN_METRIC_COUNT" -gt 0 ]; then
  log_pass "otel_metrics: has token metrics (${TOKEN_METRIC_COUNT} rows)"

  assert_db_zero \
    "SELECT COUNT(*) FROM otel_metrics WHERE name LIKE '%token%' AND value < 0;" \
    "otel_metrics: all token metrics have non-negative values"

  assert_db_zero \
    "SELECT COUNT(*) FROM otel_metrics
     WHERE name LIKE '%token%' AND (session_id IS NULL OR session_id = '');" \
    "otel_metrics: session_id populated for token metrics"

  assert_db_not_empty \
    "SELECT 1 FROM otel_metrics
     WHERE name LIKE '%token%'
       AND (json_extract(attributes, '$.model') IS NOT NULL
         OR json_extract(attributes, '$.\"gen_ai.response.model\"') IS NOT NULL)
     LIMIT 1;" \
    "otel_metrics: token metrics have model in attributes"

  assert_db_not_empty \
    "SELECT 1 FROM otel_metrics
     WHERE name LIKE '%token%'
       AND (json_extract(attributes, '$.type') IS NOT NULL
         OR json_extract(attributes, '$.\"gen_ai.token.type\"') IS NOT NULL
         OR json_extract(attributes, '$.token_type') IS NOT NULL)
     LIMIT 1;" \
    "otel_metrics: token metrics have token_type in attributes"
else
  log_info "otel_metrics: no token metrics (cheap models may not generate them)"
fi

# timestamp_ns: at least some must be reasonable regardless of metric type
assert_db_not_empty \
  "SELECT 1 FROM otel_metrics
   WHERE timestamp_ns >= 1700000000000000000
     AND timestamp_ns <= (strftime('%s','now') + 60) * 1000000000
   LIMIT 1;" \
  "otel_metrics: at least some timestamp_ns are reasonable epoch ns"

# ── 6d: otel_logs column correctness ─────────────────────────────────────────

# session_id: strict for Claude/Gemini, lenient for Codex-only
if [ -n "$HAS_CLAUDE" ] || [ -n "$HAS_GEMINI" ]; then
  assert_db_zero \
    "SELECT COUNT(*) FROM otel_logs WHERE session_id IS NULL OR session_id = '';" \
    "otel_logs: session_id is always populated"
else
  assert_db_not_empty \
    "SELECT 1 FROM otel_logs WHERE session_id IS NOT NULL AND session_id != '' LIMIT 1;" \
    "otel_logs: at least some logs have session_id"
fi

# body: never null/empty (used as event_type in sessionTimeline, searched in searchEvents)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_logs WHERE body IS NULL OR body = '';" \
  "otel_logs: body is always populated"

# body: has at least one recognized type
assert_db_not_empty \
  "SELECT 1 FROM otel_logs
   WHERE body IN ('api_request','claude_code.user_prompt','claude_code.tool_decision','claude_code.tool_result','claude_code.api_request')
   LIMIT 1;" \
  "otel_logs: has recognized log body types"

# attributes: valid JSON
assert_db_zero \
  "SELECT COUNT(*) FROM otel_logs
   WHERE attributes IS NOT NULL AND json_valid(attributes) = 0;" \
  "otel_logs: all attributes are valid JSON"

# timestamp_ns: strict for Claude/Gemini, lenient for Codex-only
if [ -n "$HAS_CLAUDE" ] || [ -n "$HAS_GEMINI" ]; then
  assert_db_zero \
    "SELECT COUNT(*) FROM otel_logs
     WHERE timestamp_ns < 1700000000000000000
        OR timestamp_ns > (strftime('%s','now') + 60) * 1000000000;" \
    "otel_logs: all timestamp_ns values are reasonable epoch ns"
else
  assert_db_not_empty \
    "SELECT 1 FROM otel_logs
     WHERE timestamp_ns >= 1700000000000000000
       AND timestamp_ns <= (strftime('%s','now') + 60) * 1000000000
     LIMIT 1;" \
    "otel_logs: at least some timestamp_ns are reasonable epoch ns"
fi

# ── 6e: Cross-table correlation ──────────────────────────────────────────────

assert_db_not_empty \
  "SELECT 1 FROM hook_events h
   INNER JOIN otel_logs l ON h.session_id = l.session_id
   LIMIT 1;" \
  "Cross-table: session_id correlates between hook_events and otel_logs"

# hook_events ↔ otel_metrics correlation (strict for Claude/Gemini, lenient for Codex-only)
if [ -n "$HAS_CLAUDE" ] || [ -n "$HAS_GEMINI" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM hook_events h
     INNER JOIN otel_metrics m ON h.session_id = m.session_id
     LIMIT 1;" \
    "Cross-table: session_id correlates between hook_events and otel_metrics"
else
  METRIC_CORRELATION=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM hook_events h INNER JOIN otel_metrics m ON h.session_id = m.session_id;" 2>/dev/null || echo "0")
  if [ "$METRIC_CORRELATION" -gt 0 ]; then
    log_pass "Cross-table: session_id correlates between hook_events and otel_metrics"
  else
    log_info "Cross-table: no hook_events <-> otel_metrics overlap (Codex uses different session tracking)"
  fi
fi

# ── 6f: Proxy checks ────────────────────────────────────────────────────────

assert_db_not_empty \
  "SELECT 1 FROM otel_logs WHERE body = 'api_request' AND attributes LIKE '%proxy%' LIMIT 1;" \
  "Proxy: api_request logs with source=proxy"

assert_db_not_empty \
  "SELECT 1 FROM otel_logs
   WHERE body = 'api_request'
     AND attributes LIKE '%proxy%'
     AND json_extract(attributes, '$.target') IS NOT NULL
     AND json_extract(attributes, '$.duration_ms') IS NOT NULL
     AND json_extract(attributes, '$.status') IS NOT NULL
   LIMIT 1;" \
  "Proxy: api_request log has target, duration_ms, status fields"

# ── 6g: sessions table ──────────────────────────────────────────────────────

assert_db_not_empty \
  "SELECT 1 FROM sessions LIMIT 1;" \
  "sessions: table is populated"

assert_db_not_empty \
  "SELECT 1 FROM sessions WHERE target IS NOT NULL LIMIT 1;" \
  "sessions: target is populated"

assert_db_not_empty \
  "SELECT 1 FROM sessions WHERE started_at_ms IS NOT NULL LIMIT 1;" \
  "sessions: started_at_ms is populated"

# CLI-specific session target checks
if [ -n "$HAS_CODEX" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM sessions WHERE target = 'codex' LIMIT 1;" \
    "sessions: has target = 'codex'"
fi
if [ -n "$HAS_GEMINI" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM sessions WHERE target = 'gemini' LIMIT 1;" \
    "sessions: has target = 'gemini'"
fi

# ─── Phase 7: Session File Scanner ───────────────────────────────────────────
log_phase 7 "Session File Scanner"

# Run the scanner to pick up session files written by the CLI sessions
SCAN_OUTPUT=$(panopticon scan 2>&1 || true)
log_info "Scan output: ${SCAN_OUTPUT}"

SCANNER_SESSIONS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sessions WHERE scanner_file_path IS NOT NULL;" 2>/dev/null || echo "0")
SCANNER_TURNS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM scanner_turns;" 2>/dev/null || echo "0")

log_info "Scanner: ${SCANNER_SESSIONS} sessions, ${SCANNER_TURNS} turns"

# Scanner should have found sessions from the CLI runs
assert_db_count "SELECT COUNT(*) FROM sessions WHERE scanner_file_path IS NOT NULL;" 1 \
  "sessions: >= 1 scanner-sourced session"

assert_db_count "SELECT COUNT(*) FROM scanner_turns;" 1 \
  "scanner_turns: >= 1 turn found"

# Scanner turns should have token data
assert_db_not_empty \
  "SELECT 1 FROM scanner_turns WHERE input_tokens > 0 OR output_tokens > 0 LIMIT 1;" \
  "scanner_turns: has turns with token data"

# Per-CLI scanner checks
if [ -n "$HAS_CLAUDE" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM sessions WHERE scanner_file_path IS NOT NULL AND target = 'claude' LIMIT 1;" \
    "scanner: found Claude session files"
  assert_db_not_empty \
    "SELECT 1 FROM scanner_turns WHERE source = 'claude' AND role = 'assistant' AND output_tokens > 0 LIMIT 1;" \
    "scanner: Claude turns have output tokens"
fi

if [ -n "$HAS_CODEX" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM sessions WHERE scanner_file_path IS NOT NULL AND target = 'codex' LIMIT 1;" \
    "scanner: found Codex session files"
fi

if [ -n "$HAS_GEMINI" ]; then
  assert_db_not_empty \
    "SELECT 1 FROM sessions WHERE scanner_file_path IS NOT NULL AND target = 'gemini' LIMIT 1;" \
    "scanner: found Gemini session files"
fi

# Show scanner summary
sqlite3 -header -column "$DB_PATH" \
  "SELECT target as source, COUNT(*) as sessions, SUM(turn_count) as turns,
     SUM(total_input_tokens) as input_tok, SUM(total_output_tokens) as output_tok
   FROM sessions WHERE scanner_file_path IS NOT NULL GROUP BY target;" 2>/dev/null || true

# `panopticon scan compare` was a debug-only reconciliation report removed
# in #124 along with direct DB access from the CLI. Skip it.

# ── 7a: Claim-backed intent projection ─────────────────────────────────────

log_info "── Claim-backed intent projection ──"

assert_db_count "SELECT COUNT(*) FROM intent_units;" 1 \
  "intent_units: >= 1 projected intent"

assert_db_count "SELECT COUNT(*) FROM intent_edits;" 1 \
  "intent_edits: >= 1 projected edit"

assert_db_not_empty \
  "SELECT 1 FROM intent_units
   WHERE prompt_text IS NOT NULL AND prompt_text != ''
   LIMIT 1;" \
  "intent_units: prompt_text is populated"

assert_db_not_empty \
  "SELECT 1 FROM intent_edits
   WHERE landed IS NOT NULL
   LIMIT 1;" \
  "intent_edits: landed status is populated"

assert_db_not_empty \
  "SELECT 1 FROM intent_edits
   WHERE landed_reason IS NOT NULL AND landed_reason != ''
   LIMIT 1;" \
  "intent_edits: has at least one populated landed_reason"

# Show sample projected intents
sqlite3 -header -column "$DB_PATH" \
  "SELECT id, session_id, substr(prompt_text, 1, 60) AS prompt_preview,
          edit_count, landed_count
   FROM intent_units
   ORDER BY prompt_ts_ms DESC
   LIMIT 5;" 2>/dev/null || true

sqlite3 -header -column "$DB_PATH" \
  "SELECT intent_unit_id, file_path, landed, landed_reason,
          substr(new_string_snippet, 1, 40) AS new_snippet
   FROM intent_edits
   ORDER BY timestamp_ms DESC
   LIMIT 5;" 2>/dev/null || true

# ── 7b: OTLP traces (otel_spans) ───────────────────────────────────────────

log_info "── OTLP trace storage ──"

SPAN_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM otel_spans;" 2>/dev/null || echo "0")
log_info "otel_spans: ${SPAN_COUNT} rows"

if [ "$SPAN_COUNT" -gt 0 ]; then
  log_pass "otel_spans: table is populated (${SPAN_COUNT} spans)"

  assert_db_zero \
    "SELECT COUNT(*) FROM otel_spans WHERE trace_id IS NULL OR trace_id = '';" \
    "otel_spans: all trace_id values are non-empty"

  assert_db_zero \
    "SELECT COUNT(*) FROM otel_spans WHERE span_id IS NULL OR span_id = '';" \
    "otel_spans: all span_id values are non-empty"

  assert_db_zero \
    "SELECT COUNT(*) FROM otel_spans WHERE name IS NULL OR name = '';" \
    "otel_spans: all spans have a name"

  assert_db_zero \
    "SELECT COUNT(*) FROM otel_spans
     WHERE start_time_ns <= 0 OR end_time_ns <= 0;" \
    "otel_spans: all spans have positive timestamps"

  assert_db_zero \
    "SELECT COUNT(*) FROM otel_spans WHERE end_time_ns < start_time_ns;" \
    "otel_spans: end_time >= start_time for all spans"

  assert_db_not_empty \
    "SELECT 1 FROM otel_spans WHERE session_id IS NOT NULL AND session_id != '' LIMIT 1;" \
    "otel_spans: at least some spans have session_id"

  # Check for parent-child relationships (nested spans)
  CHILD_SPANS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM otel_spans WHERE parent_span_id IS NOT NULL AND parent_span_id != '';" 2>/dev/null || echo "0")
  if [ "$CHILD_SPANS" -gt 0 ]; then
    log_pass "otel_spans: has parent-child span relationships (${CHILD_SPANS} child spans)"
  else
    log_info "otel_spans: no nested spans (single-level traces)"
  fi

  # Show sample spans
  sqlite3 -header -column "$DB_PATH" \
    "SELECT trace_id, span_id, name, kind, session_id,
            (end_time_ns - start_time_ns) / 1000000 AS duration_ms
     FROM otel_spans ORDER BY start_time_ns LIMIT 5;" 2>/dev/null || true
else
  log_info "otel_spans: empty (CLIs may not emit OTLP traces)"
fi

# ── 7c: Session file archiving ──────────────────────────────────────────────

log_info "── Session file archive ──"

DATA_DIR=$(dirname "$DB_PATH")
ARCHIVE_DIR="${DATA_DIR}/archive"

if [ -d "$ARCHIVE_DIR" ]; then
  ARCHIVE_COUNT=$(find "$ARCHIVE_DIR" -name '*.jsonl.gz' 2>/dev/null | wc -l | tr -d ' ')
  log_pass "archive: directory exists with ${ARCHIVE_COUNT} files"

  if [ "$ARCHIVE_COUNT" -gt 0 ]; then
    # Verify archives are valid gzip
    CORRUPT=0
    while IFS= read -r f; do
      if ! gzip -t "$f" 2>/dev/null; then
        CORRUPT=$((CORRUPT + 1))
      fi
    done < <(find "$ARCHIVE_DIR" -name '*.jsonl.gz')

    if [ "$CORRUPT" -eq 0 ]; then
      log_pass "archive: all ${ARCHIVE_COUNT} files are valid gzip"
    else
      log_fail "archive: ${CORRUPT}/${ARCHIVE_COUNT} files are corrupt"
    fi

    # Verify archives are organized by session_id
    ARCHIVE_SESSIONS=$(find "$ARCHIVE_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    if [ "$ARCHIVE_SESSIONS" -gt 0 ]; then
      log_pass "archive: ${ARCHIVE_SESSIONS} session directories"
    else
      log_fail "archive: no session subdirectories"
    fi

    # Show archive structure
    log_info "Archive contents:"
    find "$ARCHIVE_DIR" -name '*.jsonl.gz' -exec ls -lh {} \; 2>/dev/null | head -10
  else
    log_info "archive: directory exists but no .jsonl.gz files yet"
  fi
else
  log_info "archive: directory not created (scanner may not have archived)"
fi

# ── 7d: Session summaries ──────────────────────────────────────────────────
#
# Summaries live on the `sessions` table (summary, summary_version). The
# session_summary_deltas table was removed in #115 — the current code path
# writes a single denormalized summary per session instead of an append-only
# delta log. LLM-sourced summaries are currently TODO'd out in favor of a
# deterministic builder, so this section only asserts the deterministic path.

log_info "── Session summaries ──"

SESSIONS_WITH_SUMMARY=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sessions WHERE summary IS NOT NULL AND summary != '';" 2>/dev/null || echo "0")
log_info "Sessions with summary: ${SESSIONS_WITH_SUMMARY}"

if [ "$SCANNER_TURNS" -ge 10 ]; then
  assert_db_count "SELECT COUNT(*) FROM sessions WHERE summary IS NOT NULL AND summary != '';" 1 \
    "sessions: >= 1 session has a populated summary"

  assert_db_zero \
    "SELECT COUNT(*) FROM sessions WHERE summary IS NOT NULL AND (summary_version IS NULL OR summary_version <= 0);" \
    "sessions: every populated summary has summary_version > 0"

  # Show sample summaries
  sqlite3 -header -column "$DB_PATH" \
    "SELECT session_id, summary_version, substr(summary, 1, 80) AS summary_preview
     FROM sessions WHERE summary IS NOT NULL ORDER BY started_at_ms DESC LIMIT 5;" 2>/dev/null || true
else
  log_info "session summaries: skipped (only ${SCANNER_TURNS} turns, need >= 10)"
fi

# ─── Phase 8: Sync → Mock Receiver (Zero Data Loss) ─────────────────────────
#
# #116 unified sync to a custom /v1/sync JSON protocol that LGTM cannot
# receive. We validate sync end-to-end against a panopticon-protocol mock
# receiver (scripts/test-sync-server.ts) running on localhost:9801. The
# mock writes incoming rows into its own sqlite tables and exposes a /stats
# endpoint we can query to assert zero data loss.
log_phase 8 "Validate Sync Receiver (Zero Data Loss)"

# Sync has a `requireRepo: true` filter (since #142) that excludes sessions
# without a session_repositories entry — this is how e.g. subagent sessions
# (created inline from hook events with no cwd-based repo derivation) get
# skipped. Compare the mock receiver's counts against the set of LOCAL rows
# that actually WOULD be synced, not the raw table counts.
LOCAL_SESSIONS_RAW=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sessions;" 2>/dev/null || echo "0")
LOCAL_SESSIONS=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM sessions s
   WHERE EXISTS (SELECT 1 FROM session_repositories sr WHERE sr.session_id = s.session_id);" \
  2>/dev/null || echo "0")
LOCAL_HOOKS=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM hook_events he
   WHERE EXISTS (SELECT 1 FROM session_repositories sr WHERE sr.session_id = he.session_id);" \
  2>/dev/null || echo "0")
LOCAL_SCANNER_TURNS=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM scanner_turns st
   WHERE EXISTS (SELECT 1 FROM session_repositories sr WHERE sr.session_id = st.session_id);" \
  2>/dev/null || echo "0")

log_info "Local syncable counts: ${LOCAL_SESSIONS}/${LOCAL_SESSIONS_RAW} sessions (subagents skipped), ${LOCAL_HOOKS} hooks, ${LOCAL_SCANNER_TURNS} scanner turns"

# Poll the mock receiver until row counts match. The sync loop ticks every
# 1-30s; late hooks can arrive after the last cycle, so we wait instead of
# snapshotting.
SYNC_TIMEOUT=90
elapsed=0
log_info "Waiting up to ${SYNC_TIMEOUT}s for sync to catch up..."
while [ "$elapsed" -lt "$SYNC_TIMEOUT" ]; do
  STATS_JSON=$(curl -sf "${MOCK_SYNC_URL}/stats" 2>/dev/null || echo "{}")
  REMOTE_SESSIONS=$(echo "$STATS_JSON" | jq -r '.sessions // 0' 2>/dev/null || echo "0")
  REMOTE_HOOKS=$(echo "$STATS_JSON" | jq -r '[.tables[] | select(.tbl=="hook_events") | .cnt] | add // 0' 2>/dev/null || echo "0")
  REMOTE_TURNS=$(echo "$STATS_JSON" | jq -r '[.tables[] | select(.tbl=="scanner_turns") | .cnt] | add // 0' 2>/dev/null || echo "0")

  if [ "$REMOTE_SESSIONS" -ge "$LOCAL_SESSIONS" ] \
    && [ "$REMOTE_HOOKS" -ge "$LOCAL_HOOKS" ] \
    && [ "$REMOTE_TURNS" -ge "$LOCAL_SCANNER_TURNS" ]; then
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

log_info "Mock receiver /stats: $(echo "$STATS_JSON" | jq -c '.' 2>/dev/null || echo "$STATS_JSON")"

# On any sync failure, dump enough state to diagnose whether the issue is:
#   a) sync isn't running at all (no target_session_sync rows)
#   b) sessions aren't being attributed to repos (sync filters them out)
#   c) sync is running but POSTs are failing (check panopticon server log)
dump_sync_debug() {
  log_info "── sync debug ──"
  log_info "session_repositories count: $(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM session_repositories;' 2>/dev/null || echo 'N/A')"
  log_info "target_session_sync count: $(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM target_session_sync;' 2>/dev/null || echo 'N/A')"
  sqlite3 -header -column "$DB_PATH" \
    "SELECT target, confirmed, COUNT(*) AS n FROM target_session_sync GROUP BY target, confirmed;" 2>/dev/null || true
  log_info "── panopticon sync config ──"
  panopticon sync list 2>&1 || true
  log_info "── panopticon doctor ──"
  panopticon doctor --json 2>&1 | jq '.checks[] | select(.label == "Sync" or .label == "Data Flow")' 2>/dev/null || panopticon doctor 2>&1
  log_info "── can panopticon server reach mock? ──"
  curl -sv "${MOCK_SYNC_URL}/stats" 2>&1 | head -20 || true
  log_info "── mock sync server log (last 40 lines) ──"
  tail -n 40 /tmp/test-sync-server.log 2>/dev/null || echo "  (no mock log)"
  log_info "── panopticon log files ──"
  ls -la "$HOME/.local/state/panopticon/logs/" 2>&1 || echo "  (no logs dir)"
  log_info "── panopticon server log (last 80 lines) ──"
  tail -n 80 "$HOME/.local/state/panopticon/logs/server.log" 2>&1 || echo "  (no server log)"
  log_info "── panopticon hook-handler log (last 20 lines) ──"
  tail -n 20 "$HOME/.local/state/panopticon/logs/hook-handler.log" 2>&1 || echo "  (no hook log)"
}

# Session count — the most load-bearing metric. Sync is gated on session
# confirmation, so every other table depends on sessions arriving first.
if [ "$REMOTE_SESSIONS" -ge "$LOCAL_SESSIONS" ] && [ "$LOCAL_SESSIONS" -gt 0 ]; then
  log_pass "sessions synced: ${REMOTE_SESSIONS}/${LOCAL_SESSIONS}"
else
  log_fail "sessions NOT synced: ${REMOTE_SESSIONS}/${LOCAL_SESSIONS}"
  dump_sync_debug
fi

# Hook events
if [ "$REMOTE_HOOKS" -ge "$LOCAL_HOOKS" ]; then
  log_pass "hook_events synced: ${REMOTE_HOOKS}/${LOCAL_HOOKS}"
else
  log_fail "hook_events NOT fully synced: ${REMOTE_HOOKS}/${LOCAL_HOOKS}"
fi

# Scanner turns (the table that most depends on the scan loop running)
if [ "$LOCAL_SCANNER_TURNS" -gt 0 ]; then
  if [ "$REMOTE_TURNS" -ge "$LOCAL_SCANNER_TURNS" ]; then
    log_pass "scanner_turns synced: ${REMOTE_TURNS}/${LOCAL_SCANNER_TURNS}"
  else
    log_fail "scanner_turns NOT fully synced: ${REMOTE_TURNS}/${LOCAL_SCANNER_TURNS}"
  fi
fi

# ─── Phase 9: Verify Per-Session Sync Watermarks ────────────────────────────
log_phase 9 "Verify Sync Watermarks"

SYNC_LIST=$(panopticon sync list 2>/dev/null || echo "")
if echo "$SYNC_LIST" | grep -q "e2e-sync-val"; then
  log_pass "Sync target 'e2e-sync-val' is active"
else
  log_fail "Sync target 'e2e-sync-val' not found"
fi

# Post-#119, per-session sync state lives in target_session_sync.
# A confirmed session is one the receiver acknowledged (Phase 1 of sync).
# synced_seq >= sync_seq means every row for that session has been shipped.
CONFIRMED_SESSIONS=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM target_session_sync WHERE target='e2e-sync-val' AND confirmed=1;" \
  2>/dev/null || echo "-1")
UNSYNCED_SESSIONS=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM target_session_sync
   WHERE target='e2e-sync-val' AND confirmed=1 AND synced_seq < sync_seq;" \
  2>/dev/null || echo "-1")

if [ "$CONFIRMED_SESSIONS" = "-1" ] || [ "$UNSYNCED_SESSIONS" = "-1" ]; then
  log_fail "target_session_sync query failed"
elif [ "$CONFIRMED_SESSIONS" = "0" ]; then
  # Vacuous pass would hide the case where sync never ran at all.
  log_fail "no confirmed sessions for target 'e2e-sync-val' — sync didn't complete Phase 1"
elif [ "$UNSYNCED_SESSIONS" = "0" ]; then
  log_pass "all ${CONFIRMED_SESSIONS} confirmed sessions fully synced (synced_seq >= sync_seq)"
else
  log_fail "${UNSYNCED_SESSIONS}/${CONFIRMED_SESSIONS} confirmed sessions have pending data (synced_seq < sync_seq)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
print_summary
