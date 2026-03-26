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

# Proxy: log attributes contain required fields for proxy captures (model, target, duration_ms, status)
assert_db_not_empty \
  "SELECT 1 FROM otel_logs
   WHERE body = 'api_request'
     AND attributes LIKE '%proxy%'
     AND json_extract(attributes, '$.target') IS NOT NULL
     AND json_extract(attributes, '$.duration_ms') IS NOT NULL
     AND json_extract(attributes, '$.status') IS NOT NULL
   LIMIT 1;" \
  "Proxy: api_request log has target, duration_ms, status fields"

# ── 6f: sessions table ────────────────────────────────────────────────────

assert_db_not_empty \
  "SELECT 1 FROM sessions LIMIT 1;" \
  "sessions: table is populated"

# Claude Code does not currently send source/target/model in hook payloads,
# so target detection falls back to 'unknown' (see issue #73).
assert_db_not_empty \
  "SELECT 1 FROM sessions WHERE target IS NOT NULL LIMIT 1;" \
  "sessions: target is populated"

assert_db_not_empty \
  "SELECT 1 FROM sessions WHERE started_at_ms IS NOT NULL LIMIT 1;" \
  "sessions: started_at_ms is populated"

# ── 6g: hook_events.target column ─────────────────────────────────────────

assert_db_zero \
  "SELECT COUNT(*) FROM hook_events WHERE target IS NULL OR target = '';" \
  "hook_events: target column is always populated"

# Claude Code does not send source/target in hook payloads — target will be
# 'unknown' until #73 is resolved. Just verify the column is non-null.
assert_db_zero \
  "SELECT COUNT(*) FROM hook_events WHERE target IS NULL OR target = '';" \
  "hook_events: target column is never null/empty"

# ─── Summary ────────────────────────────────────────────────────────────────
print_summary
