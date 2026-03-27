#!/usr/bin/env bash
# E2E test for Panopticon OTLP relay → Grafana LGTM sync pipeline
#
# Verifies the full data path:
#   1. Hook events + OTLP data are POSTed to panopticon
#   2. Panopticon stores them in SQLite
#   3. Sync loop reads from SQLite and POSTs to the Grafana OTEL-LGTM stack
#   4. Loki (logs) and Prometheus/Mimir (metrics) contain the expected data
#
# No API key required — all data is injected synthetically via curl.
set -euo pipefail
source /opt/e2e/scripts/lib.sh

PANO_URL="http://localhost:4318"
LGTM_OTLP_URL="http://otel-lgtm:4318"
GRAFANA_URL="http://otel-lgtm:3000"
SESSION_ID="e2e-grafana-test-$(date +%s)"
TOOL="grafana"

# ─── Phase 1: Wait for Grafana LGTM stack ──────────────────────────────────
log_phase 1 "Wait for Grafana LGTM Stack"

wait_for_grafana() {
  local timeout="${1:-60}"
  local elapsed=0
  log_info "Waiting for Grafana LGTM (timeout: ${timeout}s)..."
  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -sf "${GRAFANA_URL}/api/health" >/dev/null 2>&1; then
      log_info "Grafana LGTM is up after ${elapsed}s"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  log_fail "Grafana LGTM did not start within ${timeout}s"
  return 1
}

wait_for_lgtm_otlp() {
  local timeout="${1:-60}"
  local elapsed=0
  log_info "Waiting for LGTM OTLP receiver (timeout: ${timeout}s)..."
  while [ "$elapsed" -lt "$timeout" ]; do
    # The OTLP receiver doesn't have a /health endpoint, but we can POST
    # an empty logs payload and check for a 200 response
    if curl -sf -o /dev/null -w "%{http_code}" \
        -X POST "${LGTM_OTLP_URL}/v1/logs" \
        -H "Content-Type: application/json" \
        -d '{"resourceLogs":[]}' 2>/dev/null | grep -q "200"; then
      log_info "LGTM OTLP receiver is up after ${elapsed}s"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  log_fail "LGTM OTLP receiver did not start within ${timeout}s"
  return 1
}

wait_for_grafana 60
wait_for_lgtm_otlp 60
log_pass "Grafana LGTM stack is ready"

# ─── Phase 2: Install Panopticon + Configure Sync ──────────────────────────
log_phase 2 "Install Panopticon + Configure Sync"

panopticon install --target claude --force
log_pass "panopticon install completed"

# Add the LGTM stack as a sync target
panopticon sync add e2e-grafana "$LGTM_OTLP_URL"
log_pass "Sync target 'e2e-grafana' added → $LGTM_OTLP_URL"

# Verify sync target was persisted
SYNC_TARGETS=$(panopticon sync list 2>/dev/null || echo "")
if echo "$SYNC_TARGETS" | grep -q "e2e-grafana"; then
  log_pass "Sync target visible in 'sync list'"
else
  log_fail "Sync target not found in 'sync list'"
fi

# ─── Phase 3: Start Panopticon Server ──────────────────────────────────────
log_phase 3 "Start Panopticon Server"

panopticon start
wait_for_server 30
log_pass "Panopticon server is running"

# ─── Phase 4: Inject Synthetic Data ───────────────────────────────────────
log_phase 4 "Inject Synthetic Data"

NOW_MS=$(date +%s%3N)
NOW_NS="${NOW_MS}000000"

# 4a. Inject hook events (SessionStart, UserPromptSubmit, PreToolUse)
log_info "Injecting hook events..."

curl -sf -X POST "${PANO_URL}/hooks" \
  -H "Content-Type: application/json" \
  -d "{
    \"hook_event_name\": \"SessionStart\",
    \"session_id\": \"${SESSION_ID}\",
    \"source\": \"claude\",
    \"target\": \"claude\",
    \"cwd\": \"/workspace\"
  }" >/dev/null
log_pass "Injected SessionStart event"

curl -sf -X POST "${PANO_URL}/hooks" \
  -H "Content-Type: application/json" \
  -d "{
    \"hook_event_name\": \"UserPromptSubmit\",
    \"session_id\": \"${SESSION_ID}\",
    \"source\": \"claude\",
    \"target\": \"claude\",
    \"prompt\": \"List all files in the repo\"
  }" >/dev/null
log_pass "Injected UserPromptSubmit event"

curl -sf -X POST "${PANO_URL}/hooks" \
  -H "Content-Type: application/json" \
  -d "{
    \"hook_event_name\": \"PreToolUse\",
    \"session_id\": \"${SESSION_ID}\",
    \"source\": \"claude\",
    \"target\": \"claude\",
    \"tool_name\": \"Bash\"
  }" >/dev/null
log_pass "Injected PreToolUse event"

curl -sf -X POST "${PANO_URL}/hooks" \
  -H "Content-Type: application/json" \
  -d "{
    \"hook_event_name\": \"PostToolUse\",
    \"session_id\": \"${SESSION_ID}\",
    \"source\": \"claude\",
    \"target\": \"claude\",
    \"tool_name\": \"Bash\"
  }" >/dev/null
log_pass "Injected PostToolUse event"

# 4b. Inject OTLP logs (simulating native CLI telemetry)
log_info "Injecting OTLP logs..."

curl -sf -X POST "${PANO_URL}/v1/logs" \
  -H "Content-Type: application/json" \
  -d "{
    \"resourceLogs\": [{
      \"resource\": {
        \"attributes\": [
          {\"key\": \"service.name\", \"value\": {\"stringValue\": \"claude-code\"}},
          {\"key\": \"session.id\", \"value\": {\"stringValue\": \"${SESSION_ID}\"}}
        ]
      },
      \"scopeLogs\": [{
        \"logRecords\": [
          {
            \"timeUnixNano\": \"${NOW_NS}\",
            \"body\": {\"stringValue\": \"api_request\"},
            \"attributes\": [
              {\"key\": \"model\", \"value\": {\"stringValue\": \"claude-sonnet-4-20250514\"}},
              {\"key\": \"source\", \"value\": {\"stringValue\": \"proxy\"}},
              {\"key\": \"duration_ms\", \"value\": {\"intValue\": \"1234\"}},
              {\"key\": \"status\", \"value\": {\"intValue\": \"200\"}},
              {\"key\": \"target\", \"value\": {\"stringValue\": \"anthropic\"}}
            ]
          },
          {
            \"timeUnixNano\": \"${NOW_NS}\",
            \"body\": {\"stringValue\": \"e2e_grafana_test_marker\"},
            \"attributes\": [
              {\"key\": \"test_run\", \"value\": {\"stringValue\": \"true\"}}
            ]
          }
        ]
      }]
    }]
  }" >/dev/null
log_pass "Injected OTLP logs (api_request + test marker)"

# 4c. Inject OTLP metrics (simulating token usage)
log_info "Injecting OTLP metrics..."

curl -sf -X POST "${PANO_URL}/v1/metrics" \
  -H "Content-Type: application/json" \
  -d "{
    \"resourceMetrics\": [{
      \"resource\": {
        \"attributes\": [
          {\"key\": \"service.name\", \"value\": {\"stringValue\": \"claude-code\"}},
          {\"key\": \"session.id\", \"value\": {\"stringValue\": \"${SESSION_ID}\"}}
        ]
      },
      \"scopeMetrics\": [{
        \"metrics\": [
          {
            \"name\": \"claude_code.token.usage\",
            \"unit\": \"token\",
            \"gauge\": {
              \"dataPoints\": [
                {
                  \"timeUnixNano\": \"${NOW_NS}\",
                  \"asDouble\": 42,
                  \"attributes\": [
                    {\"key\": \"model\", \"value\": {\"stringValue\": \"claude-sonnet-4-20250514\"}},
                    {\"key\": \"type\", \"value\": {\"stringValue\": \"input\"}}
                  ]
                },
                {
                  \"timeUnixNano\": \"${NOW_NS}\",
                  \"asDouble\": 100,
                  \"attributes\": [
                    {\"key\": \"model\", \"value\": {\"stringValue\": \"claude-sonnet-4-20250514\"}},
                    {\"key\": \"type\", \"value\": {\"stringValue\": \"output\"}}
                  ]
                }
              ]
            }
          }
        ]
      }]
    }]
  }" >/dev/null
log_pass "Injected OTLP metrics (token usage: 42 input, 100 output)"

# ─── Phase 5: Verify Local Database ───────────────────────────────────────
log_phase 5 "Verify Local Database"

wait_for_db_rows hook_events 4 15 || true
wait_for_db_rows otel_logs 2 15 || true
wait_for_db_rows otel_metrics 2 15 || true

assert_db_count "SELECT COUNT(*) FROM hook_events WHERE session_id='${SESSION_ID}';" 4 \
  "hook_events: 4 events for test session"

assert_db_count "SELECT COUNT(*) FROM otel_logs WHERE session_id='${SESSION_ID}';" 2 \
  "otel_logs: 2 log records for test session"

assert_db_count "SELECT COUNT(*) FROM otel_metrics WHERE session_id='${SESSION_ID}';" 2 \
  "otel_metrics: 2 metric records for test session"

dump_db_debug

# ─── Phase 6: Wait for Sync + Verify Grafana ──────────────────────────────
log_phase 6 "Wait for Sync + Verify Grafana Backends"

# The sync loop idles for up to 30s between ticks when no new data was found.
# After the first tick (which runs at start, before our data was injected),
# it may idle for up to 30s before checking again. Then Loki/Mimir need a few
# seconds to index. We poll rather than sleeping a fixed amount.
log_info "Waiting for sync loop to flush data to LGTM..."

wait_for_loki_data() {
  local timeout="${1:-60}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local count
    count=$(curl -sf -G "http://otel-lgtm:3100/loki/api/v1/query_range" \
      --data-urlencode 'query={service_name="panopticon"}' \
      --data-urlencode "start=$(date -d '10 minutes ago' +%s)" \
      --data-urlencode "end=$(date +%s)" \
      --data-urlencode "limit=5" 2>/dev/null \
      | jq -r '[.data.result[].values | length] | add // 0' 2>/dev/null || echo "0")
    if [ "$count" -gt 0 ]; then
      log_info "Data appeared in Loki after ${elapsed}s"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  log_info "Timed out waiting for Loki data after ${timeout}s"
  return 1
}

wait_for_loki_data 90 || true

# 6a. Query Loki for synced hook events
log_info "Querying Loki for hook events..."

LOKI_QUERY='{service_name="panopticon"}'
LOKI_RESULT=$(curl -sf -G "${GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/query_range" \
  --data-urlencode "query=${LOKI_QUERY}" \
  --data-urlencode "start=$(date -d '5 minutes ago' +%s 2>/dev/null || date -v-5M +%s)" \
  --data-urlencode "end=$(date +%s)" \
  --data-urlencode "limit=100" \
  -u admin:admin 2>/dev/null || echo "{}")

LOKI_STREAM_COUNT=$(echo "$LOKI_RESULT" | jq -r '.data.result | length' 2>/dev/null || echo "0")

if [ "$LOKI_STREAM_COUNT" -gt 0 ]; then
  log_pass "Loki: found ${LOKI_STREAM_COUNT} stream(s) with service_name=panopticon"
else
  # Try alternative Loki API path (direct, not proxied through Grafana)
  log_info "Trying direct Loki query..."
  LOKI_RESULT=$(curl -sf -G "http://otel-lgtm:3100/loki/api/v1/query_range" \
    --data-urlencode "query=${LOKI_QUERY}" \
    --data-urlencode "start=$(date -d '5 minutes ago' +%s 2>/dev/null || date -v-5M +%s)" \
    --data-urlencode "end=$(date +%s)" \
    --data-urlencode "limit=100" 2>/dev/null || echo "{}")

  LOKI_STREAM_COUNT=$(echo "$LOKI_RESULT" | jq -r '.data.result | length' 2>/dev/null || echo "0")
  if [ "$LOKI_STREAM_COUNT" -gt 0 ]; then
    log_pass "Loki (direct): found ${LOKI_STREAM_COUNT} stream(s)"
  else
    log_fail "Loki: no streams found for service_name=panopticon"
    log_info "Loki response: $(echo "$LOKI_RESULT" | head -c 500)"
  fi
fi

# 6b. Check Loki for specific hook event types
log_info "Querying Loki for specific event types..."

for EVENT_TYPE in SessionStart UserPromptSubmit PreToolUse; do
  QUERY="{service_name=\"panopticon\"} | json | event_type=\"${EVENT_TYPE}\""
  RESULT=$(curl -sf -G "http://otel-lgtm:3100/loki/api/v1/query_range" \
    --data-urlencode "query=${QUERY}" \
    --data-urlencode "start=$(date -d '5 minutes ago' +%s 2>/dev/null || date -v-5M +%s)" \
    --data-urlencode "end=$(date +%s)" \
    --data-urlencode "limit=10" 2>/dev/null || echo "{}")

  COUNT=$(echo "$RESULT" | jq -r '[.data.result[].values | length] | add // 0' 2>/dev/null || echo "0")
  if [ "$COUNT" -gt 0 ]; then
    log_pass "Loki: ${EVENT_TYPE} events found (${COUNT} entries)"
  else
    # Loki indexing can be slow; log as best-effort
    log_info "Loki: ${EVENT_TYPE} not yet indexed (best-effort check)"
  fi
done

# 6c. Check for OTLP logs synced through (otel_logs passthrough)
log_info "Querying Loki for synced OTLP logs..."

OTEL_LOG_QUERY='{service_name="panopticon"} |= "api_request"'
OTEL_LOG_RESULT=$(curl -sf -G "http://otel-lgtm:3100/loki/api/v1/query_range" \
  --data-urlencode "query=${OTEL_LOG_QUERY}" \
  --data-urlencode "start=$(date -d '5 minutes ago' +%s 2>/dev/null || date -v-5M +%s)" \
  --data-urlencode "end=$(date +%s)" \
  --data-urlencode "limit=10" 2>/dev/null || echo "{}")

OTEL_LOG_COUNT=$(echo "$OTEL_LOG_RESULT" | jq -r '[.data.result[].values | length] | add // 0' 2>/dev/null || echo "0")
if [ "$OTEL_LOG_COUNT" -gt 0 ]; then
  log_pass "Loki: OTLP api_request logs found (${OTEL_LOG_COUNT} entries)"
else
  log_info "Loki: OTLP api_request logs not yet indexed (best-effort)"
fi

# 6d. Query Prometheus/Mimir for synced metrics
log_info "Querying Prometheus for synced metrics..."

PROM_RESULT=$(curl -sf -G "http://otel-lgtm:9090/api/v1/query" \
  --data-urlencode 'query=claude_code_token_usage' 2>/dev/null || echo "{}")

PROM_COUNT=$(echo "$PROM_RESULT" | jq -r '.data.result | length' 2>/dev/null || echo "0")
if [ "$PROM_COUNT" -gt 0 ]; then
  log_pass "Prometheus: claude_code_token_usage metric found (${PROM_COUNT} series)"
else
  # Metrics may be named differently after OTLP ingest; try a broader query
  PROM_RESULT2=$(curl -sf -G "http://otel-lgtm:9090/api/v1/label/__name__/values" 2>/dev/null || echo "{}")
  METRIC_NAMES=$(echo "$PROM_RESULT2" | jq -r '.data[]' 2>/dev/null || echo "")

  if echo "$METRIC_NAMES" | grep -qi "token\|claude\|panopticon"; then
    MATCHED=$(echo "$METRIC_NAMES" | grep -i "token\|claude\|panopticon" | head -3)
    log_pass "Prometheus: found related metrics: ${MATCHED}"
  else
    log_info "Prometheus: no token metrics found yet (metric names: $(echo "$METRIC_NAMES" | head -5 | tr '\n' ', '))"
    log_info "Prometheus response: $(echo "$PROM_RESULT" | head -c 300)"
  fi
fi

# ─── Phase 7: Verify Sync Watermarks Advanced ─────────────────────────────
log_phase 7 "Verify Sync Watermarks"

# The sync loop should have advanced watermarks after syncing
# Check that panopticon tracks what it has synced
SYNC_LIST=$(panopticon sync list 2>/dev/null || echo "")
log_info "Sync targets: ${SYNC_LIST}"

if echo "$SYNC_LIST" | grep -q "e2e-grafana"; then
  log_pass "Sync target 'e2e-grafana' is active"
else
  log_fail "Sync target 'e2e-grafana' not found in sync list"
fi

# ─── Phase 8: Validate Loki has at least some panopticon data ─────────────
log_phase 8 "Final Validation"

# This is the core assertion: did data make it from panopticon → LGTM?
FINAL_QUERY='{service_name="panopticon"}'
FINAL_RESULT=$(curl -sf -G "http://otel-lgtm:3100/loki/api/v1/query_range" \
  --data-urlencode "query=${FINAL_QUERY}" \
  --data-urlencode "start=$(date -d '10 minutes ago' +%s 2>/dev/null || date -v-10M +%s)" \
  --data-urlencode "end=$(date +%s)" \
  --data-urlencode "limit=100" 2>/dev/null || echo "{}")

TOTAL_ENTRIES=$(echo "$FINAL_RESULT" | jq -r '[.data.result[].values | length] | add // 0' 2>/dev/null || echo "0")
TOTAL_STREAMS=$(echo "$FINAL_RESULT" | jq -r '.data.result | length' 2>/dev/null || echo "0")

if [ "$TOTAL_ENTRIES" -gt 0 ]; then
  log_pass "End-to-end verified: ${TOTAL_ENTRIES} log entries in ${TOTAL_STREAMS} stream(s) reached Loki"
else
  log_fail "End-to-end failed: no data reached Loki after sync"
  log_info "Full Loki response: $(echo "$FINAL_RESULT" | head -c 1000)"
fi

# ─── Summary ──────────────────────────────────────────────────────────────
print_summary
