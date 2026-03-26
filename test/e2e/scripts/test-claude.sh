#!/usr/bin/env bash
# E2E test for Claude Code + Panopticon
set -euo pipefail
source /opt/e2e/scripts/lib.sh

TOOL="claude"

# ─── Phase 1: Check API Key ─────────────────────────────────────────────────
log_phase 1 "Check API Key"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  log_skip "ANTHROPIC_API_KEY not set — skipping Claude E2E"
  exit 0
fi
log_info "ANTHROPIC_API_KEY is set"

# ─── Phase 2: Install Panopticon ─────────────────────────────────────────────
log_phase 2 "Install Panopticon"

panopticon install --target claude --proxy --force
log_pass "panopticon install completed"

# ─── Phase 3: Verify Install Artifacts ───────────────────────────────────────
log_phase 3 "Verify Install Artifacts"

# Database
assert_file_exists "$DB_PATH" "Database file"

# Claude settings — plugin enabled
assert_file_exists "$HOME/.claude/settings.json" "Claude settings.json"
assert_grep "$HOME/.claude/settings.json" "panopticon" "Claude plugin registered"

# Shell env
assert_file_exists "$HOME/.bashrc" "Shell RC file"
assert_grep "$HOME/.bashrc" "OTEL_EXPORTER_OTLP_ENDPOINT" "OTel endpoint in .bashrc"
assert_grep "$HOME/.bashrc" "CLAUDE_CODE_ENABLE_TELEMETRY" "Claude telemetry enabled in .bashrc"
assert_grep "$HOME/.bashrc" "ANTHROPIC_BASE_URL" "Anthropic base URL in .bashrc"

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
claude --print "List the files in the current directory and read the contents of README.md. Summarize what you find." \
  --max-turns 1 2>&1 || log_info "Session 1 command exited (may be normal)"
sleep 5

log_info "Session 2: File write + bash"
claude --print "Create a file called hello.py that prints 'Hello from panopticon test', then run it with python3." \
  --max-turns 1 2>&1 || log_info "Session 2 command exited (may be normal)"
sleep 5

# ─── Phase 6: Verify Database ───────────────────────────────────────────────
log_phase 6 "Verify Database"

# Wait for telemetry to arrive
wait_for_db_rows hook_events 4 30 || true

dump_db_debug

# ── 6a: Structural checks (rows exist) ──────────────────────────────────────

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

# PostToolUse may not appear with --max-turns 1 (session ends before tool reports back)
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
# Format varies: UUIDs from native hooks, vendor-date-seq from proxy SessionTracker
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE session_id IS NULL OR session_id = '';" \
  "hook_events: all session_id values are non-empty"

# event_type: must be a canonical type (used for WHERE filters in query.ts, activitySummary, toolStats)
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE event_type NOT IN ('SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop');" \
  "hook_events: all event_type values are canonical"

# timestamp_ms: must be reasonable epoch ms (used for time range filtering, sorting, cost grouping)
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE timestamp_ms < 1700000000000 OR timestamp_ms > (strftime('%s','now') + 60) * 1000;" \
  "hook_events: all timestamp_ms values are reasonable epoch ms"

# tool_name: must be non-null for PreToolUse/PostToolUse (toolStats filters on tool_name IS NOT NULL)
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events
   WHERE event_type IN ('PreToolUse','PostToolUse','PostToolUseFailure')
     AND (tool_name IS NULL OR tool_name = '');" \
  "hook_events: tool_name is populated for all tool events"

# tool_name: must be a known Claude Code tool (activitySummary checks for Write/Edit by name)
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE tool_name IN ('Read','Write','Edit','Bash','Glob','Grep','Agent','WebFetch','WebSearch')
   LIMIT 1;" \
  "hook_events: tool_name is a recognized Claude Code tool"

# payload: must be non-null BLOB (decompressed by query.ts for timeline, search, event detail)
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events WHERE payload IS NULL;" \
  "hook_events: payload is never NULL"

assert_db_zero \
  "SELECT COUNT(*) FROM hook_events WHERE length(payload) = 0;" \
  "hook_events: payload is never empty"

# user_prompt: must be populated for UserPromptSubmit (used by activitySummary, listSessions)
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE event_type = 'UserPromptSubmit'
     AND user_prompt IS NOT NULL
     AND user_prompt != ''
   LIMIT 1;" \
  "hook_events: user_prompt populated for UserPromptSubmit"

# user_prompt: must contain our actual test prompt text (fidelity check)
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE event_type = 'UserPromptSubmit'
     AND user_prompt LIKE '%README%'
   LIMIT 1;" \
  "hook_events: user_prompt contains our test prompt text"

# cwd: must be populated for SessionStart (used by activitySummary to extract working directory)
assert_db_not_empty \
  "SELECT 1 FROM hook_events
   WHERE event_type = 'SessionStart'
     AND cwd IS NOT NULL
     AND cwd LIKE '%workspace%'
   LIMIT 1;" \
  "hook_events: cwd is /workspace for SessionStart"

# ── 6c: otel_metrics column correctness ─────────────────────────────────────
# (used by costBreakdown, listSessions, activitySummary for token cost aggregation)

# name: must be a known metric name (resolvedMetricsCTE filters on these exact names)
assert_db_not_empty \
  "SELECT 1 FROM otel_metrics
   WHERE name IN ('token.usage','claude_code.token.usage','gen_ai.client.token.usage','gemini_cli.token.usage')
   LIMIT 1;" \
  "otel_metrics: has recognized token metric name"

# value: token counts must be non-negative (used in cost multiplication; 0 is valid for unused cache)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_metrics
   WHERE name LIKE '%token%' AND value < 0;" \
  "otel_metrics: all token metrics have non-negative values"

# timestamp_ns: must be in nanoseconds (divided by 1e6 in cost queries to get ms)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_metrics
   WHERE timestamp_ns < 1700000000000000000
      OR timestamp_ns > (strftime('%s','now') + 60) * 1000000000;" \
  "otel_metrics: all timestamp_ns values are reasonable epoch ns"

# session_id: must be populated (used for GROUP BY in cost aggregation)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_metrics
   WHERE name LIKE '%token%'
     AND (session_id IS NULL OR session_id = '');" \
  "otel_metrics: session_id populated for token metrics"

# attributes: must contain model (used by COST_EXPR for pricing lookup via json_extract)
assert_db_not_empty \
  "SELECT 1 FROM otel_metrics
   WHERE name LIKE '%token%'
     AND (json_extract(attributes, '$.model') IS NOT NULL
       OR json_extract(attributes, '$.\"gen_ai.response.model\"') IS NOT NULL)
   LIMIT 1;" \
  "otel_metrics: token metrics have model in attributes"

# attributes: must contain token type (used by COST_EXPR to split input/output/cache costs)
assert_db_not_empty \
  "SELECT 1 FROM otel_metrics
   WHERE name LIKE '%token%'
     AND (json_extract(attributes, '$.type') IS NOT NULL
       OR json_extract(attributes, '$.\"gen_ai.token.type\"') IS NOT NULL)
   LIMIT 1;" \
  "otel_metrics: token metrics have token_type in attributes"

# ── 6d: otel_logs column correctness ────────────────────────────────────────

# session_id: must be populated (used for timeline merge with hook_events)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_logs
   WHERE session_id IS NULL OR session_id = '';" \
  "otel_logs: session_id is always populated"

# body: must be a known log body type (sync reader uses HOOK_COVERED_BODIES to dedup)
assert_db_not_empty \
  "SELECT 1 FROM otel_logs
   WHERE body IN ('api_request','claude_code.user_prompt','claude_code.tool_decision','claude_code.tool_result','claude_code.api_request')
   LIMIT 1;" \
  "otel_logs: has recognized log body types"

# attributes: must be valid JSON (used by searchEvents, timeline, sync serialization)
assert_db_zero \
  "SELECT COUNT(*) FROM otel_logs
   WHERE attributes IS NOT NULL AND json_valid(attributes) = 0;" \
  "otel_logs: all attributes are valid JSON"

# timestamp_ns: must be in nanoseconds
assert_db_zero \
  "SELECT COUNT(*) FROM otel_logs
   WHERE timestamp_ns < 1700000000000000000
      OR timestamp_ns > (strftime('%s','now') + 60) * 1000000000;" \
  "otel_logs: all timestamp_ns values are reasonable epoch ns"

# ── 6e: Cross-table and proxy checks ────────────────────────────────────────

# session_id correlation: at least one session appears in both hook_events and otel_logs
# (used by sessionTimeline which UNIONs both tables by session_id)
assert_db_not_empty \
  "SELECT 1 FROM hook_events h
   INNER JOIN otel_logs l ON h.session_id = l.session_id
   LIMIT 1;" \
  "Cross-table: session_id correlates between hook_events and otel_logs"

# session_id correlation: hook_events and otel_metrics share sessions
# (used by costBreakdown which joins metrics to sessions)
assert_db_not_empty \
  "SELECT 1 FROM hook_events h
   INNER JOIN otel_metrics m ON h.session_id = m.session_id
   LIMIT 1;" \
  "Cross-table: session_id correlates between hook_events and otel_metrics"

# Proxy: api_request logs exist with source=proxy
assert_db_not_empty \
  "SELECT 1 FROM otel_logs WHERE body = 'api_request' AND attributes LIKE '%proxy%' LIMIT 1;" \
  "Proxy: api_request logs with source=proxy"

# Proxy: log attributes contain required fields for proxy captures (model, vendor, duration_ms, status)
assert_db_not_empty \
  "SELECT 1 FROM otel_logs
   WHERE body = 'api_request'
     AND attributes LIKE '%proxy%'
     AND json_extract(attributes, '$.vendor') IS NOT NULL
     AND json_extract(attributes, '$.duration_ms') IS NOT NULL
     AND json_extract(attributes, '$.status') IS NOT NULL
   LIMIT 1;" \
  "Proxy: api_request log has vendor, duration_ms, status fields"

# ─── Phase 7: Query Data via Panopticon MCP ───────────────────────────────────
log_phase 7 "Query Data via Panopticon MCP"

SESSIONS_BEFORE=$(sqlite3 "$DB_PATH" "SELECT COUNT(DISTINCT session_id) FROM hook_events;" 2>/dev/null || echo "0")
log_info "Sessions in DB before MCP queries: ${SESSIONS_BEFORE}"

# ── 7a: panopticon_sessions + panopticon_session_timeline ─────────────────────
# Tests: session listing returns our 2 sessions, timeline returns chronological events

log_info "MCP Query 1: List sessions then get timeline for one"
MCP_Q1_OUT=$(claude --print \
  "You MUST call the panopticon_sessions MCP tool to list recent sessions. Then take the first session_id from the result and call panopticon_session_timeline with that session_id. Tell me: how many sessions exist, what session_id you inspected, and what event types appear in its timeline. Do NOT use any tools other than panopticon MCP tools." \
  --max-turns 4 2>&1 || true)
sleep 3
log_info "MCP Q1 output (first 500 chars): ${MCP_Q1_OUT:0:500}"

assert_output_match "$MCP_Q1_OUT" "session" \
  "MCP panopticon_sessions: response mentions sessions"
assert_output_match "$MCP_Q1_OUT" "(timeline|event|SessionStart|UserPromptSubmit|PreToolUse|PostToolUse)" \
  "MCP panopticon_session_timeline: response mentions event types or timeline"

# ── 7b: panopticon_search — full-text search ──────────────────────────────────
# Tests: FTS5 trigram search finds our test prompt content

log_info "MCP Query 2: Full-text search for 'README'"
MCP_Q2_OUT=$(claude --print \
  "You MUST call the panopticon_search MCP tool with the query 'README'. Tell me: how many total matches were found, what event types matched, and a brief snippet from the first match. Do NOT use any tools other than panopticon MCP tools." \
  --max-turns 3 2>&1 || true)
sleep 3
log_info "MCP Q2 output (first 500 chars): ${MCP_Q2_OUT:0:500}"

assert_output_match "$MCP_Q2_OUT" "(README|match|result|found)" \
  "MCP panopticon_search: response references search results"
assert_output_match "$MCP_Q2_OUT" "(UserPromptSubmit|PreToolUse|PostToolUse|prompt|tool)" \
  "MCP panopticon_search: response mentions event types from matches"

# ── 7c: panopticon_tool_stats + panopticon_costs ──────────────────────────────
# Tests: tool aggregation counts and cost/token queries return rational data

log_info "MCP Query 3: Tool stats and cost breakdown"
MCP_Q3_OUT=$(claude --print \
  "You MUST call the panopticon_tool_stats MCP tool AND the panopticon_costs MCP tool. Tell me: which tools were used and their call counts, and the total tokens and cost. Do NOT use any tools other than panopticon MCP tools." \
  --max-turns 4 2>&1 || true)
sleep 3
log_info "MCP Q3 output (first 500 chars): ${MCP_Q3_OUT:0:500}"

assert_output_match "$MCP_Q3_OUT" "(tool|Read|Write|Bash|Edit|Glob|Grep)" \
  "MCP panopticon_tool_stats: response mentions tool names"
assert_output_match "$MCP_Q3_OUT" "(token|cost|usage|input|output)" \
  "MCP panopticon_costs: response mentions tokens or costs"

# ── 7d: panopticon_summary — activity overview ────────────────────────────────
# Tests: summary aggregation returns session counts, top tools, token totals

log_info "MCP Query 4: Activity summary"
MCP_Q4_OUT=$(claude --print \
  "You MUST call the panopticon_summary MCP tool. Tell me: how many total sessions, what the top tools used were, total tokens, and total cost. Do NOT use any tools other than panopticon MCP tools." \
  --max-turns 4 2>&1 || true)
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
