---
name: panopticon-optimize
description: "Analyze tool usage from panopticon, categorize by risk level, and generate optimized permission rules. Remembers approved categories across runs."
---

# Panopticon Optimize

Analyze all tool usage captured by panopticon for the current repository, categorize each pattern by risk level, auto-allow safe patterns, and prompt for approval of higher-risk categories. Category approvals persist across runs.

## Architecture

Bash permissions use **hook-based chain-aware enforcement** rather than `settings.local.json` wildcards. Claude Code's `Bash(ls *)` wildcards match across chain operators (`&&`, `;`, `|`), so `Bash(ls *)` would auto-approve `ls /tmp && rm -rf /`. Instead:

- **Bash commands** → `allowed_commands.json` read by panopticon's `PreToolUse` hook, which splits chains and checks each component independently
- **Non-Bash tools** (MCP, etc.) → `settings.local.json` as normal (no chain problem)

The hook returns `"permissionDecision": "allow"` only when ALL chain components match approved base commands. Unmatched commands fall through to Claude Code's normal prompting.

## MCP Tools

- **`panopticon_optimize_state`** — Load existing approvals + current project permissions. Call this first.
- **`panopticon_optimize_apply`** — Write permissions (splitting Bash → hook, non-Bash → settings), save approvals, and create backup. Call this at the end.

All analysis and querying uses the standard `panopticon_query` tool.

---

## Step 1 — Load State

Call `panopticon_optimize_state` with the current project path. It returns:
- `approvals` — previously approved/denied categories and custom overrides
- `current_permissions` — existing `permissions.allow` entries in the project
- File paths for reference

`"safe"` is always pre-approved and cannot be removed.

## Step 2 — Identify Current Repository

Run `git remote get-url origin` and extract `org/repo` (strip `.git` suffix and host prefix). Used for backup metadata only — **not** for scoping queries, since the whitelist is global.

## Step 3 — Query Panopticon

The allowed_commands.json and settings permissions are global (not per-repo), so queries must aggregate across **all** repositories.

Run via `panopticon_query`:

**Query A — Non-Bash tools:**
```sql
SELECT tool_name, COUNT(*) as cnt
FROM hook_events
WHERE event_type = 'PreToolUse'
  AND tool_name != 'Bash'
GROUP BY tool_name ORDER BY cnt DESC
```

**Query B — All Bash commands (full command strings):**
```sql
SELECT
  json_extract(json_extract(decompress(payload), '$.tool_input'), '$.command') as cmd,
  COUNT(*) as cnt
FROM hook_events
WHERE event_type = 'PreToolUse' AND tool_name = 'Bash'
GROUP BY cmd ORDER BY cnt DESC
LIMIT 500
```

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
- Env var prefixes stripped: `FOO=bar git push` → `git push`
- Redirections stripped: `ls 2>&1` → `ls`

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

**Default: deny.**

#### Category: `high_infra` — Infrastructure & deployment

Base commands: `npx convex`, `npx dotenvx`, `docker`, `fly`, `pnpm build`, `pnpm run`, `pnpm dev`, `curl`

**Default: deny.**

#### Category: `web` — Web access

`WebSearch`, `WebFetch`. For WebFetch, extract observed domains and generate domain-restricted patterns.

#### Category: `mcp_external` — Non-panopticon MCP/plugin tools

Any `mcp__plugin_fml_*`, `mcp__claude_ai_*`, `mcp__discjockey__*`, etc. Present per-plugin.

## Step 5 — Generate Permission Patterns

For each approved category, generate permission patterns based on observed usage.

### Non-Bash tools

Use the tool name directly (e.g., `mcp__plugin_panopticon_panopticon__panopticon_query`).

### Bash commands

For each unique base command observed in panopticon data that falls within an approved category, generate `Bash({base_command} *)`. The `panopticon_optimize_apply` tool will automatically route these to the hook enforcement file (`allowed_commands.json`) instead of `settings.local.json`.

### Only generate for observed commands

Don't generate patterns for commands never seen in panopticon data. The patterns should reflect actual usage, not hypothetical commands.

## Step 6 — Present to User

**Summary table first:**

```
Category            Risk       Patterns  Calls   Status
──────────────────────────────────────────────────────────
safe                none       14        1,247   always approved
low_check           low        4         50      previously approved
medium_build        medium     3         9       ? pending
medium_deps         medium     3         15      x previously denied
```

**Then for each pending category**, show:
1. Category name, risk level, one-line description
2. Observed base commands and call counts
3. Permission patterns that would be generated
4. Ask: **"Approve `{category}`? (y = approve / n = deny / s = skip)"**

- **y**: Add to `approved_categories`
- **n**: Add to `denied_categories` (won't ask again)
- **s**: Skip (will ask next run)

For `denied_categories`, show as denied with option to re-evaluate.

## Step 7 — Apply

Call `panopticon_optimize_apply` with:
- `project_path` — current project root
- `repository` (optional) — org/repo slug, included in backup metadata
- `approved_categories` — all approved (including previously approved from state)
- `denied_categories` — all denied (including previously denied from state)
- `custom_overrides` — any per-pattern overrides
- `permissions` — the full permission patterns list (Bash and non-Bash mixed — the tool splits them)
- `categories` — full category breakdown (for backup)

The tool handles atomically:
1. Writing `settings.local.json` with non-Bash patterns (managed section markers)
2. Writing `allowed_commands.json` with Bash base commands (for hook enforcement)
3. Saving approvals state
4. Creating timestamped backup

## Step 8 — Summary

Print:
```
Panopticon Optimize — Complete
═══════════════════════════════
Repository:    org/repo
Analyzed:      N tool calls across M sessions

settings.local.json:
  X non-Bash patterns (MCP tools, etc.)

allowed_commands.json (hook enforcement):
  Y Bash base commands with chain-aware matching

Backup saved to ~/.local/share/panopticon/permissions/backups/...

Run /panopticon-optimize again to update as new patterns appear.
To reset all decisions: rm ~/.local/share/panopticon/permissions/approvals.json
```
