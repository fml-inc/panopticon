---
name: pr-review
description: "Review the current branch as if reviewing a PR."
---

# PR Review

Review the current branch as a thorough code reviewer would review a pull request.

## Steps

1. Determine the base branch (usually `main`) and the current branch name
2. Run `git diff main...HEAD` to see all changes on this branch
3. Run `git log main..HEAD --oneline` to understand the commit history
4. Read any files that need fuller context to understand the changes

As you do your review, if you have questions about the coding intent or the choices made, query panopticon's local session DB to try to answer them.

### Querying panopticon

Run SQL via `panopticon query "<SQL>"` — it prints JSON to stdout. Key tables:

- `sessions` — one row per agent session. Useful columns: `session_id`, `started_at_ms`, `first_prompt`, `model`, `target`. Note: `sessions.cwd` is NULL; `cwd` lives on `hook_events.cwd` instead.
- `hook_events` — per-event stream. Columns include `session_id`, `event_type`, `timestamp_ms`, `cwd`, `tool_name`, `user_prompt`, `target`.
- `messages` — user/assistant turns with content. `messages_fts` is a contentless FTS5 virtual table (single `content` column, no metadata, `snippet()` returns NULL) — join it to `messages` by rowid: `SELECT m.session_id, substr(m.content,1,200) FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH 'foo bar'`.
- `tool_calls` — tool invocations linked to messages. Columns include `tool_name`, `input_json`, `result_content`.
- `scanner_turns` — token-level turn stats from local session files.

Typical flow to find the session(s) behind a branch:

1. **Start by searching `sessions.first_prompt` across the commit authorship window.** Don't filter by cwd first — many sessions (subagents, Task-spawned sessions, any scanner-only session) have zero hook events, so joining through `hook_events.cwd` silently drops them. `session_id LIKE 'agent-%'` identifies subagents/Task-spawned sessions vs. UUID-style top-level sessions, but don't use it as a filter — both kinds are usually relevant. Note that `first_prompt` often starts with `<command-message>`/`<local-command-caveat>` wrappers, so a `LIKE '%foo%'` match may land inside the wrapper rather than real user intent:
   ```sql
   SELECT session_id, datetime(started_at_ms/1000,'unixepoch') AS ts,
          substr(first_prompt,1,150) AS prompt
   FROM sessions
   WHERE started_at_ms BETWEEN <start_ms> AND <end_ms>
     AND (first_prompt LIKE '%<keyword-from-diff>%'
          OR first_prompt LIKE '%/workspace/<repo>%')
   ORDER BY started_at_ms;
   ```
2. For keyword search across all message content, join `messages_fts` to `messages` by rowid: `SELECT m.session_id, substr(m.content,1,200) FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH 'foo bar'`.
3. Pull the actual conversation with `SELECT role, content FROM messages WHERE session_id = ? ORDER BY ordinal`.
4. Only fall back to `hook_events.cwd` filtering when you already know the session has hook coverage — it's useful for interactive sessions that emit PreToolUse/PostToolUse events, but it misses scanner-only sessions entirely.

If the local DB genuinely doesn't have coverage for the commit window (e.g. the work happened on a different machine), say so in the review rather than guessing. Sanity-check with `SELECT datetime(MAX(started_at_ms)/1000,'unixepoch') FROM sessions` before declaring "no coverage"; `sessions.machine` tells you which host a session ran on.

## Review Format

The review should include:

- **Branch**: current branch name
- **Summary**: What the changes do overall
- **File-by-file review**: For each changed file, note what changed and any concerns
- **Issues found**: Bugs, logic errors, security concerns, style problems, missing edge cases
- **Reinventing the wheel**: Flag code that reimplements functionality already available in the codebase's existing utilities/helpers, imported libraries, or standard library. Search the codebase and dependencies before flagging — cite the existing function or package that should be used instead.
- **Suggestions**: Improvements, simplifications, or alternatives
- **Verdict**: Approve, request changes, or comment-only

Be direct and specific. Reference file paths and line numbers. Focus on things that matter — correctness, security, maintainability — not nitpicks.
