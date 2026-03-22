#!/usr/bin/env bash
#
# Install panopticon from source via gh CLI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/fml-inc/panopticon/main/install.sh | bash
#
# Prerequisites:
#   - Node.js >= 22
#   - gh CLI authenticated (`gh auth login`)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${BOLD}%s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$*"; }
fail()  { printf "${RED}✗ %s${RESET}\n" "$*"; exit 1; }

INSTALL_DIR="${PANOPTICON_DIR:-${HOME}/.panopticon}"

# ── Preflight checks ────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || fail "Node.js is required. Install Node >= 22 first."
command -v gh >/dev/null 2>&1   || fail "gh CLI is required. Install it: https://cli.github.com"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node >= 22 required (found $(node -v)). Update Node first."
fi

gh auth status >/dev/null 2>&1 || fail "Not authenticated. Run: gh auth login"

# ── Clone or update ─────────────────────────────────────────────────────

if [ -d "${INSTALL_DIR}/.git" ]; then
  info "Updating panopticon..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning panopticon..."
  gh repo clone fml-inc/panopticon "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── Install deps & build ────────────────────────────────────────────────

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
else
  warn "pnpm not found — installing via corepack"
  corepack enable
  corepack prepare pnpm@latest --activate
  pnpm install --frozen-lockfile
fi

pnpm run build
ok "Built successfully"

# ── Run panopticon install ──────────────────────────────────────────────

info "Running panopticon install..."
node bin/panopticon install --skip-build

ok "Done! Restart your shell or run: source ~/.zshrc"
