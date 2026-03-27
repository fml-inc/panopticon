# ─── Base stage: shared by all tool tests ───────────────────────────────────
FROM node:22-slim AS base

# Build deps for better-sqlite3 + test utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssl sqlite3 python3 make g++ curl jq bash \
  && rm -rf /var/lib/apt/lists/*

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /opt/panopticon

# Copy source and build
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm rebuild better-sqlite3 && pnpm build

# Make panopticon CLI available globally
RUN ln -sf /opt/panopticon/bin/panopticon /usr/local/bin/panopticon \
  && chmod +x /opt/panopticon/bin/panopticon

# Set up a git workspace (CLI tools expect a repo with at least one commit)
RUN git init /workspace \
  && cd /workspace \
  && git config user.email "test@panopticon.dev" \
  && git config user.name "Panopticon Test" \
  && echo "# Panopticon E2E Test Workspace" > README.md \
  && git add README.md \
  && git commit -m "Initial commit"

# Copy test scripts
COPY test/e2e/scripts/ /opt/e2e/scripts/
RUN chmod +x /opt/e2e/scripts/*.sh

# Use bash so install writes .bashrc (not .zshrc)
ENV SHELL=/bin/bash
ENV HOME=/root
ENV PANOPTICON_PORT=4318

WORKDIR /workspace

# ─── Claude Code ────────────────────────────────────────────────────────────
FROM base AS test-claude
RUN npm install -g @anthropic-ai/claude-code
ENTRYPOINT ["/opt/e2e/scripts/test-claude.sh"]

# ─── Gemini CLI ─────────────────────────────────────────────────────────────
FROM base AS test-gemini
RUN npm install -g @google/gemini-cli
ENTRYPOINT ["/opt/e2e/scripts/test-gemini.sh"]

# ─── Codex CLI ──────────────────────────────────────────────────────────────
FROM base AS test-codex
RUN npm install -g @openai/codex
ENTRYPOINT ["/opt/e2e/scripts/test-codex.sh"]

# ─── Grafana OTEL sync (no CLI tool needed) ────────────────────────────────
FROM base AS test-grafana
ENTRYPOINT ["/opt/e2e/scripts/test-grafana.sh"]

# ─── Sync data-loss validation (organic CLI telemetry → Grafana) ─────────────
FROM base AS test-sync-validation
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli
ENTRYPOINT ["/opt/e2e/scripts/test-sync-validation.sh"]
