#!/usr/bin/env bash
# Shared helpers for panopticon E2E tests
set -euo pipefail

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# Colors (if terminal supports them)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_pass()  { echo -e "${GREEN}[PASS]${NC}  $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
log_fail()  { echo -e "${RED}[FAIL]${NC}  $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
log_skip()  { echo -e "${YELLOW}[SKIP]${NC}  $*"; SKIP_COUNT=$((SKIP_COUNT + 1)); }
log_phase() { echo -e "\n${CYAN}═══ Phase $1: $2 ═══${NC}\n"; }

# Find the panopticon database path
get_db_path() {
  local os
  os="$(uname -s)"
  case "$os" in
    Darwin) echo "$HOME/Library/Application Support/panopticon/data.db" ;;
    *)      echo "$HOME/.local/share/panopticon/data.db" ;;
  esac
}

DB_PATH="$(get_db_path)"

# Wait for server health endpoint
# Usage: wait_for_server <timeout_seconds>
wait_for_server() {
  local timeout="${1:-30}"
  local elapsed=0
  log_info "Waiting for server (timeout: ${timeout}s)..."
  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -sf http://localhost:4318/health >/dev/null 2>&1; then
      log_info "Server is up after ${elapsed}s"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  log_fail "Server did not start within ${timeout}s"
  return 1
}

# Wait for database rows to appear
# Usage: wait_for_db_rows <table> <min_count> <timeout_seconds>
wait_for_db_rows() {
  local table="$1"
  local min="$2"
  local timeout="${3:-30}"
  local elapsed=0
  log_info "Waiting for >= ${min} rows in ${table} (timeout: ${timeout}s)..."
  while [ "$elapsed" -lt "$timeout" ]; do
    local count
    count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM ${table};" 2>/dev/null || echo "0")
    if [ "$count" -ge "$min" ]; then
      log_info "Found ${count} rows in ${table} after ${elapsed}s"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  local final
  final=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM ${table};" 2>/dev/null || echo "0")
  log_fail "Only ${final} rows in ${table} after ${timeout}s (needed >= ${min})"
  return 1
}

# Assert a file exists
# Usage: assert_file_exists <path> <description>
assert_file_exists() {
  local path="$1"
  local desc="$2"
  if [ -f "$path" ]; then
    log_pass "$desc — $path exists"
  else
    log_fail "$desc — $path not found"
  fi
}

# Assert a directory exists
# Usage: assert_dir_exists <path> <description>
assert_dir_exists() {
  local path="$1"
  local desc="$2"
  if [ -d "$path" ]; then
    log_pass "$desc — $path exists"
  else
    log_fail "$desc — $path not found"
  fi
}

# Assert sqlite3 query result >= min
# Usage: assert_db_count <query> <min> <description>
assert_db_count() {
  local query="$1"
  local min="$2"
  local desc="$3"
  local count
  count=$(sqlite3 "$DB_PATH" "$query" 2>/dev/null || echo "0")
  if [ "$count" -ge "$min" ]; then
    log_pass "$desc — got ${count} (>= ${min})"
  else
    log_fail "$desc — got ${count} (expected >= ${min})"
  fi
}

# Assert sqlite3 query returns at least one row
# Usage: assert_db_not_empty <query> <description>
assert_db_not_empty() {
  local query="$1"
  local desc="$2"
  local result
  result=$(sqlite3 "$DB_PATH" "$query" 2>/dev/null || echo "")
  if [ -n "$result" ]; then
    log_pass "$desc — has data"
  else
    log_fail "$desc — empty result"
  fi
}

# Assert a file contains a pattern
# Usage: assert_grep <file> <pattern> <description>
assert_grep() {
  local file="$1"
  local pattern="$2"
  local desc="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    log_pass "$desc"
  else
    log_fail "$desc — pattern '${pattern}' not found in ${file}"
  fi
}

# Print summary and exit with appropriate code
print_summary() {
  echo ""
  echo -e "${CYAN}════════════════════════════════════════${NC}"
  echo -e "  ${GREEN}Passed:${NC}  ${PASS_COUNT}"
  echo -e "  ${RED}Failed:${NC}  ${FAIL_COUNT}"
  echo -e "  ${YELLOW}Skipped:${NC} ${SKIP_COUNT}"
  echo -e "${CYAN}════════════════════════════════════════${NC}"

  if [ "$FAIL_COUNT" -gt 0 ]; then
    echo -e "\n${RED}E2E FAILED${NC}"
    exit 1
  else
    echo -e "\n${GREEN}E2E PASSED${NC}"
    exit 0
  fi
}

# Assert sqlite3 query result equals expected value
# Usage: assert_db_equals <query> <expected> <description>
assert_db_equals() {
  local query="$1"
  local expected="$2"
  local desc="$3"
  local actual
  actual=$(sqlite3 "$DB_PATH" "$query" 2>/dev/null || echo "")
  if [ "$actual" = "$expected" ]; then
    log_pass "$desc — got '${actual}'"
  else
    log_fail "$desc — expected '${expected}', got '${actual}'"
  fi
}

# Assert sqlite3 query result is zero
# Usage: assert_db_zero <query> <description>
assert_db_zero() {
  local query="$1"
  local desc="$2"
  local count
  count=$(sqlite3 "$DB_PATH" "$query" 2>/dev/null || echo "-1")
  if [ "$count" -eq 0 ]; then
    log_pass "$desc — no violations"
  else
    log_fail "$desc — found ${count} violations"
  fi
}

# Dump database state for debugging on failure
dump_db_debug() {
  log_info "Database debug dump:"
  if [ ! -f "$DB_PATH" ]; then
    log_info "  Database file not found at $DB_PATH"
    return
  fi
  echo "  hook_events rows: $(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM hook_events;' 2>/dev/null || echo 'N/A')"
  echo "  otel_logs rows:   $(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM otel_logs;' 2>/dev/null || echo 'N/A')"
  echo "  otel_metrics rows:$(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM otel_metrics;' 2>/dev/null || echo 'N/A')"
  echo "  Distinct sessions: $(sqlite3 "$DB_PATH" 'SELECT COUNT(DISTINCT session_id) FROM hook_events;' 2>/dev/null || echo 'N/A')"
  echo "  Event types: $(sqlite3 "$DB_PATH" 'SELECT DISTINCT event_type FROM hook_events;' 2>/dev/null || echo 'N/A')"
  echo "  Tool names: $(sqlite3 "$DB_PATH" "SELECT DISTINCT tool_name FROM hook_events WHERE tool_name IS NOT NULL AND tool_name != '';" 2>/dev/null || echo 'N/A')"
}

# Dump sample rows from each table for content inspection
dump_db_samples() {
  log_info "Sample rows:"
  if [ ! -f "$DB_PATH" ]; then
    log_info "  Database file not found at $DB_PATH"
    return
  fi

  echo ""
  echo "── hook_events (5 sample rows) ──"
  sqlite3 -header -column "$DB_PATH" \
    "SELECT id, session_id, event_type, target, tool_name,
            substr(user_prompt, 1, 60) AS prompt_preview,
            cwd, timestamp_ms
     FROM hook_events ORDER BY id LIMIT 5;" 2>/dev/null || echo "  (query failed)"

  echo ""
  echo "── otel_logs (5 sample rows) ──"
  sqlite3 -header -column "$DB_PATH" \
    "SELECT id, session_id, body, severity_text,
            substr(attributes, 1, 120) AS attrs_preview,
            timestamp_ns
     FROM otel_logs ORDER BY id LIMIT 5;" 2>/dev/null || echo "  (query failed)"

  echo ""
  echo "── otel_metrics (5 sample rows) ──"
  sqlite3 -header -column "$DB_PATH" \
    "SELECT id, session_id, name, value, unit,
            substr(attributes, 1, 120) AS attrs_preview,
            timestamp_ns
     FROM otel_metrics ORDER BY id LIMIT 5;" 2>/dev/null || echo "  (query failed)"

  echo ""
  echo "── sessions ──"
  sqlite3 -header -column "$DB_PATH" \
    "SELECT session_id, target, started_at_ms, ended_at_ms,
            substr(first_prompt, 1, 60) AS prompt_preview
     FROM sessions ORDER BY started_at_ms;" 2>/dev/null || echo "  (query failed)"

  echo ""
  echo "── hook_events by session + event_type ──"
  sqlite3 -header -column "$DB_PATH" \
    "SELECT session_id, target, event_type, COUNT(*) AS count
     FROM hook_events
     GROUP BY session_id, target, event_type
     ORDER BY session_id, event_type;" 2>/dev/null || echo "  (query failed)"

  echo ""
  echo "── otel_logs by session + body ──"
  sqlite3 -header -column "$DB_PATH" \
    "SELECT session_id, body, COUNT(*) AS count
     FROM otel_logs
     GROUP BY session_id, body
     ORDER BY session_id, body;" 2>/dev/null || echo "  (query failed)"

  echo ""
  echo "── otel_metrics by session + name ──"
  sqlite3 -header -column "$DB_PATH" \
    "SELECT session_id, name, COUNT(*) AS count, SUM(value) AS total_value
     FROM otel_metrics
     GROUP BY session_id, name
     ORDER BY session_id, name;" 2>/dev/null || echo "  (query failed)"
}
