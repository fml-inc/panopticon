# ─── Base stage: shared by all tool tests ───────────────────────────────────
FROM node:24-slim AS base

# Test utilities (sqlite3 CLI for in-test queries; bash/curl/jq for shell asserts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssl sqlite3 curl jq bash \
  && rm -rf /var/lib/apt/lists/*

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /opt/panopticon

# Copy source and build
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
# Build the main dist/, then bundle the e2e mock sync server via a
# separate tsup config (its source lives outside src/ so the main
# config's DTS pass can't include it).
RUN pnpm build \
  && pnpm exec tsup --config scripts/test-sync-server.tsup.config.ts

# Make panopticon CLI available globally
RUN ln -sf /opt/panopticon/bin/panopticon /usr/local/bin/panopticon \
  && chmod +x /opt/panopticon/bin/panopticon

# Set up a git workspace (CLI tools expect a repo with at least one commit).
# The `origin` remote is load-bearing — panopticon's sync loop filters
# sessions without repo attribution (`requireRepo: true` default since #142),
# and repo resolution walks git remotes rather than the repo name on disk.
# A fake URL that never gets pushed to is enough for resolveGitRemote().
RUN git init /workspace \
  && cd /workspace \
  && git config user.email "test@panopticon.dev" \
  && git config user.name "Panopticon Test" \
  && git remote add origin https://github.com/panopticon-test/e2e-workspace.git \
  && echo "# Panopticon E2E Test Workspace" > README.md \
  && git add README.md \
  && git commit -m "Initial commit"

# Copy test scripts
COPY test/e2e/scripts/ /opt/e2e/scripts/
RUN chmod +x /opt/e2e/scripts/*.sh

# Run as non-root user
RUN useradd -m -s /bin/bash testuser \
  && chown -R testuser:testuser /opt/panopticon /opt/e2e /workspace

USER testuser
ENV SHELL=/bin/bash
ENV HOME=/home/testuser
ENV PANOPTICON_PORT=4318

WORKDIR /workspace

# ─── Sync data-loss validation (organic CLI telemetry → Grafana) ─────────────
FROM base AS test-sync-validation
# Global npm install must happen before USER switch
USER root
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli
USER testuser
ENTRYPOINT ["/opt/e2e/scripts/test-sync-validation.sh"]
