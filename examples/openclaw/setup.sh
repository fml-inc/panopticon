#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PANOPTICON_URL="http://localhost:4318"
OPENCLAW_URL="http://localhost:18789"

echo "=== OpenClaw + Panopticon Setup ==="
echo ""

# 1. Check prerequisites — at least one provider key must be set.
#    Sourcing .env here so the check and docker-compose both see the vars.
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env"
  set +o allexport
fi

if [ -z "${MOONSHOT_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Error: set at least one of MOONSHOT_API_KEY / ANTHROPIC_API_KEY."
  echo ""
  echo "  cp $SCRIPT_DIR/.env.example $SCRIPT_DIR/.env"
  echo "  # Edit .env and fill in whichever provider(s) you want to test."
  echo "  # Moonshot:  https://platform.moonshot.ai"
  echo "  # Anthropic: https://console.anthropic.com"
  echo ""
  exit 1
fi

# Echo which providers will be configured.
enabled=""
[ -n "${MOONSHOT_API_KEY:-}" ] && enabled="${enabled}moonshot "
[ -n "${ANTHROPIC_API_KEY:-}" ] && enabled="${enabled}anthropic "
echo "Providers to configure: ${enabled% }"
echo ""

# 2. Build panopticon. Always rebuild — a stale dist/ from a previous branch
# (e.g. with removed/renamed deps) silently ships the old bundle into the
# Docker image and the container crashes with cryptic module-not-found errors.
echo "Building panopticon..."
(cd "$REPO_ROOT" && npx tsup) > /dev/null
echo ""

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

# 5. Configure OpenClaw:
#    - diagnostics-otel plugin → panopticon:4318 (metrics, traces, logs)
#    - moonshot + anthropic providers, each with baseUrl rewritten to
#      http://panopticon:4318/proxy/<id> so the proxy captures bodies
#
# This logic mirrors src/targets/openclaw.ts applyInstallConfig but uses
# the container hostname `panopticon` instead of `localhost` — keep in sync.
#
# We exec as the `node` user so the config file is owned by the same uid
# OpenClaw runs as — otherwise OpenClaw's atomic-rewrite (tmp file + rename)
# fails with EACCES on every config-touch and the container crash-loops.
echo "Configuring OpenClaw (diagnostics + proxy rewrites)..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T -u node openclaw sh -c '
  mkdir -p /home/node/.openclaw
  CONFIG=/home/node/.openclaw/openclaw.json

  # The openclaw.json values below use ${MOONSHOT_API_KEY} / ${ANTHROPIC_API_KEY}
  # as literal strings — OpenClaw itself expands env vars at load time.
  node -e "
    const fs = require(\"fs\");
    const path = \"$CONFIG\";
    const cfg = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, \"utf-8\")) : {};

    // Plugins
    cfg.plugins = cfg.plugins || {};
    cfg.plugins.allow = cfg.plugins.allow || [];
    if (!cfg.plugins.allow.includes(\"diagnostics-otel\")) cfg.plugins.allow.push(\"diagnostics-otel\");
    cfg.plugins.entries = cfg.plugins.entries || {};
    cfg.plugins.entries[\"diagnostics-otel\"] = { enabled: true };

    // OTel → panopticon
    cfg.diagnostics = cfg.diagnostics || {};
    cfg.diagnostics.otel = {
      enabled: true,
      endpoint: \"http://panopticon:4318\",
      protocol: \"http/protobuf\",
      serviceName: \"openclaw-gateway\",
      traces: true, metrics: true, logs: true, sampleRate: 1.0,
    };

    // Providers — rewrite baseUrls to panopticon proxy (mirrors
    // src/targets/openclaw.ts applyInstallConfig with proxy: true).
    // Only configure providers whose API key is set in the container env;
    // setup.sh already enforces that at least one is set.
    cfg.models = cfg.models || {};
    cfg.models.providers = cfg.models.providers || {};
    if (process.env.MOONSHOT_API_KEY) {
      cfg.models.providers.moonshot = {
        baseUrl: \"http://panopticon:4318/proxy/moonshot\",
        apiKey: \"\${MOONSHOT_API_KEY}\",
        api: \"openai-completions\",
        models: [{ id: \"kimi-k2.5\", name: \"Kimi K2.5\" }],
      };
    }
    if (process.env.ANTHROPIC_API_KEY) {
      cfg.models.providers.anthropic = {
        baseUrl: \"http://panopticon:4318/proxy/anthropic\",
        apiKey: \"\${ANTHROPIC_API_KEY}\",
        api: \"anthropic-messages\",
        models: [{ id: \"claude-sonnet-4-6\", name: \"Claude Sonnet 4.6\" }],
      };
    }

    // Default agent — prefer moonshot if configured, else anthropic.
    const primary = process.env.MOONSHOT_API_KEY
      ? \"moonshot/kimi-k2.5\"
      : \"anthropic/claude-sonnet-4-6\";
    cfg.agents = cfg.agents || {};
    cfg.agents.defaults = cfg.agents.defaults || {};
    cfg.agents.defaults.model = { primary };

    fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + \"\\n\");
  "
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
echo "Next:"
echo "  1. Open $OPENCLAW_URL and send a prompt. The default agent uses Kimi"
echo "     (Moonshot). To test Anthropic, switch the model in the UI to"
echo "     anthropic/claude-sonnet-4-6."
echo ""
echo "  2. Verify proxy capture landed for the providers you exercised:"
echo "       $SCRIPT_DIR/verify-capture.sh"
echo ""
echo "  3. Or query directly:"
echo "       docker exec panopticon panopticon query \\"
echo "         \"SELECT target, COUNT(*) FROM hook_events WHERE source='proxy' GROUP BY target\""
echo ""
echo "Teardown:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml down -v"
