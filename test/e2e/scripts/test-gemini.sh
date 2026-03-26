#!/usr/bin/env bash
# E2E test for Gemini CLI + Panopticon
set -euo pipefail
source /opt/e2e/scripts/lib.sh

TOOL="gemini"

# ─── Phase 1: Check API Key ─────────────────────────────────────────────────
log_phase 1 "Check API Key"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  log_skip "GEMINI_API_KEY not set — skipping Gemini E2E"
  exit 0
fi
log_info "GEMINI_API_KEY is set"

# ─── Phase 2: Install Panopticon ─────────────────────────────────────────────
log_phase 2 "Install Panopticon"

panopticon install --target gemini --proxy --force
log_pass "panopticon install completed"

# ─── Phase 3: Verify Install Artifacts ───────────────────────────────────────
log_phase 3 "Verify Install Artifacts"

# Database
assert_file_exists "$DB_PATH" "Database file"

# Gemini settings — hooks + telemetry + MCP
assert_file_exists "$HOME/.gemini/settings.json" "Gemini settings.json"
assert_grep "$HOME/.gemini/settings.json" "hooks" "Gemini hooks configured"
assert_grep "$HOME/.gemini/settings.json" "mcpServers" "Gemini MCP server registered"

# Shell env
assert_file_exists "$HOME/.bashrc" "Shell RC file"
assert_grep "$HOME/.bashrc" "OTEL_EXPORTER_OTLP_ENDPOINT" "OTel endpoint in .bashrc"
assert_grep "$HOME/.bashrc" "GEMINI_TELEMETRY_ENABLED" "Gemini telemetry enabled in .bashrc"

# ─── Phase 4: Start Server + Doctor ─────────────────────────────────────────
log_phase 4 "Start Server + Doctor"

panopticon start
wait_for_server 30

# Doctor check
DOCTOR_OUTPUT=$(panopticon doctor --json 2>/dev/null || echo "{}")
log_info "Doctor output: $DOCTOR_OUTPUT"

if echo "$DOCTOR_OUTPUT" | jq -e '.checks[] | select(.label == "Database") | select(.status == "ok")' >/dev/null 2>&1; then
  log_pass "Doctor: Database ok"
else
  log_fail "Doctor: Database not ok"
fi

# ─── Phase 5: Run Two Sessions ──────────────────────────────────────────────
log_phase 5 "Run Sessions"

# Source env vars from install
# shellcheck disable=SC1090
source "$HOME/.bashrc" 2>/dev/null || true

# Create workspace content for session 1
echo "# Panopticon Test Project" > /workspace/README.md
echo "This is a test file for E2E validation." >> /workspace/README.md

log_info "Session 1: File read + analysis"
gemini -p "List the files in the current directory and read the contents of README.md. Summarize what you find." \
  --yolo 2>&1 || log_info "Session 1 command exited (may be normal)"
sleep 5

log_info "Session 2: File write + bash"
gemini -p "Create a file called hello.py that prints 'Hello from panopticon test', then run it with python3." \
  --yolo 2>&1 || log_info "Session 2 command exited (may be normal)"
sleep 5

# ─── Phase 6: Verify Database ───────────────────────────────────────────────
log_phase 6 "Verify Database"

# Wait for telemetry to arrive
wait_for_db_rows hook_events 4 30 || true

dump_db_debug

# ── 6a: Structural checks ───────────────────────────────────────────────────

assert_db_count "SELECT COUNT(*) FROM hook_events;" 4 \
  "hook_events: >= 4 total rows"

assert_db_not_empty \
  "SELECT 1 FROM hook_events WHERE event_type = 'SessionStart' LIMIT 1;" \
  "hook_events: has SessionStart"

assert_db_not_empty \
  "SELECT 1 FROM hook_events WHERE event_type = 'UserPromptSubmit' LIMIT 1;" \
  "hook_events: has UserPromptSubmit"

assert_db_not_empty \
  "SELECT 1 FROM hook_events WHERE event_type = 'PreToolUse' LIMIT 1;" \
  "hook_events: has PreToolUse"

assert_db_not_empty \
  "SELECT 1 FROM hook_events WHERE event_type IN ('PostToolUse', 'SessionEnd', 'Stop') LIMIT 1;" \
  "hook_events: has PostToolUse or session completion"

assert_db_count \
  "SELECT COUNT(DISTINCT session_id) FROM hook_events;" 2 \
  "hook_events: >= 2 distinct sessions"

assert_db_count "SELECT COUNT(*) FROM otel_logs;" 1 \
  "otel_logs: >= 1 row"

assert_db_count "SELECT COUNT(*) FROM otel_metrics;" 1 \
  "otel_metrics: >= 1 row"

# ── 6b: hook_events column correctness ──────────────────────────────────────

# session_id: must be non-empty (used for GROUP BY in all query functions)
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE session_id IS NULL OR session_id = '';" \
  "hook_events: all session_id values are non-empty"

# event_type: canonical values only (query.ts, activitySummary filter on these)
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE event_type NOT IN ('SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop');" \
  "hook_events: all event_type values are canonical"

# timestamp_ms: reasonable epoch ms (time range filtering, cost grouping by day)
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE timestamp_ms < 1700000000000 OR timestamp_ms > (strftime('%s','now') + 60) * 1000;" \
  "hook_events: all timestamp_ms values are reasonable epoch ms"

# tool_name: non-null for tool events (toolStats filters on tool_name IS NOT NULL)
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE event_type IN ('PreToolUse','PostToolUse','PostToolUseFailure')
     AND (tool_name IS NULL OR tool_name = '');" \
  "hook_events: tool_name populated for all tool events"

# payload: non-null, non-empty (decompressed by query.ts for timeline, search, sync)
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events WHERE payload IS NULL OR length(payload) = 0;" \
  "hook_events: payload is never NULL or empty"

# user_prompt: populated for UserPromptSubmit (activitySummary, listSessions)
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE event_type = 'UserPromptSubmit'
     AND user_prompt IS NOT NULL AND user_prompt != ''
   LIMIT 1;" \
  "hook_events: user_prompt populated for UserPromptSubmit"

# user_prompt: contains our actual test prompt (fidelity)
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE event_type = 'UserPromptSubmit'
     AND user_prompt LIKE '%README%'
   LIMIT 1;" \
  "hook_events: user_prompt contains our test prompt text"

# ── 6c: otel_metrics column correctness ─────────────────────────────────────

# name: recognized metric name (resolvedMetricsCTE filters on these)
assert_db_not_empty \
  "SELECT 1 FROM otel_metrics
   WHERE name IN ('token.usage','claude_code.token.usage','gen_ai.client.token.usage','gemini_cli.token.usage')
   LIMIT 1;" \
  "otel_metrics: has recognized token metric name"

# value: non-negative for token counts (0 is valid for unused cache types)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_metrics WHERE name LIKE '%token%' AND value < 0;" \
  "otel_metrics: all token metrics have non-negative values"

# timestamp_ns: reasonable epoch nanoseconds (divided by 1e6 in cost queries)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_metrics
   WHERE timestamp_ns < 1700000000000000000
      OR timestamp_ns > (strftime('%s','now') + 60) * 1000000000;" \
  "otel_metrics: all timestamp_ns values are reasonable epoch ns"

# session_id: populated for token metrics (GROUP BY in cost aggregation)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_metrics
   WHERE name LIKE '%token%' AND (session_id IS NULL OR session_id = '');" \
  "otel_metrics: session_id populated for token metrics"

# attributes: model present (COST_EXPR pricing lookup)
assert_db_not_empty \
  "SELECT 1 FROM otel_metrics
   WHERE name LIKE '%token%'
     AND (json_extract(attributes, '$.model') IS NOT NULL
       OR json_extract(attributes, '$.\"gen_ai.response.model\"') IS NOT NULL)
   LIMIT 1;" \
  "otel_metrics: token metrics have model in attributes"

# attributes: token type present (COST_EXPR splits input/output/cache)
assert_db_not_empty \
  "SELECT 1 FROM otel_metrics
   WHERE name LIKE '%token%'
     AND (json_extract(attributes, '$.type') IS NOT NULL
       OR json_extract(attributes, '$.\"gen_ai.token.type\"') IS NOT NULL)
   LIMIT 1;" \
  "otel_metrics: token metrics have token_type in attributes"

# ── 6d: otel_logs column correctness ────────────────────────────────────────

# session_id: populated (timeline merge with hook_events)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_logs WHERE session_id IS NULL OR session_id = '';" \
  "otel_logs: session_id is always populated"

# body: must be non-null (used as event_type in sessionTimeline, searched in searchEvents)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_logs WHERE body IS NULL OR body = '';" \
  "otel_logs: body is always populated"

# attributes: valid JSON (searchEvents, timeline, sync serialization)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_logs
   WHERE attributes IS NOT NULL AND json_valid(attributes) = 0;" \
  "otel_logs: all attributes are valid JSON"

# timestamp_ns: reasonable epoch nanoseconds
assert_db_zero \
  "SELECT COUNT(*) FROM otel_logs
   WHERE timestamp_ns < 1700000000000000000
      OR timestamp_ns > (strftime('%s','now') + 60) * 1000000000;" \
  "otel_logs: all timestamp_ns values are reasonable epoch ns"

# ── 6e: Cross-table correlation ──────────────────────────────────────────────

assert_db_not_empty \
  "SELECT 1 FROM hook_events h
   INNER JOIN otel_logs l ON h.session_id = l.session_id
   LIMIT 1;" \
  "Cross-table: session_id correlates between hook_events and otel_logs"

assert_db_not_empty \
  "SELECT 1 FROM hook_events h
   INNER JOIN otel_metrics m ON h.session_id = m.session_id
   LIMIT 1;" \
  "Cross-table: session_id correlates between hook_events and otel_metrics"

# ─── Summary ────────────────────────────────────────────────────────────────
print_summary
