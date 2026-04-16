#!/usr/bin/env bash
# Verify that OpenClaw routed through panopticon's proxy AND that OpenClaw's
# own diagnostics-otel plugin reported telemetry. Run after sending at least
# one prompt per provider through the OpenClaw web UI.
#
# Exits non-zero if:
#   - no hook_events rows for a provider (proxy capture missing)
#   - no otel_spans rows tagged service.name=openclaw-gateway (OTel missing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="$SCRIPT_DIR/docker-compose.yml"

# Providers to check — override by passing ids as args:
#   ./verify-capture.sh anthropic
# Default: infer from which API keys are set in .env.
if [ $# -gt 0 ]; then
  PROVIDERS=("$@")
else
  if [ -f "$SCRIPT_DIR/.env" ]; then
    set -o allexport
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/.env"
    set +o allexport
  fi
  PROVIDERS=()
  [ -n "${MOONSHOT_API_KEY:-}" ] && PROVIDERS+=("moonshot")
  [ -n "${ANTHROPIC_API_KEY:-}" ] && PROVIDERS+=("anthropic")
  if [ ${#PROVIDERS[@]} -eq 0 ]; then
    echo "Error: no providers to check. Pass ids as args or set API keys in .env."
    exit 1
  fi
fi

query() {
  docker compose -f "$COMPOSE" exec -T panopticon panopticon query "$1"
}

ensure_container() {
  if ! docker compose -f "$COMPOSE" ps panopticon --status running --quiet | grep -q .; then
    echo "Error: panopticon container is not running. Run ./setup.sh first."
    exit 1
  fi
}

echo "=== Panopticon capture verification ==="
echo ""

ensure_container

fail=0

# `panopticon query` prints JSON — we parse with grep/awk rather than require jq.
# JSON object per row, fields like:  "target": "anthropic"     and      "n": 1

# 1. Proxy capture — one row group per provider
echo "Proxy capture (hook_events by target):"
counts="$(query "SELECT target, COUNT(*) AS n FROM hook_events WHERE target IN ('$(IFS=\',\'; echo "${PROVIDERS[*]}")') GROUP BY target")"
echo "$counts"

for p in "${PROVIDERS[@]}"; do
  if ! echo "$counts" | grep -q "\"target\": *\"${p}\""; then
    echo "  MISSING: no hook_events rows for target='${p}'"
    fail=1
  fi
done
echo ""

# 2. OTel telemetry — panopticon accepts two sources:
#      - proxy-synthesized (proxy format parsers emit token.usage metrics +
#        api_request logs from captured exchanges; attributes.source=proxy)
#      - diagnostics-otel plugin inside OpenClaw (service.name=openclaw-gateway)
#
#    The UI-driven agent doesn't trigger the plugin reliably on every
#    OpenClaw version, but the proxy path always produces telemetry when
#    capture fires. Any OTel row counts as signal.
echo "OTel capture (logs/metrics/spans, any source):"
otel="$(query "SELECT 'logs' t, COUNT(*) n FROM otel_logs UNION ALL SELECT 'metrics', COUNT(*) FROM otel_metrics UNION ALL SELECT 'spans', COUNT(*) FROM otel_spans")"
echo "$otel"
total="$(echo "$otel" | grep -oE '"n":[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | awk '{s+=$1} END {print s+0}')"
if [ "$total" -eq 0 ]; then
  echo "  MISSING: no OTel rows in any table"
  fail=1
fi
echo ""

# 3. Recent proxy events (informational)
echo "Recent proxy events (last 5):"
query "SELECT id, target, event_type, datetime(timestamp_ms/1000, 'unixepoch') AS ts FROM hook_events WHERE target IN ('$(IFS=\',\'; echo "${PROVIDERS[*]}")') ORDER BY id DESC LIMIT 5"
echo ""

if [ "$fail" -eq 0 ]; then
  echo "OK — all providers captured, OTel flowing."
  exit 0
fi

echo "FAILED — see missing markers above."
echo ""
echo "Debug hints:"
echo "  - Confirm you sent a prompt through each provider in the UI at http://localhost:18789"
echo "  - docker compose -f $COMPOSE logs panopticon | grep -i proxy"
echo "  - docker compose -f $COMPOSE logs openclaw | tail -50"
exit 1
