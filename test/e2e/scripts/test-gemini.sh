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

# ─── Phase 7: Query Data via Panopticon MCP ───────────────────────────────────
log_phase 7 "Query Data via Panopticon MCP"

SESSIONS_BEFORE=$(sqlite3 "$DB_PATH" "SELECT COUNT(DISTINCT session_id) FROM hook_events;" 2>/dev/null || echo "0")
log_info "Sessions in DB before MCP queries: ${SESSIONS_BEFORE}"

# ── 7a: panopticon_sessions + panopticon_session_timeline ─────────────────────
# Tests: session listing returns our 2 sessions, timeline returns chronological events

log_info "MCP Query 1: List sessions then get timeline for one"
MCP_Q1_OUT=$(gemini -p \
  "You MUST call the panopticon_sessions MCP tool to list recent sessions. Then take the first session_id from the result and call panopticon_session_timeline with that session_id. Tell me: how many sessions exist, what session_id you inspected, and what event types appear in its timeline. Do NOT use any tools other than panopticon MCP tools." \
  --yolo 2>&1 || true)
sleep 3
log_info "MCP Q1 output (first 500 chars): ${MCP_Q1_OUT:0:500}"

assert_output_match "$MCP_Q1_OUT" "session" \
  "MCP panopticon_sessions: response mentions sessions"
assert_output_match "$MCP_Q1_OUT" "(timeline|event|SessionStart|UserPromptSubmit|PreToolUse|PostToolUse)" \
  "MCP panopticon_session_timeline: response mentions event types or timeline"

# ── 7b: panopticon_search — full-text search ──────────────────────────────────
# Tests: FTS5 trigram search finds our test prompt content

log_info "MCP Query 2: Full-text search for 'README'"
MCP_Q2_OUT=$(gemini -p \
  "You MUST call the panopticon_search MCP tool with the query 'README'. Tell me: how many total matches were found, what event types matched, and a brief snippet from the first match. Do NOT use any tools other than panopticon MCP tools." \
  --yolo 2>&1 || true)
sleep 3
log_info "MCP Q2 output (first 500 chars): ${MCP_Q2_OUT:0:500}"

assert_output_match "$MCP_Q2_OUT" "(README|match|result|found)" \
  "MCP panopticon_search: response references search results"
assert_output_match "$MCP_Q2_OUT" "(UserPromptSubmit|PreToolUse|PostToolUse|prompt|tool)" \
  "MCP panopticon_search: response mentions event types from matches"

# ── 7c: panopticon_tool_stats + panopticon_costs ──────────────────────────────
# Tests: tool aggregation counts and cost/token queries return rational data

log_info "MCP Query 3: Tool stats and cost breakdown"
MCP_Q3_OUT=$(gemini -p \
  "You MUST call the panopticon_tool_stats MCP tool AND the panopticon_costs MCP tool. Tell me: which tools were used and their call counts, and the total tokens and cost. Do NOT use any tools other than panopticon MCP tools." \
  --yolo 2>&1 || true)
sleep 3
log_info "MCP Q3 output (first 500 chars): ${MCP_Q3_OUT:0:500}"

assert_output_match "$MCP_Q3_OUT" "(tool|Read|Write|Bash|Edit|Glob|Grep)" \
  "MCP panopticon_tool_stats: response mentions tool names"
assert_output_match "$MCP_Q3_OUT" "(token|cost|usage|input|output)" \
  "MCP panopticon_costs: response mentions tokens or costs"

# ── 7d: panopticon_summary — activity overview ────────────────────────────────
# Tests: summary aggregation returns session counts, top tools, token totals

log_info "MCP Query 4: Activity summary"
MCP_Q4_OUT=$(gemini -p \
  "You MUST call the panopticon_summary MCP tool. Tell me: how many total sessions, what the top tools used were, total tokens, and total cost. Do NOT use any tools other than panopticon MCP tools." \
  --yolo 2>&1 || true)
sleep 3
log_info "MCP Q4 output (first 500 chars): ${MCP_Q4_OUT:0:500}"

assert_output_match "$MCP_Q4_OUT" "(session|summary|activity)" \
  "MCP panopticon_summary: response mentions sessions or activity"
assert_output_match "$MCP_Q4_OUT" "(tool|token|cost)" \
  "MCP panopticon_summary: response mentions tools, tokens, or costs"

# ── 7e: Verify MCP query sessions were tracked ───────────────────────────────
# The MCP query sessions themselves should appear as new sessions in the DB

sleep 5
SESSIONS_AFTER=$(sqlite3 "$DB_PATH" "SELECT COUNT(DISTINCT session_id) FROM hook_events;" 2>/dev/null || echo "0")
log_info "Sessions in DB after MCP queries: ${SESSIONS_AFTER} (was ${SESSIONS_BEFORE})"

assert_db_count \
  "SELECT COUNT(DISTINCT session_id) FROM hook_events;" \
  $((SESSIONS_BEFORE + 1)) \
  "hook_events: MCP query sessions created new session records"

# Panopticon MCP tool calls should appear as tool events in hook_events
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE event_type IN ('PreToolUse', 'PostToolUse')
     AND tool_name LIKE '%panopticon%'
   LIMIT 1;" \
  "hook_events: panopticon MCP tool calls recorded in database"

# At least one specific panopticon tool name should be recorded
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE tool_name LIKE '%panopticon_sessions%'
      OR tool_name LIKE '%panopticon_search%'
      OR tool_name LIKE '%panopticon_tool_stats%'
      OR tool_name LIKE '%panopticon_summary%'
   LIMIT 1;" \
  "hook_events: specific panopticon MCP tool names recorded"

# ─── Summary ────────────────────────────────────────────────────────────────
print_summary
