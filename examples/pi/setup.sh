#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PANOPTICON_URL="http://localhost:4318"

echo "=== Pi + Panopticon Setup ==="
echo ""

# 1. Check prerequisites — ANTHROPIC_API_KEY must be set.
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env"
  set +o allexport
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Error: ANTHROPIC_API_KEY must be set."
  echo ""
  echo "  cp $SCRIPT_DIR/.env.example $SCRIPT_DIR/.env"
  echo "  # Edit .env and set ANTHROPIC_API_KEY"
  echo "  # Get a key at https://console.anthropic.com"
  echo ""
  exit 1
fi

echo "Provider: Anthropic"
echo ""

# 2. Build panopticon (includes bundling the Pi extension)
echo "Building panopticon..."
(cd "$REPO_ROOT" && pnpm build) > /dev/null
echo ""

# 3. Start containers
echo "Starting Pi + Panopticon..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d --build
echo ""

# 4. Wait for Panopticon
echo -n "Waiting for Panopticon"
for i in $(seq 1 30); do
  if curl -sf "$PANOPTICON_URL/health" > /dev/null 2>&1; then
    echo " ready!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo " timeout!"
    echo "Check logs: docker compose -f $SCRIPT_DIR/docker-compose.yml logs panopticon"
    exit 1
  fi
  echo -n "."
  sleep 2
done

# 5. Install Pi and the panopticon extension inside the pi container
echo "Installing Pi and panopticon extension..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T pi bash -c '
  # Install pi globally
  npm install -g @mariozechner/pi-coding-agent

  # Create extensions directory and copy the bundled extension
  mkdir -p /app/extensions
  cp /opt/panopticon/dist/targets/pi/extension.js /app/extensions/panopticon.js

  # Verify the extension exists
  ls -la /app/extensions/
' 2>/dev/null || {
  echo "  Could not exec into pi container — install pi manually"
  exit 1
}

echo ""

# 6. Run a simple test prompt to generate events
echo "Running test prompt..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" pi bash -c '
  cd /workspace

  # Run a non-interactive pi session with a simple prompt
  # Using --mode print captures output without the TUI
  echo "Hello, say hi and list the files in this directory" | \
    PI_EXTENSIONS_DIR=/app/extensions \
    pi --mode print "List the files in /workspace" 2>&1 || true

  # Give events time to POST to panopticon
  sleep 2
' || {
  echo "  Pi execution failed — this may be expected in CI"
}

echo ""

# 7. Check if events were captured
echo "Checking for captured events..."
EVENT_COUNT=$(docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T panopticon \
  panopticon query "SELECT COUNT(*) as n FROM hook_events" 2>/dev/null | \
  grep -oE '"n":[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1)

if [ -n "$EVENT_COUNT" ] && [ "$EVENT_COUNT" -gt 0 ]; then
  echo "OK — captured $EVENT_COUNT hook events"
else
  echo "No hook events captured yet. Run pi interactively and try again."
fi

echo ""
echo "=== Done ==="
echo ""
echo "  Panopticon: $PANOPTICON_URL/health"
echo ""
echo "To run Pi interactively:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml exec pi bash"
echo "  pi"
echo ""
echo "Teardown:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml down -v"
