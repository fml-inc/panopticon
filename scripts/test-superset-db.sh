#!/usr/bin/env bash
#
# test-superset-db.sh — Inspect Superset's local.db to see if we can
# resolve repos for panopticon sessions via worktree → project mappings.
#
# Usage:
#   ./scripts/test-superset-db.sh [--superset-db=PATH] [--panopticon-db=PATH]

set -euo pipefail

SUPERSET_DB="${SUPERSET_DB:-$HOME/.superset/local.db}"
PANOPTICON_DB="${PANOPTICON_DB:-$HOME/.panopticon/data.db}"

for arg in "$@"; do
  case "$arg" in
    --superset-db=*) SUPERSET_DB="${arg#*=}" ;;
    --panopticon-db=*) PANOPTICON_DB="${arg#*=}" ;;
  esac
done

echo "=== Superset DB: $SUPERSET_DB ==="
echo ""

if [ ! -f "$SUPERSET_DB" ]; then
  echo "ERROR: not found"
  exit 1
fi

echo "── Tables ──"
sqlite3 "$SUPERSET_DB" ".tables"
echo ""

echo "── Projects ──"
sqlite3 -header -column "$SUPERSET_DB" "
  SELECT id, name, main_repo_path, worktree_base_dir, github_owner
  FROM projects
  ORDER BY last_opened_at DESC;
"
echo ""

echo "── Worktrees ──"
sqlite3 -header -column "$SUPERSET_DB" "
  SELECT w.id, p.name as project, w.path, w.branch
  FROM worktrees w
  JOIN projects p ON w.project_id = p.id
  ORDER BY w.created_at DESC
  LIMIT 20;
"
echo ""

echo "── Worktree path → project main_repo_path ──"
sqlite3 -header -column "$SUPERSET_DB" "
  SELECT w.path as worktree_path, p.main_repo_path, p.name as project_name
  FROM worktrees w
  JOIN projects p ON w.project_id = p.id
  ORDER BY p.name, w.path;
"
echo ""

if [ -f "$PANOPTICON_DB" ]; then
  echo "=== Cross-reference with Panopticon DB: $PANOPTICON_DB ==="
  echo ""

  echo "── Panopticon sessions with superset CWD but NO repo ──"
  sqlite3 -header -column "$PANOPTICON_DB" "
    SELECT s.session_id, s.cwd, s.turn_count, s.total_input_tokens
    FROM sessions s
    LEFT JOIN session_repositories sr ON s.session_id = sr.session_id
    WHERE s.cwd LIKE '%/.superset/%'
      AND sr.session_id IS NULL
    ORDER BY s.started_at_ms DESC
    LIMIT 20;
  "
  echo ""

  echo "── Summary ──"
  sqlite3 -header -column "$PANOPTICON_DB" "
    SELECT
      count(*) as total_superset_sessions,
      sum(CASE WHEN sr.session_id IS NOT NULL THEN 1 ELSE 0 END) as has_repo,
      sum(CASE WHEN sr.session_id IS NULL THEN 1 ELSE 0 END) as missing_repo,
      sum(CASE WHEN sr.session_id IS NULL THEN total_input_tokens ELSE 0 END) as missing_tokens
    FROM sessions s
    LEFT JOIN session_repositories sr ON s.session_id = sr.session_id
    WHERE s.cwd LIKE '%/.superset/%';
  "
fi
