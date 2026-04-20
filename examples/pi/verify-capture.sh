#!/usr/bin/env bash
# Verify that Pi's panopticon extension captured session events.
# Run after sending at least one prompt through Pi.
#
# Exits non-zero if:
#   - no hook_events rows for source='pi' (extension capture missing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="$SCRIPT_DIR/docker-compose.yml"

query() {
  docker compose -f "$COMPOSE" exec -T panopticon panopticon query "$1"
}

ensure_container() {
  if ! docker compose -f "$COMPOSE" ps panopticon --status running --quiet | grep -q .; then
    echo "Error: panopticon container is not running. Run ./setup.sh first."
    exit 1
  fi
}

echo "=== Pi + Panopticon capture verification ==="
echo ""

ensure_container

fail=0

# 1. Check for Pi target events
echo "Pi events (hook_events by event_type):"
counts="$(query "SELECT event_type, COUNT(*) AS n FROM hook_events WHERE target = 'pi' GROUP BY event_type")"
echo "$counts"

if [ -z "$counts" ]; then
  echo "  MISSING: no hook_events rows for target='pi'"
  fail=1
else
  # Check for expected event types
  for event in SessionStart UserPromptSubmit PreToolUse PostToolUse; do
    if ! echo "$counts" | grep -q "\"${event}\""; then
      echo "  Note: no '${event}' events captured (this is fine for basic tests)"
    fi
  done
fi
echo ""

# 2. Total event count
total="$(query "SELECT COUNT(*) AS n FROM hook_events WHERE target = 'pi'" | grep -oE '"n":[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1)"
if [ -n "$total" ] && [ "$total" -gt 0 ]; then
  echo "Total Pi events: $total"
else
  echo "  MISSING: no events from Pi"
  fail=1
fi
echo ""

# 3. Recent events (informational)
echo "Recent Pi events (last 5):"
query "SELECT id, event_type, tool_name, datetime(timestamp_ms/1000, 'unixepoch') AS ts FROM hook_events WHERE target = 'pi' ORDER BY id DESC LIMIT 5" || true
echo ""

if [ "$fail" -eq 0 ]; then
  echo "OK — Pi extension is capturing events."
  exit 0
fi

echo "FAILED — see missing markers above."
echo ""
echo "Debug hints:"
echo "  - Confirm pi is running: docker compose -f $COMPOSE ps"
echo "  - Check pi logs: docker compose -f $COMPOSE logs pi | tail -50"
echo "  - Check panopticon logs: docker compose -f $COMPOSE logs panopticon | grep -i hook"
echo "  - Verify extension is installed in pi container:"
echo "      docker compose -f $COMPOSE exec pi ls -la /app/extensions/"
exit 1
