#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PANOPTICON_URL="http://localhost:4318"
OPENCLAW_URL="http://localhost:18789"

echo "=== OpenClaw + Panopticon Setup ==="
echo ""

# 1. Check prerequisites
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  if [ -z "${MOONSHOT_API_KEY:-}" ]; then
    echo "Error: No .env file found and MOONSHOT_API_KEY is not set."
    echo ""
    echo "  cp $SCRIPT_DIR/.env.example $SCRIPT_DIR/.env"
    echo "  # Edit .env and add your Moonshot API key"
    echo "  # Get one at https://platform.moonshot.ai"
    echo ""
    exit 1
  fi
fi

# 2. Build panopticon if needed
if [ ! -d "$REPO_ROOT/dist" ]; then
  echo "Building panopticon..."
  (cd "$REPO_ROOT" && npx tsup)
  echo ""
fi

# 3. Start the stack
echo "Starting OpenClaw + Panopticon..."
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

# 5. Configure OpenClaw's diagnostics-otel plugin.
# This logic mirrors src/targets/openclaw.ts applyInstallConfig — keep them in sync.
echo "Configuring OpenClaw diagnostics..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T openclaw sh -c '
  mkdir -p /home/node/.openclaw
  CONFIG=/home/node/.openclaw/openclaw.json

  if [ -f "$CONFIG" ]; then
    node -e "
      const fs = require(\"fs\");
      const cfg = JSON.parse(fs.readFileSync(\"$CONFIG\", \"utf-8\"));
      cfg.plugins = cfg.plugins || {};
      cfg.plugins.allow = cfg.plugins.allow || [];
      if (!cfg.plugins.allow.includes(\"diagnostics-otel\")) cfg.plugins.allow.push(\"diagnostics-otel\");
      cfg.plugins.entries = cfg.plugins.entries || {};
      cfg.plugins.entries[\"diagnostics-otel\"] = { enabled: true };
      cfg.diagnostics = cfg.diagnostics || {};
      cfg.diagnostics.otel = { enabled: true, endpoint: \"http://panopticon:4318\", protocol: \"http/protobuf\", serviceName: \"openclaw-gateway\", traces: true, metrics: true, logs: true, sampleRate: 1.0 };
      fs.writeFileSync(\"$CONFIG\", JSON.stringify(cfg, null, 2) + \"\\n\");
    "
  else
    cat > "$CONFIG" << OCEOF
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": { "diagnostics-otel": { "enabled": true } }
  },
  "diagnostics": {
    "otel": {
      "enabled": true,
      "endpoint": "http://panopticon:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 1.0
    }
  },
  "agents": {
    "defaults": { "model": { "primary": "moonshot/kimi-k2.5" } }
  },
  "models": {
    "providers": {
      "moonshot": {
        "baseUrl": "https://api.moonshot.ai/v1",
        "apiKey": "\${MOONSHOT_API_KEY}",
        "api": "openai-completions",
        "models": [{ "id": "kimi-k2.5", "name": "Kimi K2.5" }]
      }
    }
  }
}
OCEOF
  fi
' 2>/dev/null || {
  echo "  Could not exec into openclaw container — configure manually"
  exit 1
}

# 6. Restart openclaw so it picks up the diagnostics-otel plugin we just enabled
echo "Restarting OpenClaw to load diagnostics-otel..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" restart openclaw > /dev/null

echo ""
echo "=== Done ==="
echo ""
echo "  OpenClaw:   $OPENCLAW_URL"
echo "  Panopticon: $PANOPTICON_URL/health"
echo ""
echo "Send a prompt in the OpenClaw web UI, then check what landed:"
echo ""
echo "  # Recent metrics (token usage, cost)"
echo "  docker exec panopticon node /app/bin/panopticon query \\"
echo "    'SELECT name, attributes FROM otel_metrics ORDER BY id DESC LIMIT 5'"
echo ""
echo "  # Recent traces (model calls, tool spans)"
echo "  docker exec panopticon node /app/bin/panopticon query \\"
echo "    'SELECT name, attributes FROM otel_spans ORDER BY id DESC LIMIT 5'"
echo ""
echo "Teardown:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml down -v"
