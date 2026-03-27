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
#   6. Sync to Grafana LGTM with zero data loss
#   7. Watermarks advance to completion
#
# Requires at least one API key. Best results with all three for cross-CLI coverage.
set -euo pipefail
source /opt/e2e/scripts/lib.sh

# ─── Configuration ────────────────────────────────────────────────────────────

PANO_URL="http://localhost:4318"
LGTM_OTLP_URL="http://otel-lgtm:4318"
LOKI_URL="http://otel-lgtm:3100"
GRAFANA_URL="http://otel-lgtm:3000"
PROM_URL="http://otel-lgtm:9090"
TOOL="sync-validation"

# Bodies filtered by hook dedup (must match HOOK_COVERED_BODIES in reader.ts)
HOOK_COVERED_BODIES="'claude_code.user_prompt','claude_code.tool_decision','claude_code.tool_result','gemini_cli.user_prompt','gemini_cli.tool_call','gemini_cli.hook_call'"

# Self-contained coding tasks — each exercises Read/Write/Bash tool use
TASKS=(
  "Write fib.py with a function that returns the nth Fibonacci number iteratively. Create test_fib.py that asserts fib(0)==0, fib(1)==1, fib(10)==55. Run python3 test_fib.py."
  "Write fizzbuzz.py that prints FizzBuzz for numbers 1 to 30. Run it with python3 fizzbuzz.py."
  "Create sample.txt containing 'the quick brown fox jumps over the lazy dog the quick brown fox'. Write word_count.py that reads sample.txt and prints each word with its count. Run it."
  "Write calc.py with add subtract multiply divide functions. Write test_calc.py testing each including divide-by-zero raising ValueError. Run python3 test_calc.py."
  "Read all .py files in the current directory. Add a one-line docstring to any function that lacks one. Show the final version of each file you changed."
)

# ─── Helpers ──────────────────────────────────────────────────────────────────

wait_for_grafana() {
  local timeout="${1:-60}" elapsed=0
  log_info "Waiting for Grafana LGTM (timeout: ${timeout}s)..."
  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -sf "${GRAFANA_URL}/api/health" >/dev/null 2>&1; then
      log_info "Grafana LGTM is up after ${elapsed}s"
      return 0
    fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  log_fail "Grafana LGTM did not start within ${timeout}s"; return 1
}

wait_for_lgtm_otlp() {
  local timeout="${1:-60}" elapsed=0
  log_info "Waiting for LGTM OTLP receiver (timeout: ${timeout}s)..."
  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -sf -o /dev/null -w "%{http_code}" \
        -X POST "${LGTM_OTLP_URL}/v1/logs" \
        -H "Content-Type: application/json" \
        -d '{"resourceLogs":[]}' 2>/dev/null | grep -q "200"; then
      log_info "LGTM OTLP receiver is up after ${elapsed}s"
      return 0
    fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  log_fail "LGTM OTLP receiver did not start within ${timeout}s"; return 1
}

# Poll Loki via count_over_time (no limit issues at any volume).
# Sets LOKI_RESULT as a global variable (avoids $() stdout capture issues).
poll_loki_count() {
  local expected="$1" timeout="${2:-180}" elapsed=0
  LOKI_RESULT=0
  log_info "Waiting for >= ${expected} entries in Loki (timeout: ${timeout}s)..."

  while [ "$elapsed" -lt "$timeout" ]; do
    LOKI_RESULT=$(curl -sf -G "${LOKI_URL}/loki/api/v1/query" \
      --data-urlencode 'query=sum(count_over_time({service_name="panopticon"}[30m]))' \
      --data-urlencode "time=$(date +%s)" 2>/dev/null \
      | jq -r '.data.result[0].value[1] // "0"' 2>/dev/null || echo "0")
    LOKI_RESULT="${LOKI_RESULT%%.*}"

    if [ "$LOKI_RESULT" -ge "$expected" ] 2>/dev/null; then
      log_info "Loki reached ${LOKI_RESULT} entries after ${elapsed}s"
      return 0
    fi
    sleep 3; elapsed=$((elapsed + 3))
  done

  log_info "Loki timed out at ${LOKI_RESULT}/${expected} after ${timeout}s"
  return 1
}

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

wait_for_grafana 60
wait_for_lgtm_otlp 60
log_pass "Grafana LGTM stack is ready"

# ─── Phase 2: Clean Install ──────────────────────────────────────────────────
log_phase 2 "Clean Install"

npm uninstall -g fml panopticon 2>/dev/null || true
rm -rf "$HOME/.local/share/panopticon" "$HOME/.config/panopticon" 2>/dev/null || true
log_info "Cleared prior installs and data"

if ! command -v panopticon &>/dev/null; then
  log_fail "panopticon CLI not found in PATH"; print_summary
fi

# Install for each available CLI target
for target in $AVAILABLE; do
  panopticon install --target "$target" --proxy --force
  log_pass "panopticon install --target $target --proxy"
done

# Add Grafana LGTM as sync target
panopticon sync add e2e-sync-val "$LGTM_OTLP_URL"
log_pass "Sync target 'e2e-sync-val' added -> $LGTM_OTLP_URL"

SYNC_TARGETS=$(panopticon sync list 2>/dev/null || echo "")
if echo "$SYNC_TARGETS" | grep -q "e2e-sync-val"; then
  log_pass "Sync target persisted in config"
else
  log_fail "Sync target not found in 'sync list'"
fi

# ─── Phase 3: Verify Install Artifacts ───────────────────────────────────────
log_phase 3 "Verify Install Artifacts"

assert_file_exists "$DB_PATH" "Database file"
assert_file_exists "$HOME/.bashrc" "Shell RC file"
assert_grep "$HOME/.bashrc" "OTEL_EXPORTER_OTLP_ENDPOINT" "OTel endpoint in .bashrc"

# Note: when installing multiple targets sequentially with --force, the last
# target's install rewrites the shell env block, so target-specific .bashrc
# vars (CLAUDE_CODE_ENABLE_TELEMETRY, ANTHROPIC_BASE_URL, GEMINI_TELEMETRY_*)
# only persist for the last target installed. We only assert the shared OTEL var
# and check target-specific config files which are not overwritten.

if [ -n "$HAS_CLAUDE" ]; then
  log_info "── Claude artifacts ──"
  assert_file_exists "$HOME/.claude/settings.json" "Claude settings.json"
  assert_grep "$HOME/.claude/settings.json" "panopticon" "Claude plugin registered"
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
    claude --print "${TASKS[$i]}" --max-turns 3 --model claude-haiku-4-5-20251001 --permission-mode bypassPermissions 2>&1 || log_info "Claude session $((i + 1)) exited"
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

# ─── Phase 7: Snapshot + Sync → Loki (Zero Data Loss) ───────────────────────
log_phase 7 "Validate Loki (Zero Data Loss)"

LOCAL_HOOKS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM hook_events;" 2>/dev/null || echo "0")
LOCAL_LOGS_TOTAL=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM otel_logs;" 2>/dev/null || echo "0")
LOCAL_METRICS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM otel_metrics;" 2>/dev/null || echo "0")

log_info "Local counts: ${LOCAL_HOOKS} hooks, ${LOCAL_LOGS_TOTAL} logs, ${LOCAL_METRICS} metrics"

# Determine expected Loki count (hooks always sync; otel_logs filtered by hook dedup)
CONFIG_PATH="$HOME/.local/share/panopticon/config.json"
HOOKS_INSTALLED=$(jq -r '.hooksInstalled // false' "$CONFIG_PATH" 2>/dev/null || echo "false")
LOCAL_LOGS_FILTERED=0

if [ "$HOOKS_INSTALLED" = "true" ]; then
  LOCAL_LOGS_SYNCED=$(sqlite3 "$DB_PATH" \
    "SELECT COUNT(*) FROM otel_logs WHERE body NOT IN (${HOOK_COVERED_BODIES});" 2>/dev/null || echo "0")
  LOCAL_LOGS_FILTERED=$((LOCAL_LOGS_TOTAL - LOCAL_LOGS_SYNCED))
  log_info "Hook dedup active: ${LOCAL_LOGS_SYNCED} logs synced, ${LOCAL_LOGS_FILTERED} filtered"
else
  LOCAL_LOGS_SYNCED="$LOCAL_LOGS_TOTAL"
fi

EXPECTED_LOKI=$((LOCAL_HOOKS + LOCAL_LOGS_SYNCED))
log_info "Expected Loki entries: ${EXPECTED_LOKI} (${LOCAL_HOOKS} hooks + ${LOCAL_LOGS_SYNCED} logs)"

if [ "$EXPECTED_LOKI" -eq 0 ]; then
  log_fail "Expected Loki count is 0 — no data was generated"
  print_summary
fi

poll_loki_count "$EXPECTED_LOKI" 180 || true
LOKI_COUNT="$LOKI_RESULT"

if [ "$LOKI_COUNT" -eq "$EXPECTED_LOKI" ] 2>/dev/null; then
  log_pass "ZERO DATA LOSS: Loki has exactly ${LOKI_COUNT}/${EXPECTED_LOKI} entries"
elif [ "$LOKI_COUNT" -gt "$EXPECTED_LOKI" ]; then
  EXTRA=$((LOKI_COUNT - EXPECTED_LOKI))
  if [ "$LOCAL_LOGS_FILTERED" -gt 0 ] && [ "$EXTRA" -le "$LOCAL_LOGS_FILTERED" ]; then
    log_pass "Loki has ${LOKI_COUNT}/${EXPECTED_LOKI} entries (${EXTRA} extra — within dedup margin)"
  else
    log_fail "DUPLICATE DATA: Loki has ${LOKI_COUNT}/${EXPECTED_LOKI} entries (${EXTRA} extra)"
  fi
else
  LOST=$((EXPECTED_LOKI - LOKI_COUNT))
  LOSS_PCT=$(( (LOST * 100) / EXPECTED_LOKI ))
  log_fail "DATA LOSS: Loki has ${LOKI_COUNT}/${EXPECTED_LOKI} entries (${LOST} missing, ${LOSS_PCT}% loss)"
fi

# Verify hook event types made it to Loki
for EVENT_TYPE in SessionStart UserPromptSubmit PreToolUse; do
  QUERY="{service_name=\"panopticon\"} | json | event_type=\"${EVENT_TYPE}\""
  COUNT=$(curl -sf -G "${LOKI_URL}/loki/api/v1/query_range" \
    --data-urlencode "query=${QUERY}" \
    --data-urlencode "start=$(($(date +%s) - 1800))" \
    --data-urlencode "end=$(date +%s)" \
    --data-urlencode "limit=100" 2>/dev/null \
    | jq -r '[.data.result[].values | length] | add // 0' 2>/dev/null || echo "0")

  if [ "$COUNT" -gt 0 ]; then
    log_pass "Loki event_type=${EVENT_TYPE}: ${COUNT} entries"
  else
    log_info "Loki event_type=${EVENT_TYPE}: not yet indexed (best-effort)"
  fi
done

# Verify OTLP passthrough logs (api_request from proxy)
OTEL_LOG_COUNT=$(curl -sf -G "${LOKI_URL}/loki/api/v1/query_range" \
  --data-urlencode 'query={service_name="panopticon"} |= "api_request"' \
  --data-urlencode "start=$(($(date +%s) - 1800))" \
  --data-urlencode "end=$(date +%s)" \
  --data-urlencode "limit=100" 2>/dev/null \
  | jq -r '[.data.result[].values | length] | add // 0' 2>/dev/null || echo "0")
if [ "$OTEL_LOG_COUNT" -gt 0 ]; then
  log_pass "Loki: OTLP api_request logs found (${OTEL_LOG_COUNT} entries)"
else
  log_info "Loki: OTLP api_request logs not yet indexed (best-effort)"
fi

# ─── Phase 8: Validate Prometheus Metrics ────────────────────────────────────
log_phase 8 "Validate Prometheus Metrics"

PROM_NAMES=$(curl -sf -G "${PROM_URL}/api/v1/label/__name__/values" 2>/dev/null \
  | jq -r '.data[]' 2>/dev/null || echo "")

TOKEN_METRICS=$(echo "$PROM_NAMES" | grep -i "token" || true)
if [ -n "$TOKEN_METRICS" ]; then
  FIRST_METRIC=$(echo "$TOKEN_METRICS" | head -1)
  SERIES_COUNT=$(curl -sf -G "${PROM_URL}/api/v1/query" \
    --data-urlencode "query=${FIRST_METRIC}" 2>/dev/null \
    | jq -r '.data.result | length' 2>/dev/null || echo "0")
  log_pass "Prometheus: ${FIRST_METRIC} has ${SERIES_COUNT} series"
  log_info "All token-related metrics: $(echo "$TOKEN_METRICS" | tr '\n' ', ')"
else
  CLI_METRICS=$(echo "$PROM_NAMES" | grep -i "claude\|panopticon\|codex\|gemini" || true)
  if [ -n "$CLI_METRICS" ]; then
    log_pass "Prometheus: found related metrics: $(echo "$CLI_METRICS" | head -3 | tr '\n' ', ')"
  else
    log_fail "Prometheus: no token/CLI metrics found"
    log_info "Available: $(echo "$PROM_NAMES" | head -5 | tr '\n' ', ')"
  fi
fi

# ─── Phase 9: Verify Sync Watermarks ────────────────────────────────────────
log_phase 9 "Verify Sync Watermarks"

SYNC_LIST=$(panopticon sync list 2>/dev/null || echo "")
if echo "$SYNC_LIST" | grep -q "e2e-sync-val"; then
  log_pass "Sync target 'e2e-sync-val' is active"
else
  log_fail "Sync target 'e2e-sync-val' not found"
fi

MAX_HOOK_ID=$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(id), 0) FROM hook_events;" 2>/dev/null || echo "0")
MAX_LOG_ID=$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(id), 0) FROM otel_logs;" 2>/dev/null || echo "0")
MAX_METRIC_ID=$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(id), 0) FROM otel_metrics;" 2>/dev/null || echo "0")

WM_DB_PATH="$(echo "$DB_PATH" | sed 's/data\.db/sync-watermarks.db/')"
if [ -f "$WM_DB_PATH" ]; then
  HOOK_WM=$(sqlite3 "$WM_DB_PATH" "SELECT value FROM watermarks WHERE key='hook_events:e2e-sync-val';" 2>/dev/null || echo "0")
  LOG_WM=$(sqlite3 "$WM_DB_PATH" "SELECT value FROM watermarks WHERE key='otel_logs:e2e-sync-val';" 2>/dev/null || echo "0")
  METRIC_WM=$(sqlite3 "$WM_DB_PATH" "SELECT value FROM watermarks WHERE key='otel_metrics:e2e-sync-val';" 2>/dev/null || echo "0")

  if [ "${HOOK_WM:-0}" -ge "$MAX_HOOK_ID" ] && [ "$MAX_HOOK_ID" -gt 0 ]; then
    log_pass "hook_events fully synced (watermark ${HOOK_WM} >= max id ${MAX_HOOK_ID})"
  elif [ "${HOOK_WM:-0}" -gt 0 ]; then
    log_fail "hook_events partially synced (watermark ${HOOK_WM} < max id ${MAX_HOOK_ID})"
  else
    log_fail "hook_events watermark stuck at 0"
  fi

  if [ "${LOG_WM:-0}" -ge "$MAX_LOG_ID" ] && [ "$MAX_LOG_ID" -gt 0 ]; then
    log_pass "otel_logs fully synced (watermark ${LOG_WM} >= max id ${MAX_LOG_ID})"
  elif [ "${LOG_WM:-0}" -gt 0 ]; then
    log_fail "otel_logs partially synced (watermark ${LOG_WM} < max id ${MAX_LOG_ID})"
  else
    log_fail "otel_logs watermark stuck at 0"
  fi

  if [ "${METRIC_WM:-0}" -ge "$MAX_METRIC_ID" ] && [ "$MAX_METRIC_ID" -gt 0 ]; then
    log_pass "otel_metrics fully synced (watermark ${METRIC_WM} >= max id ${MAX_METRIC_ID})"
  elif [ "${METRIC_WM:-0}" -gt 0 ]; then
    log_fail "otel_metrics partially synced (watermark ${METRIC_WM} < max id ${MAX_METRIC_ID})"
  else
    log_fail "otel_metrics watermark stuck at 0"
  fi
else
  log_fail "Sync watermarks DB not found at ${WM_DB_PATH}"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
print_summary
