# Panopticon PR Review

Review the current branch as a thorough code reviewer would review a pull request.

## Steps

1. Determine the base branch, usually `main`, and the current branch name.
2. Run `git diff main...HEAD` to see all changes on this branch.
3. Run `git log main..HEAD --oneline` to understand the commit history.
4. Read any files that need fuller context to understand the changes.

After producing the review, if lingering questions remain about coding intent or choices, query Panopticon's local session DB and, when available, FML's synced session source to answer them. Do not query Panopticon/FML while producing the review. The review should reflect what the diff says, not what session history says. Only use session history for "why" questions that the code and commit messages did not resolve. Append any answers under a **Follow-up: panopticon/FML-sourced intent** section after the Verdict.

## Querying Panopticon And Synced FML Sessions

Always check the local Panopticon DB first. Then, if the `fml` CLI is installed and usable in this environment, also check synced sessions with the same time window and keywords. FML may be absent, logged out, or unable to reach the service; if so, note that synced sources were unavailable and continue with the local DB rather than failing the review.

For common local lookups, prefer purpose-built subcommands or MCP tools:

- `panopticon sessions` or MCP `sessions`: list recent sessions with stats.
- `panopticon timeline <session-id>` or MCP `timeline`: pull messages and tool calls for a session.
- `panopticon search <query>` or MCP `search`: full-text search across events and messages.

Fall back to raw SQL via `panopticon query "<SQL>"` or MCP `query` for ad-hoc joins the subcommands do not cover. Key local tables:

- `sessions`: one row per agent session. Useful columns: `session_id`, `started_at_ms`, `first_prompt`, `model`, `machine`, `parent_session_id`, `relationship_type`. `sessions.cwd` is usually NULL; cwd is stored in `session_cwds`.
- `session_cwds(session_id, cwd, first_seen_ms)`: one row per session/cwd. Prefer this for session cwd lookup.
- `hook_events`: per-event stream. Columns include `session_id`, `event_type`, `timestamp_ms`, `cwd`, `tool_name`, `user_prompt`, `target`. Scanner-only sessions may have zero hook events.
- `messages`: user/assistant turns with content. `messages_fts` is a contentless FTS5 table; join it to `messages` by rowid.
- `tool_calls`: tool invocations linked to messages. Columns include `tool_name`, `input_json`, `result_content`.
- `scanner_turns`: token-level turn stats from local session files.

FTS footgun: hyphens are not operators. `MATCH 'panopticon-review'` can fail with `no such column: review`; quote hyphenated terms as `MATCH '"panopticon-review"'`.

Typical flow to find sessions behind a branch:

1. Search `sessions.first_prompt` across the commit authorship window. Derive the window from `git log main..HEAD --format=%at` and multiply by 1000 for ms. Do not start by filtering on `hook_events.cwd`; subagents and scanner-only sessions can have no hook events.
2. For keyword search across message content, join `messages_fts` to `messages` by rowid or use `panopticon search <query>`.
3. Pull relevant conversations with `panopticon timeline <session-id>` or `SELECT role, content FROM messages WHERE session_id = ? ORDER BY ordinal`.
4. For cwd filtering, join `session_cwds`. Use `hook_events.cwd` only for event-level cwd attribution.
5. Check synced FML sessions if available:
   - Probe binary availability with `command -v fml`.
   - Verify synced-session usability with a lightweight data command such as `fml sessions --since 24h --limit 1`.
   - Convert the commit authorship window into a conservative `--since` duration that covers the oldest branch commit.
   - Use `fml search --since <duration> --limit <n> <query>` and `fml sessions --since <duration> --limit <n>`.
   - Pull relevant conversations with `fml timeline <session-id> --limit <n>`.

Prefer corroborated local plus synced evidence when both exist. If they disagree, state the discrepancy. If neither local Panopticon nor synced FML covers the commit window, say so instead of guessing. Sanity-check local coverage with `SELECT datetime(MAX(started_at_ms)/1000,'unixepoch') FROM sessions` before declaring no coverage; `sessions.machine` tells you which host a session ran on.

## Review Format

Include:

- **Branch**: current branch name.
- **Summary**: what the changes do overall.
- **File-by-file review**: for each changed file, note what changed and any concerns.
- **Issues found**: bugs, logic errors, security concerns, style problems, and missing edge cases.
- **Reinventing the wheel**: flag code that reimplements functionality already available in this codebase, imported libraries, or the standard library. Search before flagging and cite the existing function or package.
- **Suggestions**: improvements, simplifications, or alternatives.
- **Verdict**: approve, request changes, or comment-only.

Be direct and specific. Reference file paths and line numbers. Focus on correctness, security, and maintainability rather than nitpicks.

After the verdict, if Panopticon or FML queries answered any intent questions, add a **Follow-up: panopticon/FML-sourced intent** section summarizing what was found and which review items it confirmed, softened, or contradicted. If local DB and synced FML sources do not cover the branch's commit window, say so.
