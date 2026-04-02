#!/usr/bin/env bash
#
# cleanup-ghost-sessions.sh — Remove ghost sessions created by panopticon's
# summary engine calling `claude -p` without --no-session-persistence.
#
# These are 3-turn (or 2-turn) sessions where the first prompt starts with
# "Summarize this coding session segment". They pollute the scanner data
# and inflate session counts.
#
# Usage:
#   ./scripts/cleanup-ghost-sessions.sh [--panopticon-db=PATH] [--dry-run]
#
# Default DB path: ~/.panopticon/data.db (Linux) or
#   ~/Library/Application Support/panopticon/data.db (macOS)

set -euo pipefail

DRY_RUN=false

# Detect default DB path
if [[ "$OSTYPE" == "darwin"* ]]; then
  DEFAULT_DB="$HOME/Library/Application Support/panopticon/data.db"
else
  DEFAULT_DB="$HOME/.panopticon/data.db"
fi
PANOPTICON_DB="${PANOPTICON_DB:-$DEFAULT_DB}"

for arg in "$@"; do
  case "$arg" in
    --panopticon-db=*) PANOPTICON_DB="${arg#*=}" ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

if [ ! -f "$PANOPTICON_DB" ]; then
  echo "ERROR: DB not found at $PANOPTICON_DB"
  exit 1
fi

echo "=== Ghost Session Cleanup ==="
echo "DB: $PANOPTICON_DB"
echo ""

# Identify ghost sessions: scanner_turns where turn_index=0, role='user',
# and content_preview starts with the summary prompt
GHOST_COUNT=$(sqlite3 "$PANOPTICON_DB" "
  SELECT COUNT(DISTINCT s.session_id)
  FROM sessions s
  JOIN scanner_turns st ON st.session_id = s.session_id
  WHERE st.turn_index = 0
    AND st.role = 'user'
    AND st.content_preview LIKE 'Summarize this coding session segment%'
")

echo "Found $GHOST_COUNT ghost summary sessions"

if [ "$GHOST_COUNT" -eq 0 ]; then
  echo "Nothing to clean up."
  exit 0
fi

# Show breakdown
echo ""
sqlite3 -header -column "$PANOPTICON_DB" "
  SELECT
    s.target,
    COUNT(DISTINCT s.session_id) as sessions,
    SUM(s.turn_count) as total_turns,
    date(MIN(s.started_at_ms)/1000, 'unixepoch', 'localtime') as earliest,
    date(MAX(s.started_at_ms)/1000, 'unixepoch', 'localtime') as latest
  FROM sessions s
  JOIN scanner_turns st ON st.session_id = s.session_id
  WHERE st.turn_index = 0
    AND st.role = 'user'
    AND st.content_preview LIKE 'Summarize this coding session segment%'
  GROUP BY s.target
"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "[dry-run] Would delete $GHOST_COUNT sessions and their turns/events."
  echo "Run without --dry-run to execute."
  exit 0
fi

echo ""

# Collect JSONL file paths BEFORE deleting from DB
echo "Collecting ghost JSONL file paths..."
GHOST_FILES=$(mktemp)
sqlite3 "$PANOPTICON_DB" "
  SELECT scanner_file_path
  FROM sessions s
  JOIN scanner_turns st ON st.session_id = s.session_id
  WHERE st.turn_index = 0
    AND st.role = 'user'
    AND st.content_preview LIKE 'Summarize this coding session segment%'
    AND s.scanner_file_path IS NOT NULL
  GROUP BY s.session_id
" > "$GHOST_FILES"
FILE_COUNT=$(wc -l < "$GHOST_FILES" | tr -d ' ')
echo "  $FILE_COUNT JSONL files to delete"

echo ""
echo "Deleting ghost sessions from DB..."

sqlite3 "$PANOPTICON_DB" "
  -- Collect ghost session IDs
  CREATE TEMP TABLE ghost_ids AS
  SELECT DISTINCT s.session_id
  FROM sessions s
  JOIN scanner_turns st ON st.session_id = s.session_id
  WHERE st.turn_index = 0
    AND st.role = 'user'
    AND st.content_preview LIKE 'Summarize this coding session segment%';

  -- Delete from all related tables
  DELETE FROM scanner_events WHERE session_id IN (SELECT session_id FROM ghost_ids);
  DELETE FROM scanner_turns WHERE session_id IN (SELECT session_id FROM ghost_ids);
  DELETE FROM session_repositories WHERE session_id IN (SELECT session_id FROM ghost_ids);
  DELETE FROM session_cwds WHERE session_id IN (SELECT session_id FROM ghost_ids);
  DELETE FROM hook_events WHERE session_id IN (SELECT session_id FROM ghost_ids);

  -- Delete scanner file watermarks for ghost session files
  DELETE FROM scanner_file_watermarks WHERE file_path IN (
    SELECT scanner_file_path FROM sessions
    WHERE session_id IN (SELECT session_id FROM ghost_ids)
    AND scanner_file_path IS NOT NULL
  );

  DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM ghost_ids);

  DROP TABLE ghost_ids;
"

# Delete the ghost JSONL files from disk
echo "Deleting ghost JSONL files..."
DELETED_FILES=0
while IFS= read -r fpath; do
  if [ -n "$fpath" ] && [ -f "$fpath" ]; then
    rm "$fpath"
    DELETED_FILES=$((DELETED_FILES + 1))
  fi
done < "$GHOST_FILES"
rm "$GHOST_FILES"

echo ""
echo "Done!"
echo "  Sessions deleted: $GHOST_COUNT"
echo "  JSONL files deleted: $DELETED_FILES (of $FILE_COUNT found in DB)"
echo ""
echo "Run 'panopticon status' to verify."
