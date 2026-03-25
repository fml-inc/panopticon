#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GRAFANA_URL="http://localhost:3001"
PANOPTICON_URL="http://localhost:4318"
OPENCLAW_URL="http://localhost:18789"

echo "=== OpenClaw + Panopticon + Grafana Setup ==="
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
echo "Starting OpenClaw + Panopticon + Grafana..."
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

# 5. Wait for Grafana
echo -n "Waiting for Grafana"
for i in $(seq 1 30); do
  if curl -sf "$GRAFANA_URL/api/health" > /dev/null 2>&1; then
    echo " ready!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo " timeout!"
  fi
  echo -n "."
  sleep 2
done

# 6. Configure OpenClaw's diagnostics-otel plugin
echo "Configuring OpenClaw diagnostics..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T openclaw sh -c '
  mkdir -p /home/node/.openclaw
  CONFIG=/home/node/.openclaw/openclaw.json

  # Create or update config with diagnostics-otel enabled
  if [ -f "$CONFIG" ]; then
    # Config exists — use node to merge
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
' 2>/dev/null || echo "  (could not exec into openclaw container — configure manually)"

# 7. Provision Grafana dashboard
echo "Creating Grafana dashboard..."
curl -sf -X POST "$GRAFANA_URL/api/dashboards/db" \
  -H "Content-Type: application/json" \
  -u admin:admin \
  -d @- > /dev/null << 'DASHBOARD'
{
  "dashboard": {
    "uid": "panopticon-openclaw",
    "title": "Panopticon — OpenClaw Usage",
    "tags": ["panopticon", "openclaw"],
    "timezone": "browser",
    "refresh": "30s",
    "time": { "from": "now-2d", "to": "now" },
    "panels": [
      {
        "id": 1, "title": "API Calls Over Time", "type": "timeseries",
        "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
        "datasource": { "type": "loki", "uid": "loki" },
        "targets": [{ "refId": "A", "expr": "sum by (model) (count_over_time({service_name=\"panopticon\"} | cost_usd != \"\" [30m]))", "legendFormat": "{{model}}" }],
        "fieldConfig": { "defaults": { "custom": { "fillOpacity": 20, "lineWidth": 2, "stacking": { "mode": "normal" } } } },
        "options": { "tooltip": { "mode": "multi" } }
      },
      {
        "id": 2, "title": "Token Usage by Type", "type": "timeseries",
        "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
        "datasource": { "type": "prometheus", "uid": "prometheus" },
        "targets": [{ "refId": "A", "expr": "claude_code_token_usage_tokens", "legendFormat": "{{type}} — {{model}}" }],
        "fieldConfig": { "defaults": { "custom": { "fillOpacity": 15, "lineWidth": 2 }, "unit": "short" } }
      },
      {
        "id": 3, "title": "Tool Calls", "type": "barchart",
        "gridPos": { "h": 8, "w": 8, "x": 0, "y": 8 },
        "datasource": { "type": "loki", "uid": "loki" },
        "targets": [{ "refId": "A", "expr": "sum by (tool_name) (count_over_time({service_name=\"panopticon\"} | event_type =~ \"PreToolUse|PostToolUse\" [2d]))", "legendFormat": "{{tool_name}}" }],
        "options": { "orientation": "horizontal" }
      },
      {
        "id": 4, "title": "Events by Type", "type": "piechart",
        "gridPos": { "h": 8, "w": 8, "x": 8, "y": 8 },
        "datasource": { "type": "loki", "uid": "loki" },
        "targets": [{ "refId": "A", "expr": "sum by (event_type) (count_over_time({service_name=\"panopticon\"} | event_type != \"\" [2d]))", "legendFormat": "{{event_type}}" }],
        "options": { "legend": { "placement": "right" } }
      },
      {
        "id": 5, "title": "Recent Prompts", "type": "logs",
        "gridPos": { "h": 10, "w": 24, "x": 0, "y": 16 },
        "datasource": { "type": "loki", "uid": "loki" },
        "targets": [{ "refId": "A", "expr": "{service_name=\"panopticon\"} | event_type = \"UserPromptSubmit\" | line_format \"{{.prompt}}\"", "maxLines": 50 }],
        "options": { "showLabels": false, "showTime": true, "wrapLogMessage": true, "sortOrder": "Descending", "enableLogDetails": true }
      }
    ]
  },
  "overwrite": true
}
DASHBOARD

echo ""
echo "=== Done ==="
echo ""
echo "  OpenClaw:  $OPENCLAW_URL"
echo "  Grafana:   $GRAFANA_URL/d/panopticon-openclaw (admin / admin)"
echo "  Panopticon: $PANOPTICON_URL/health"
echo ""
echo "Send a prompt in the OpenClaw web UI, then check Grafana for data."
echo ""
echo "Teardown:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml down -v"
