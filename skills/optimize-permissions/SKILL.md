---
name: optimize-permissions
description: "Turn panopticon's captured tool-call history into a persistent, auditable permission allowlist. Pairs with Claude Code's auto mode: pre-approved rules reduce classifier calls, survive context compaction, and work offline."
---

# Optimize Permissions

Analyze every tool call panopticon has ever recorded, categorize each pattern by risk, and persist an allowlist that the `PreToolUse` hook enforces locally. Category decisions stick across runs.

## Why this, when Claude Code already has auto mode?

Auto mode (released March 2026) asks a server-side classifier to judge each action in real time. That's great for novel situations, but has three structural gaps that a telemetry-driven allowlist fills:

| Auto mode (reactive classifier) | `/optimize-permissions` (persistent allowlist) |
| --- | --- |
| Per-action classifier call — adds latency, can time out or outage | Local O(1) match against `allowed.json` — zero network |
| Boundaries are conversation-scoped and lost on compaction | Rules persist across sessions, restarts, and repos |
| Broad allow rules (e.g. `Bash(*)`) are dropped when entering auto mode | Specific base-command rules survive auto mode and reduce its classifier load |
| Purely reactive — no memory of what you've approved before | Reads N months of actual usage; shows call counts before you decide |
| Requires Sonnet/Opus 4.6+ on Max/Team/Enterprise | Runs locally against any plan, any model |
| Opaque ("the classifier decided") | Plain-text `allowed.json` you can diff, audit, and version |

These are complementary, not competing. The sweet spot is: allowlist the things you *know* are safe from your own history, let auto mode handle the long tail.

**When to prefer allowlisting over auto mode for a given command:**
- It appears 10+ times in your history across 2+ sessions
- It falls into a risk category you've explicitly thought about
- You want it to work when the classifier is down or you're offline
- You want the decision to survive `/clear` and compaction

## Architecture

Permissions are enforced by panopticon's `PreToolUse` hook — panopticon does **not** write to `settings.local.json`, so the allowlist is independent of Claude Code's own permission files and compatible with auto mode.

- **Bash commands** → chain-aware enforcement: the hook splits chains (`&&`, `;`, `|`) and checks each component independently against approved base commands. `git status && git diff` passes if both `git status` and `git diff` are approved — you don't need to allow the literal chain.
- **Non-Bash tools** → exact name match against the allowed tools list

Both live in `~/.local/share/panopticon/permissions/allowed.json`. The hook returns `"permissionDecision": "allow"` only when the tool or all chain components match. Unmatched tools fall through to Claude Code's normal prompting (or auto mode's classifier, if active).

## MCP Tools

- **`permissions_show`** — Load existing approvals + current allowed tools/commands. Call this first (no arguments needed).
- **`permissions_apply`** — Write allowed.json (Bash commands + tool names), save approvals, and record a dedup'd snapshot in `user_config_snapshots` so the config sync captures the change. Call this at the end.

All analysis uses `query` against the `tool_calls` table (scanner data — captures 100% of history even before hooks were installed).

---

## Step 1 — Load State

Call `permissions_show` (no arguments). It returns:
- `approvals` — previously approved/denied categories and custom overrides
- `allowed` — current `{ bash_commands, tools }` list
- File paths for reference

`"safe"` is always pre-approved and cannot be removed.

## Step 2 — Identify Current Repository

Run `git remote get-url origin` and extract `org/repo` (strip `.git` suffix and host prefix). Used for snapshot annotation only — **not** for scoping queries, since the whitelist is global.

## Step 3 — Query Panopticon

The allowed list is global (not per-repo), so queries must aggregate across **all** repositories.

Queries use the `tool_calls` table (populated from scanner data — local JSONL transcript files). This works even at cold start before hooks are installed, since scanner data captures 100% of tool usage history.

Run via `query`:

**Query A — Non-Bash tools:**
```sql
SELECT tool_name, COUNT(*) as cnt
FROM tool_calls
WHERE tool_name != 'Bash'
GROUP BY tool_name ORDER BY cnt DESC
```

**Query B — All Bash commands (full command strings):**
```sql
SELECT
  json_extract(input_json, '$.command') as cmd,
  COUNT(*) as cnt
FROM tool_calls
WHERE tool_name = 'Bash'
  AND input_json IS NOT NULL
GROUP BY cmd ORDER BY cnt DESC
LIMIT 500
```

**Query C — Data coverage (sessions & date range):**
```sql
SELECT
  COUNT(DISTINCT tc.session_id) as session_count,
  MIN(s.started_at_ms) as earliest_ms,
  MAX(s.started_at_ms) as latest_ms,
  COUNT(*) as total_tool_calls
FROM tool_calls tc
JOIN sessions s ON tc.session_id = s.session_id
```

**Query D — Hook latency (conditional — may return 0 rows):**
```sql
SELECT
  tool_name,
  COUNT(*) as hook_calls,
  CAST(AVG(json_extract(metadata, '$.durationMs')) AS INTEGER) as avg_ms,
  SUM(json_extract(metadata, '$.durationMs')) as total_ms
FROM scanner_events
WHERE event_type = 'progress:PreToolUse'
  AND json_extract(metadata, '$.durationMs') IS NOT NULL
GROUP BY tool_name ORDER BY total_ms DESC
```
Note: `tool_name` values are prefixed, e.g. `"PreToolUse:Bash"`, `"PreToolUse:Read"`. Strip the `PreToolUse:` prefix to match against tool names from Query A.

**Query E — Evidence per base command (session spread & recency):**
```sql
SELECT
  json_extract(input_json, '$.command') as cmd,
  COUNT(*) as calls,
  COUNT(DISTINCT tc.session_id) as sessions,
  MAX(s.started_at_ms) as last_seen_ms,
  SUM(CASE WHEN s.started_at_ms > (strftime('%s','now','-7 days')*1000) THEN 1 ELSE 0 END) as calls_7d
FROM tool_calls tc
JOIN sessions s ON tc.session_id = s.session_id
WHERE tc.tool_name = 'Bash' AND tc.input_json IS NOT NULL
GROUP BY cmd
```

Aggregate these per base command after extraction (Step 4). For each base command, carry forward: total calls, distinct sessions, days-since-last-seen, last-7d activity. This is the evidence surfaced in Step 6's questions — the thing auto mode cannot show.

## Step 3.5 — Cold Start Check

If Queries A and B **both** return 0 rows, stop and inform the user:

> No tool usage data found. Panopticon needs scanner data to analyze your tool patterns.
> Run `panopticon scan` to process your existing Claude Code session files, then re-run `/optimize-permissions`.

Do not fall back to `hook_events` — that reintroduces the cold start problem this skill is designed to solve.

## Step 4 — Classify

For each observed Bash command:
1. Split on chain operators (`&&`, `;`, `|`) to extract individual commands
2. For each individual command, extract the **base command** — the first token, or first two tokens for `git`/`gh`/`npx`/`pnpm` subcommands (e.g., `git status`, `npx tsup`)
3. Classify each base command into a risk category (see below)
4. Collect all unique base commands across all observed usage

### Base command extraction

The hook uses the same algorithm, so patterns must match:
- Simple commands: first token → `ls`, `cat`, `rm`
- Compound CLI tools: first two tokens → `git status`, `npx tsup`, `pnpm install`, `gh pr`, `xargs grep`
- Transparent wrappers (compound): `env`, `nice`, `timeout`, `watch` — skip flags/positional args, extract delegated command → `timeout 30 rm` → `timeout rm`, `env NODE_ENV=prod node` → `env node`
- `find -exec` / `-execdir`: returns **both** `find` and the delegated command → `find . -exec rm {} \;` → `["find", "rm"]` — both must be allowed
- Shell re-entry: `bash -c` / `sh -c` → base command is `bash`/`sh` (classify as high_destructive)
- **Env var prefixes stripped before extraction.** Any leading `VAR=value` tokens (including quoted/escaped forms) are removed before picking the base command: `FOO=bar git push` → `git push`, `CONVEX_DEPLOYMENT=prod:foo npx convex` → `npx convex`, `DB="$HOME/X" sqlite3 ...` → `sqlite3`. Be strict about this — leaked env-prefixed "base commands" pollute the allowlist and cannot be matched by the hook.
- Redirections stripped: `ls 2>&1` → `ls`
- Skip non-command tokens: lines starting with `#` (comments), `for`, `while`, or bare variable assignments are not classifiable — drop them.

### Risk categories

#### Category: `safe` — Read-only, zero side effects
**Always auto-approved.**

Non-Bash tools: `Read`, `Grep`, `Glob`, `ToolSearch`, `Agent`, `EnterPlanMode`, `ExitPlanMode`, `TaskOutput`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, and any `mcp__plugin_panopticon_*` tool.

Bash base commands:
- **Read-only fs**: `find`, `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `echo`, `diff`, `readlink`, `file`, `which`, `type`, `env`, `printenv`, `basename`, `dirname`, `cd`, `mkdir`, `stat`, `du`, `realpath`
- **Read-only search/text**: `grep`, `rg`, `sort`, `uniq`, `tr`, `cut`, `jq`
- **Read-only system**: `date`, `uname`, `printf`, `true`, `false`, `test`
- **Read-only git**: `git status`, `git diff`, `git log`, `git show`, `git blame`, `git branch`, `git ls-tree`, `git merge-base`, `git fetch`, `git remote`, `git rev-parse`, `git describe`, `git tag`

#### Category: `low_check` — Lint & type-check (read-only analysis)

Base commands: `pnpm type-check`, `pnpm lint`, `npx eslint`, `npx tsc`

#### Category: `medium_build` — Local build artifacts only

Base commands: `npx tsup`, `npx prettier`, `pnpm exec`

#### Category: `medium_deps` — Dependency & formatting changes

Base commands: `pnpm format`, `pnpm install`, `pnpm rebuild`

#### Category: `medium_git_write` — Local git mutations

Base commands: `git add`, `git checkout`, `git stash`, `git commit`, `git rebase`, `git cherry-pick`, `git pull`, `git worktree`, `git merge`

#### Category: `high_git_remote` — Remote git & GitHub operations

Base commands: `git push`, `gh pr`, `gh run`, `gh api`

#### Category: `medium_fs_write` — Non-destructive file operations

Base commands: `cp`, `mv`, `touch`, `rmdir`

Note: `rmdir` only removes empty directories (fails on non-empty). Less risky than `rm`.

Compound commands (`xargs`, `env`, `nice`, `timeout`, `watch`) inherit the delegated command's category. `xargs grep` → safe (grep is safe), `timeout rm` → high_destructive (rm is destructive), `env node` → high_destructive (node is destructive). Classify `{wrapper} {subcmd}` into whatever category `{subcmd}` belongs to.

For `find -exec`/`-execdir`, both `find` (safe) and the delegated command must be allowed. If the delegated command is `rm`, the whole command falls into the highest-risk category of its components (high_destructive).

#### Category: `high_destructive` — Destructive or arbitrary execution

Base commands: `rm`, `pkill`, `kill`, `node`, `python3`, `python`, `sed`, `bash`, `sh`

**Default: deny.** Leave these to auto mode's classifier or explicit prompting.

#### Category: `high_infra` — Infrastructure & deployment

Base commands: `npx convex`, `npx dotenvx`, `docker`, `fly`, `pnpm build`, `pnpm run`, `pnpm dev`, `curl`

**Default: deny.**

#### Category: `web` — Web access

`WebSearch`, `WebFetch`. For WebFetch, extract observed domains and generate domain-restricted patterns.

#### Category: `mcp_external` — Non-panopticon MCP/plugin tools

Any `mcp__plugin_fml_*`, `mcp__claude_ai_*`, `mcp__discjockey__*`, etc. Present per-plugin.

#### Category: `unclassified` — Base commands not in any taxonomy

In practice, real usage always turns up commands the static taxonomy doesn't cover — local CLIs (`panopticon`, `fml`, `claude`), dev tools (`sqlite3`, `npm`, `npx vitest`, `npx biome`, `docker` subcommands, `git -C`, `git reset`), process/system tools (`chmod`, `ps`, `lsof`, `sleep`, `timeout` when observed bare), or project scripts.

Collect every observed base command that doesn't match any category above into `unclassified`. Do **not** silently drop them — silent drops are how allowlists rot.

Present `unclassified` as its own category in Step 6, but with a **4-option question** instead of the usual 3:

- **Approve all** (preview: full list of commands) — bulk-allow when you recognize them
- **Review individually** — kicks off one additional `AskUserQuestion` per command (batched 4 at a time) with Approve/Deny/Skip options. Use this when the list is short or heterogeneous.
- **Deny all** — record as denied so they keep routing through the classifier / prompts
- **Skip**

Recommendation: `Review individually` when the unclassified list has ≤12 entries; `Skip` otherwise (too noisy to triage in one run — surface them but defer).

## Step 5 — Generate Permission Patterns

For each approved category, generate permission patterns based on observed usage.

### Non-Bash tools

Use the tool name directly (e.g., `WebSearch`, `mcp__plugin_panopticon_panopticon__query`). The plugin harness supplies the `mcp__plugin_panopticon_panopticon__` prefix — the MCP tool name itself is bare (`query`, `sessions`, `permissions_apply`, etc.).

### Bash commands

For each unique base command observed in panopticon data that falls within an approved category, generate `Bash({base_command} *)`. The `permissions_apply` tool splits these into the `bash_commands` list in `allowed.json`.

### Only generate for observed commands

Don't generate patterns for commands never seen in panopticon data. The patterns should reflect actual usage, not hypothetical commands. This is the core differentiator from auto mode's classifier, which judges hypotheticals in the moment.

## Step 6 — Interrogate via AskUserQuestion

Print a one-line coverage header first (from Query C):

```
Optimize Permissions — 3,847 calls across 142 sessions, Jan 15 – Apr 8, 2026
```

Then determine what's **pending** — categories with observed usage that are neither in `approved_categories` nor `denied_categories` from Step 1. Skip `safe` (always approved). Skip categories with zero observed commands.

Batch pending categories into groups of **up to 4** and call `AskUserQuestion` once per batch. Each question covers one category, with per-option previews so the user can compare outcomes side-by-side.

### Question shape

```json
{
  "question": "Approve `medium_build`? (9 calls, 8 sessions, last seen 2d ago)",
  "header": "medium_build",
  "multiSelect": false,
  "options": [
    {
      "label": "Approve (Recommended)",
      "description": "Add 3 rules to allowed.json",
      "preview": "+ Bash(npx tsup *)\n+ Bash(npx prettier *)\n+ Bash(pnpm exec *)"
    },
    {
      "label": "Deny",
      "description": "Permanent — won't re-ask next run",
      "preview": "No rules added.\nCategory → denied_categories."
    },
    {
      "label": "Skip",
      "description": "Decide later; re-ask next run",
      "preview": "No change. Stays pending."
    }
  ]
}
```

### Evidence in the question text

Pull from Query E, aggregated to the category level:
- `N calls, M sessions` — raw frequency
- `last seen Xd ago` — recency (compute from `last_seen_ms`)
- Include `N% from last 7d` if `calls_7d > 0` and the share is notable

Keep the question to one line. Put per-command detail in the Approve option's `preview`.

### Preview content

- **Approve preview**: the literal `Bash(...)` rules that would be added, one per line, prefixed with `+`. If >10 rules, show the top 8 by call count and append `+N more`.
- **Deny preview**: a 2-line explanation of what denial means.
- **Skip preview**: a 2-line explanation that nothing changes.

### Recommendation heuristic (which option to mark "Recommended")

Apply first match wins:
1. Category prefix is `high_` → recommend **Deny**. High-risk means "keep the classifier / manual prompt in the loop," regardless of frequency. This covers `high_destructive`, `high_infra`, and `high_git_remote` — remote operations (push, gh api) are *especially* worth keeping behind a gate even when frequent, because the blast radius is external.
2. Any command in category with <3 calls or only 1 session → recommend **Skip**
3. Category in `{low_check, medium_build, medium_git_write, medium_fs_write, web, mcp_external}` with ≥3 calls and ≥2 sessions → recommend **Approve**
4. `medium_deps` → recommend **Approve** only if ≥5 calls across ≥2 sessions, else **Skip**
5. `unclassified` → recommend **Review individually** when ≤12 entries, else **Skip**
6. Fallback → **Skip**

The recommended option must be **first** in the array and have `(Recommended)` in its label.

### Header length constraint

`AskUserQuestion` caps `header` at **12 characters**. Several category names exceed that (`high_git_remote` = 15, `high_destructive` = 16, `medium_git_write` = 16, `medium_fs_write` = 15, `medium_build` = 12 ✓, `medium_deps` = 11 ✓). Use these canonical shortened forms for consistency:

| Category | Header |
| --- | --- |
| `high_destructive` | `destructive` |
| `high_infra` | `infra` |
| `high_git_remote` | `git_remote` |
| `medium_git_write` | `git_write` |
| `medium_fs_write` | `fs_write` |
| `medium_build` | `build` |
| `medium_deps` | `deps` |
| `low_check` | `lint` |
| `web` | `web` |
| `mcp_external` | `mcp` |
| `unclassified` | `unclassif.` |

The full category name still appears in the question text (backticks) so the user sees it; `header` is just the chip label.

### Handling the results

`AskUserQuestion` returns `answers[questionText]` with the chosen label. Map:
- Label starts with `"Approve"` → add category to `approved_categories`
- Label starts with `"Deny"` → add to `denied_categories`
- Label starts with `"Skip"` → leave pending (no state change)
- `"Other"` (user-provided text) → treat as a custom note; record in `custom_overrides` and default to Skip unless the note clearly says approve/deny

### For previously-denied categories

If any `denied_categories` have new observed commands since the last run (compare against the snapshot in `approvals` state), ask **once** at the end of the batch:

```json
{
  "question": "Re-evaluate denied categories? New activity observed.",
  "header": "Re-eval",
  "multiSelect": true,
  "options": [
    { "label": "high_infra (4 new calls)", "description": "Move back to pending" },
    { "label": "medium_deps (12 new calls)", "description": "Move back to pending" }
  ]
}
```

Selected categories move to pending for this run and get their own question in the next batch (or a follow-up call).

## Step 6.5 — Diff Confirmation

Call `permissions_preview` with the exact same payload you'll later send to `permissions_apply`. It returns a structured diff — no files touched:

```json
{
  "diff": {
    "added": ["Bash(npx tsup *)", "WebSearch"],
    "removed": ["Bash(node *)"],
    "unchanged": ["Bash(ls *)", "Read", "..."]
  },
  "proposed": { "allowed": { "...": "..." }, "approvals": { "...": "..." } },
  "paths": { "allowed": "...", "approvals": "..." },
  "codex": {
    "installed": true,
    "rules_path": "/Users/.../.codex/rules/panopticon.rules",
    "proposed_rule_count": 14,
    "diff": {
      "added": ["prefix_rule: npx tsup"],
      "removed": ["prefix_rule: node"],
      "unchanged": ["prefix_rule: ls", "..."]
    }
  }
}
```

Render the `diff` (Claude Code side) as plain text, one rule per line, with `+` / `-` / ` ` prefixes. Truncate to the top 20 lines if longer and append `… +N more`. Put the result in the Apply option's `preview` so the user sees exactly what will happen.

If `codex.installed` is `true`, append a short Codex section after the Claude Code diff so the user knows both targets will be updated:

```
─── Codex rules (~/.codex/rules/panopticon.rules) ───
+ prefix_rule: npx tsup
- prefix_rule: node
```

Skip the Codex section when `codex.installed` is `false`.

If every `added` and `removed` array is empty (both Claude Code and Codex), skip the confirmation entirely and print a one-line "no changes to apply" before exiting.

Otherwise ask one final `AskUserQuestion`:

```json
{
  "question": "Apply these changes to allowed.json?",
  "header": "Apply",
  "multiSelect": false,
  "options": [
    {
      "label": "Apply (Recommended)",
      "description": "Write allowed.json and record a snapshot in config sync",
      "preview": "<formatted diff goes here>"
    },
    {
      "label": "Dry run",
      "description": "Write proposed state to allowed.preview.json; leave enforcement untouched",
      "preview": "Writes <paths.allowed>.preview.json alongside the live file.\nNo change to enforcement."
    },
    {
      "label": "Cancel",
      "description": "Discard all decisions from this run",
      "preview": "No file written.\nPending/denied state also discarded."
    }
  ]
}
```

**Dry run handling** — since `permissions_apply` doesn't take a flag, implement dry run by writing `preview.proposed.allowed` to `<paths.allowed>.preview.json` yourself (use `Write` or `Bash`). Tell the user that path in the final summary.

## Step 7 — Apply

If the user chose **Apply**, call `permissions_apply` with the same payload used in preview:
- `repository` (optional) — org/repo slug, stored on the snapshot
- `approved_categories` — all approved (including previously approved from state)
- `denied_categories` — all denied (including previously denied from state)
- `custom_overrides` — any per-pattern overrides
- `permissions` — the full permission patterns list (Bash and non-Bash mixed — the tool splits them)
- `categories` — full category breakdown (persisted in the snapshot for audit)

The tool returns `{ success, diff, allowed_path, approvals_path, codex, details }`. Writes are atomic per-file (tmp sibling + rename). After writing, the tool records a dedup'd row in `user_config_snapshots` so panopticon's config sync captures the change — prior state is recoverable from that history rather than a local backup file.

Check `codex.error` after apply. If present, the Claude Code allowlist was committed successfully but the Codex rules write failed — surface the error string to the user in Step 8's summary so they know Codex enforcement is out of sync.

## Step 8 — Summary

Print:
```
Optimize Permissions — Complete
═══════════════════════════════
Repository:    org/repo
Data source:   scanner (tool_calls table)
Analyzed:      N tool calls across M sessions
Period:        Jan 15 - Apr 8, 2026

allowed.json (hook enforcement):
  X Bash base commands with chain-aware matching
  Y non-Bash tools with exact name matching
  Estimated hook latency saved: ~22.5s across analyzed sessions

Pairs with auto mode: these rules survive compaction and run before the classifier,
reducing classifier calls and surviving classifier outages.

History:       tracked in user_config_snapshots (panopticon config sync)

Run /optimize-permissions again to update as new patterns appear.
To reset all decisions: rm ~/.local/share/panopticon/permissions/approvals.json
  (this triggers a new snapshot on next session / apply; prior state remains queryable via sync history)
```

Omit the "Estimated hook latency saved" line if no latency data was available (Query D returned 0 rows).
