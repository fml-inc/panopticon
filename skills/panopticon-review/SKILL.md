---
name: panopticon-review
description: "Review the current branch as if reviewing a PR. Returns the review inline; queries panopticon for author-intent follow-ups only after the review is drafted."
---

# PR Review

Review the current branch as a thorough code reviewer would review a pull request.

## Steps

1. Determine the base branch (usually `main`) and the current branch name
2. Run `git diff main...HEAD` to see all changes on this branch
3. Run `git log main..HEAD --oneline` to understand the commit history
4. Read any files that need fuller context to understand the changes

After you produce the review, if you have lingering questions about the coding intent or the choices made, query panopticon's local session DB to try to answer them. Do not query panopticon while producing the review — the review should reflect what the diff tells you, not what you had to ask the DB about. Only reach for panopticon for the *"why"* questions that the code and commit messages didn't resolve. Append any answers under a **Follow-up: panopticon-sourced intent** section after the Verdict.

### Querying panopticon

For common lookups, prefer purpose-built subcommands — they're faster than writing SQL:

- `panopticon sessions` — list recent sessions with stats (event counts, tools, cost).
- `panopticon timeline <session-id>` — pull messages + tool calls for a session.
- `panopticon search <query>` — full-text search across events and messages.

Fall back to raw SQL via `panopticon query "<SQL>"` (prints JSON to stdout) for ad-hoc joins the subcommands don't cover. Key tables:

- `sessions` — one row per agent session. Useful columns: `session_id`, `started_at_ms`, `first_prompt`, `model`, `machine`, `parent_session_id`, `relationship_type`. (`target` is almost always `'claude'` — not discriminative.) Note: `sessions.cwd` is always NULL; cwd is stored in the `session_cwds` junction table below.
- `session_cwds(session_id, cwd, first_seen_ms)` — one row per (session, cwd). The canonical cwd lookup for any session that ever emitted one. Prefer this over `hook_events.cwd`.
- `hook_events` — per-event stream. Columns include `session_id`, `event_type`, `timestamp_ms`, `cwd`, `tool_name`, `user_prompt`, `target`. Only populated when hooks fired — scanner-only sessions will have zero rows here.
- `messages` — user/assistant turns with content. `messages_fts` is a contentless FTS5 virtual table (single `content` column, no metadata, `snippet()` returns NULL) — join it to `messages` by rowid: `SELECT m.session_id, substr(m.content,1,200) FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH 'foo bar'`. **FTS footgun: hyphens are NOT operators.** `MATCH 'panopticon-review'` fails with `no such column: review`. Quote hyphenated terms: `MATCH '"panopticon-review"'`.
- `tool_calls` — tool invocations linked to messages. Columns include `tool_name`, `input_json`, `result_content`.
- `scanner_turns` — token-level turn stats from local session files.

Typical flow to find the session(s) behind a branch:

1. **Start by searching `sessions.first_prompt` across the commit authorship window.** Derive the window from `git log main..HEAD --format=%at` (multiply by 1000 for ms). Don't filter by cwd first via hook_events — many sessions (subagents, Task-spawned sessions, any scanner-only session) have zero hook events and would be silently dropped. `session_id LIKE 'agent-%'` identifies subagents/Task-spawned sessions vs. UUID-style top-level sessions, but don't use it as a filter — both kinds are usually relevant. Note that `first_prompt` often starts with `<command-message>`/`<local-command-caveat>` wrappers, so a `LIKE '%foo%'` match may land inside the wrapper rather than real user intent:
   ```sql
   SELECT session_id, datetime(started_at_ms/1000,'unixepoch') AS ts,
          substr(first_prompt,1,150) AS prompt
   FROM sessions
   WHERE started_at_ms BETWEEN <start_ms> AND <end_ms>
     AND (first_prompt LIKE '%<keyword-from-diff>%'
          OR first_prompt LIKE '%/workspace/<repo>%')
   ORDER BY started_at_ms;
   ```
2. For keyword search across all message content, join `messages_fts` to `messages` by rowid (or use `panopticon search <query>`).
3. Pull the actual conversation with `panopticon timeline <session-id>` or `SELECT role, content FROM messages WHERE session_id = ? ORDER BY ordinal`.
4. Need cwd filtering? Join `session_cwds` — it covers every session with a known cwd. Only fall back to `hook_events.cwd` when you specifically need event-level cwd attribution (e.g. a session that changed cwds mid-run).

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

After the verdict, if panopticon queries answered any of your intent questions, add a **Follow-up: panopticon-sourced intent** section that summarizes what you found and which review items it confirmed, softened, or contradicted. If the local DB doesn't cover the branch's commit window, say so instead of guessing.
