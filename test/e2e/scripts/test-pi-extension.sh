#!/usr/bin/env bash
# E2E test: Pi extension capture
#
# Validates that the panopticon Pi extension correctly captures session
# events and stores them in the local database. Runs entirely inside a
# single container — panopticon server + Pi + extension all together.
set -euo pipefail
source /opt/e2e/scripts/lib.sh

TOOL="pi-extension"

# ─── Phase 1: Prerequisites ──────────────────────────────────────────────────
log_phase 1 "Prerequisites"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  log_skip "No ANTHROPIC_API_KEY set — skipping Pi extension test"
  print_summary
fi

log_info "ANTHROPIC_API_KEY is set"
log_pass "Prerequisites met"

# ─── Phase 2: Install Pi extension ───────────────────────────────────────────
log_phase 2 "Install Pi extension"

if ! command -v panopticon &>/dev/null; then
  log_fail "panopticon CLI not found in PATH"
  print_summary
fi

if ! command -v pi &>/dev/null; then
  log_fail "pi CLI not found in PATH"
  print_summary
fi

# Install the panopticon extension for Pi.
# This also starts the panopticon server in the background.
panopticon install --target pi --force
log_pass "panopticon install --target pi"

# Verify extension file was installed
assert_file_exists "$HOME/.pi/agent/extensions/panopticon.js" \
  "Pi extension installed to global dir"

# ─── Phase 3: Wait for server ──────────────────────────────────────────────────
log_phase 3 "Wait for server"

wait_for_server 30
log_pass "Panopticon server is up"

# ─── Phase 4: Run a Pi session ────────────────────────────────────────────────
log_phase 4 "Run a Pi session"

# Pi discovers extensions from <cwd>/.pi/extensions/ (project-local)
# and ~/.pi/agent/extensions/ (global). The install step put the
# extension in the global dir, but the project-local dir also works.
# Ensure the workspace has a git repo so panopticon can resolve repo.
cd /workspace

# Run a non-interactive Pi session
timeout 60 pi --mode print "Say hello and list the files in /workspace" 2>&1 || true
log_info "Pi session completed"

# Give events time to be stored
sleep 3

# ─── Phase 5: Verify captured events ──────────────────────────────────────────
log_phase 5 "Verify captured events"

# Wait for hook_events rows to appear
wait_for_db_rows hook_events 1 15 || {
  log_fail "No hook_events rows found at all"
  dump_db_debug
  print_summary
}

# Verify events are tagged with target='pi'
assert_db_count "SELECT COUNT(*) FROM hook_events WHERE target = 'pi'" 1 \
  "At least 1 Pi event captured"

# Verify expected event types are present
for event_type in SessionStart UserPromptSubmit SessionEnd; do
  assert_db_not_empty \
    "SELECT 1 FROM hook_events WHERE target = 'pi' AND event_type = '${event_type}' LIMIT 1" \
    "Pi event type '${event_type}' captured"
done

# Check for tool events (Pi should use at least one tool like read/ls)
assert_db_not_empty \
  "SELECT 1 FROM hook_events WHERE target = 'pi' AND event_type IN ('PreToolUse', 'PostToolUse') LIMIT 1" \
  "Pi tool event captured"

# Verify session metadata
assert_db_not_empty \
  "SELECT 1 FROM sessions WHERE target = 'pi' LIMIT 1" \
  "Pi session row created"

assert_db_not_empty \
  "SELECT 1 FROM sessions WHERE target = 'pi' AND first_prompt IS NOT NULL AND first_prompt != '' LIMIT 1" \
  "Pi session has first_prompt"

# ─── Summary ──────────────────────────────────────────────────────────────────
dump_db_debug
print_summary
