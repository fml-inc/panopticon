#!/usr/bin/env bash
#
# test-superset-db.sh — Correlate Claude JSONL session files with Superset's
# worktree→project mappings to see how many sessions can be resolved to repos.
#
# Reads:  ~/.superset/local.db   (Superset's project/worktree DB)
#         ~/.claude/projects/    (Claude Code JSONL session files)
#
# Usage:  ./scripts/test-superset-db.sh [--superset-db=PATH]

set -euo pipefail

SUPERSET_DB="${SUPERSET_DB:-$HOME/.superset/local.db}"
CLAUDE_PROJECTS="${CLAUDE_PROJECTS:-$HOME/.claude/projects}"

for arg in "$@"; do
  case "$arg" in
    --superset-db=*) SUPERSET_DB="${arg#*=}" ;;
    --claude-projects=*) CLAUDE_PROJECTS="${arg#*=}" ;;
  esac
done

if [ ! -f "$SUPERSET_DB" ]; then
  echo "ERROR: Superset DB not found at $SUPERSET_DB"
  exit 1
fi

if [ ! -d "$CLAUDE_PROJECTS" ]; then
  echo "ERROR: Claude projects dir not found at $CLAUDE_PROJECTS"
  exit 1
fi

echo "=== Superset → Claude session correlation ==="
echo "  Superset DB:     $SUPERSET_DB"
echo "  Claude projects: $CLAUDE_PROJECTS"
echo ""

# ── Step 1: Dump Superset project → repo mappings ──────────────────────────

echo "── Superset projects ──"
sqlite3 -header -column "$SUPERSET_DB" "
  SELECT name, main_repo_path, worktree_base_dir, github_owner
  FROM projects ORDER BY name;
"
echo ""

# Resolve git remote for each project
echo "── Git remote resolution ──"
declare -A PROJECT_REPO  # project name → org/repo

while IFS='|' read -r name repo_path; do
  [ -z "$name" ] && continue
  if [ -d "$repo_path" ]; then
    url=$(git -C "$repo_path" remote get-url origin 2>/dev/null || true)
    if [ -n "$url" ]; then
      repo=$(echo "$url" | sed -E 's/.*github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/\1/')
      if [ -n "$repo" ] && [ "$repo" != "$url" ]; then
        PROJECT_REPO["$name"]="$repo"
        echo "  $name → $repo"
      else
        echo "  $name → PARSE FAILED ($url)"
      fi
    else
      echo "  $name → NO REMOTE"
    fi
  else
    echo "  $name → DIR NOT FOUND ($repo_path)"
  fi
done < <(sqlite3 "$SUPERSET_DB" "SELECT name, main_repo_path FROM projects ORDER BY name;")
echo ""

# ── Step 2: Get worktree base dirs per project ─────────────────────────────

echo "── Superset worktree base dirs ──"
declare -A BASE_TO_PROJECT  # worktree base dir → project name

# From worktrees table: extract parent dir of each worktree path
while IFS='|' read -r wt_path project_name; do
  [ -z "$wt_path" ] && continue
  base_dir=$(dirname "$wt_path")
  BASE_TO_PROJECT["$base_dir"]="$project_name"
done < <(sqlite3 "$SUPERSET_DB" "
  SELECT DISTINCT w.path, p.name
  FROM worktrees w JOIN projects p ON w.project_id = p.id;
")

# Also from projects.worktree_base_dir
while IFS='|' read -r base_dir name; do
  [ -z "$base_dir" ] && continue
  BASE_TO_PROJECT["$base_dir"]="$name"
done < <(sqlite3 "$SUPERSET_DB" "
  SELECT worktree_base_dir, name FROM projects
  WHERE worktree_base_dir IS NOT NULL AND worktree_base_dir != '';
")

for base in "${!BASE_TO_PROJECT[@]}"; do
  proj="${BASE_TO_PROJECT[$base]}"
  repo="${PROJECT_REPO[$proj]:-???}"
  echo "  $base → $proj ($repo)"
done
echo ""

# ── Step 3: Scan Claude project dirs and match ─────────────────────────────

echo "── Claude session dirs matched to Superset projects ──"
echo ""

TOTAL_DIRS=0
MATCHED_DIRS=0
MATCHED_FILES=0
UNMATCHED_DIRS=0
UNMATCHED_FILES=0

# For each project slug dir in ~/.claude/projects/
for slug_dir in "$CLAUDE_PROJECTS"/*/; do
  [ -d "$slug_dir" ] || continue
  TOTAL_DIRS=$((TOTAL_DIRS + 1))

  # Count JSONL files in this dir
  file_count=$(find "$slug_dir" -maxdepth 1 -name "*.jsonl" 2>/dev/null | wc -l | tr -d ' ')
  [ "$file_count" -eq 0 ] && continue

  slug=$(basename "$slug_dir")
  matched_project=""
  matched_repo=""

  # Check if the slug contains a superset worktree base dir pattern
  for base in "${!BASE_TO_PROJECT[@]}"; do
    # Convert base dir to what it would look like in a slug
    # /Users/p/.superset/worktrees/fml → -Users-p--superset-worktrees-fml
    slug_pattern=$(echo "$base" | sed 's|^/||; s|/|-|g; s|\.|-|g')

    if [[ "$slug" == *"$slug_pattern"* ]]; then
      matched_project="${BASE_TO_PROJECT[$base]}"
      matched_repo="${PROJECT_REPO[$matched_project]:-???}"
      break
    fi
  done

  if [ -n "$matched_project" ]; then
    MATCHED_DIRS=$((MATCHED_DIRS + 1))
    MATCHED_FILES=$((MATCHED_FILES + file_count))
    echo "  MATCH  $slug"
    echo "         → $matched_project ($matched_repo) [$file_count sessions]"
  else
    # Check if it's a superset path at all
    if [[ "$slug" == *"superset"* ]]; then
      UNMATCHED_DIRS=$((UNMATCHED_DIRS + 1))
      UNMATCHED_FILES=$((UNMATCHED_FILES + file_count))
      echo "  MISS   $slug [$file_count sessions]"
    fi
  fi
done

echo ""
echo "── Summary ──"
echo "  Total Claude project dirs:          $TOTAL_DIRS"
echo "  Matched to Superset project:        $MATCHED_DIRS dirs ($MATCHED_FILES sessions)"
echo "  Superset dirs without match:        $UNMATCHED_DIRS dirs ($UNMATCHED_FILES sessions)"
echo "  Non-superset dirs (not checked):    $((TOTAL_DIRS - MATCHED_DIRS - UNMATCHED_DIRS))"
