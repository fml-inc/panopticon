#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GRAFANA_URL="http://localhost:3001"
OTLP_URL="http://localhost:14318"
TARGET_NAME="local-grafana"

echo "=== Panopticon → Grafana Setup ==="
echo ""

# 1. Start the stack
echo "Starting Grafana OTEL LGTM stack..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d

# 2. Wait for Grafana to be ready
echo -n "Waiting for Grafana"
for i in $(seq 1 30); do
  if curl -sf "$GRAFANA_URL/api/health" > /dev/null 2>&1; then
    echo " ready!"
    break
  fi
  echo -n "."
  sleep 2
done

# 3. Provision the dashboard
echo "Creating dashboard..."
curl -sf -X POST "$GRAFANA_URL/api/dashboards/db" \
  -H "Content-Type: application/json" \
  -u admin:admin \
  -d @- > /dev/null << 'DASHBOARD'
{
  "dashboard": {
    "uid": "panopticon-main",
    "title": "Panopticon — Claude Code Usage",
    "tags": ["panopticon"],
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
        "id": 5, "title": "API Calls by Model", "type": "piechart",
        "gridPos": { "h": 8, "w": 8, "x": 16, "y": 8 },
        "datasource": { "type": "loki", "uid": "loki" },
        "targets": [{ "refId": "A", "expr": "sum by (model) (count_over_time({service_name=\"panopticon\"} | cost_usd != \"\" [2d]))", "legendFormat": "{{model}}" }],
        "options": { "legend": { "placement": "right" } }
      },
      {
        "id": 6, "title": "Recent Prompts", "type": "logs",
        "gridPos": { "h": 10, "w": 24, "x": 0, "y": 16 },
        "datasource": { "type": "loki", "uid": "loki" },
        "targets": [{ "refId": "A", "expr": "{service_name=\"panopticon\"} | event_type = \"UserPromptSubmit\" | line_format \"{{.prompt}}\"", "maxLines": 50 }],
        "options": { "showLabels": false, "showTime": true, "wrapLogMessage": true, "sortOrder": "Descending", "enableLogDetails": true, "showCommonLabels": false }
      },
      {
        "id": 7, "title": "Tool Failures", "type": "timeseries",
        "gridPos": { "h": 8, "w": 12, "x": 0, "y": 26 },
        "datasource": { "type": "loki", "uid": "loki" },
        "targets": [{ "refId": "A", "expr": "sum by (tool_name) (count_over_time({service_name=\"panopticon\"} | event_type = \"PostToolUseFailure\" [30m]))", "legendFormat": "{{tool_name}}" }],
        "fieldConfig": { "defaults": { "custom": { "fillOpacity": 30, "lineWidth": 2 } } }
      },
      {
        "id": 8, "title": "API Latency", "type": "timeseries",
        "gridPos": { "h": 8, "w": 12, "x": 12, "y": 26 },
        "datasource": { "type": "loki", "uid": "loki" },
        "targets": [{ "refId": "A", "expr": "avg_over_time({service_name=\"panopticon\"} | cost_usd != \"\" | unwrap duration_ms [30m])", "legendFormat": "avg latency" }],
        "fieldConfig": { "defaults": { "custom": { "fillOpacity": 10, "lineWidth": 2 }, "unit": "ms" } }
      }
    ]
  },
  "overwrite": true
}
DASHBOARD

# 4. Configure Panopticon to sync to this stack
echo "Configuring sync target..."
panopticon sync add "$TARGET_NAME" "$OTLP_URL"

echo ""
echo "=== Done ==="
echo ""
echo "  Grafana:   $GRAFANA_URL/d/panopticon-main (admin / admin)"
echo "  Sync:      panopticon sync list"
echo ""
echo "Restart panopticon to start syncing:"
echo "  panopticon stop && panopticon start"
