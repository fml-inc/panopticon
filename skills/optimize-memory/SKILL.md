---
name: optimize-memory
description: "Keep Claude Code memory honest and useful. Fixes drift (stale paths, versions, renames, failed-linked files), verifies behavioral rules against actual usage, consolidates duplicate claims across memory files, and proposes new memory for repeated user corrections that were never captured. One pass across every memory under ~/.claude/projects/."
---

# Optimize Memory

Memory rot is a productivity tax, but drift is only half of it. Three ways memory hurts you silently:

1. **Drift** — A claim that used to be true but isn't anymore: a path that moved, a version that bumped, an identifier that was "renamed" but wasn't really, a behavioral rule that no-one is actually following.
2. **Duplication** — The same claim copied across two or three memory files, each drifting independently. Every redundant copy ships in every ambient prompt.
3. **Missing memory** — The most valuable rules are often the ones you correct Claude about over and over that never get persisted. The drift detector can't see what isn't there.

This skill makes one pass across every memory file under `~/.claude/projects/*/memory/` and does all three checks. Structural drift is cheap (stat/grep). Behavioral rules get an LLM judgment plus an enforcement query against panopticon's command history. Duplicates are surfaced pair-wise. Missing memory is mined from recent user-correction patterns.

## Why this, when memories seem self-maintaining?

The auto-memory system is great at *writing* memory. It has no mechanism to *revisit* it. Once a memory is saved, it is trusted forever — including after the thing it describes is renamed, moved, versioned up, or deleted. And it only ever adds — it never merges, rewrites, or fills gaps.

## Tiers

Two orthogonal axes: **verdict** (is an existing claim still true?) and **action** (what to do about it, beyond edit-in-place).

Verdict:
- **RED** — confirmed stale. Path missing, version mismatch, identifier that was supposedly renamed is still live in the repo, rule demonstrably not being followed. Bulk-approved and removed; prior state is preserved in `user_config_snapshots` via panopticon's config sync.
- **YELLOW** — can't auto-verify. Ambiguous claims, rules with no observable usage pattern, relative dates. Reviewed one at a time.
- **GREEN** — verified current. No action.

Action beyond drift-edits:
- **CONSOLIDATE** — the same claim appears in multiple memory files. Keep one canonical, replace others with a pointer.
- **ADD** — a repeated user correction has no corresponding memory. Propose new memory to capture the pattern.

A single run can produce any mix: fix drift, consolidate duplicates, add missing rules.

---

## Step 1 — Inventory

Run `Glob` on `~/.claude/projects/*/memory/*.md`.

For each file, decode the project directory back to a repo path by replacing `-` with `/` after the leading prefix:
- `-Users-gus-workspace-panopticon` → `/Users/gus/workspace/panopticon`
- `-Users-gus-workspace-fml-inc-fml` → `/Users/gus/workspace/fml-inc/fml`
- `-Users-gus-workspace-fml-inc` → `/Users/gus/workspace/fml-inc`

### Repo-path fallback when the decoded path is dead

The decoded path is where the repo was when Claude Code registered the project — if you moved the repo since, the slug doesn't follow. Before giving up, try to find the live repo:

1. `stat` the decoded path. If the directory is missing OR only contains a stale `.git` shell (no working tree), treat it as moved.
2. Read `.git/config` remote URL from the decoded path if it has one, or derive a likely `org/repo` slug from the tail of the decoded path (e.g., `fml-inc/fml` from `/Users/gus/workspace/fml-inc/fml`).
3. Query panopticon for recent cwds associated with that repository:
   ```sql
   SELECT DISTINCT sc.cwd
   FROM session_repositories sr
   JOIN session_cwds sc ON sr.session_id = sc.session_id
   WHERE sr.repository = :repo
   ORDER BY sc.first_seen_ms DESC
   LIMIT 5
   ```
4. Use the first cwd that actually exists as the verification target. Record both paths in the report so the user sees the drift ("slug says X, live repo is at Y").

If no candidate resolves, record "repo missing" and skip structural checks for this memory (all its claims become YELLOW with justification "repo path unresolved").

Also follow one hop of linked markdown files found inside each memory (`[text](file.md)` syntax) — their drift counts toward the parent memory's report.

## Step 2 — Extract claims

Read each memory file. Parse line-by-line for the following claim types.

| Claim type | Regex (approximate) | What it verifies |
| --- | --- | --- |
| Absolute path | `(?:~|/[A-Za-z])[\w./@+-]+` | File/dir exists |
| Version pin | `\bv?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?\b` preceded by context word ("version", "0.1.2", "@0.2.3") | Matches the referenced `package.json` / `plugin.json` |
| Code-fence command | Triple-backtick blocks tagged `bash`/`sh`/`zsh` or untagged | Passes `bash -n` syntax check |
| Linked file | `\[[^\]]*\]\(([^)]+\.md)\)` | Target file exists in the memory's dir |
| Rename claim | `\b(\w{3,})\s*(?:→|->|renamed to|changed to)\s*(\w{3,})\b` | Old identifier no longer present in repo |
| MCP tool name | Backtick-quoted identifiers matching `[a-z][a-z0-9_]+` in lines mentioning "MCP tool" or "panopticon" | Name matches a current `server.tool()` registration |
| Behavioral rule | Lines starting with "never", "always", "don't", "must", "NEVER", "ALWAYS" | LLM judgment (Step 4) |
| Relative date | `last (quarter|week|month|year)`, `recently`, bare month/year like `March 2026` | Age flag; always YELLOW |

Record each claim as `{ file, line_number, line_text, claim_type, claim_value }`.

## Step 3 — Verify (run in parallel)

For each claim type:

- **Paths**: `Bash` — `test -e "$path" && echo ok || echo missing`. Batch multiple paths in one script.
- **Versions**: find the referenced `package.json` (closest in the mapped repo), read its `version` field, compare. Allow `0.0.0-dev` sentinels to match anything.
- **Commands**: write each fence to a temp file, `bash -n` it. Report syntax errors.
- **Linked files**: `test -e` relative to memory dir.
- **Rename claims**: `Grep` for the OLD identifier in the mapped repo, `type` filtered where known (TS/JS/etc.). If matches > some small threshold (3 hits is plausible residue; 20+ means rename didn't happen), RED. 1-2 hits → YELLOW.
- **MCP tool names**: look up the current panopticon tool registry by grepping the plugin source for `server\.tool\(\s*"([^"]+)"` — or, cheaper, query `panopticon_query` against its own `sqlite_master` is not applicable (no registry table); the authoritative list lives in `<plugin-root>/src/mcp/server.ts`. If the memory's quoted identifier isn't in the current list, RED with suggestion "renamed or removed — see `server.tool()` registrations in the plugin source".

Maximize parallel tool calls — structural checks are independent.

## Step 4 — Behavioral rules: LLM judgment + enforcement check

Two sub-checks per behavioral-rule line. Combine verdicts; the stricter one wins.

### 4a. LLM judgment (does the code still imply this rule?)

1. Grep the mapped repo for the subject of the rule (e.g., rule says "never deploy to prod without asking" → grep for "deploy", "prod", "convex deploy" etc.). Get 5-10 matching lines as context.
2. Ask the LLM inline:
   > Given this memory rule: `<rule>` and these related lines from the current codebase: `<grep excerpt>`, judge whether the rule is still likely to apply. Return one of: STILL_TRUE, PROBABLY_STALE, UNVERIFIABLE. Add a ≤15-word justification.

3. STILL_TRUE → GREEN, PROBABLY_STALE → RED, UNVERIFIABLE → YELLOW.

### 4b. Enforcement check (is the rule actually being followed?)

A rule that Claude or the user routinely violates isn't doing its job. Query panopticon for violations in the last 30 days:

1. From the rule text, extract pattern(s) that would indicate a violation. Examples:
   - "NEVER use `--prod`" → pattern `%--prod%`
   - "don't `pnpm add` in subdirs" → pattern `%pnpm add%` with `cwd` not at workspace root
   - "avoid `rm -rf`" → pattern `%rm -rf%`

2. Run:
   ```sql
   SELECT COUNT(*) as hits, MAX(s.started_at_ms) as last_ms, COUNT(DISTINCT s.session_id) as sessions
   FROM tool_calls tc
   JOIN sessions s ON tc.session_id = s.session_id
   WHERE tc.tool_name = 'Bash'
     AND json_extract(tc.input_json, '$.command') LIKE :pattern
     AND s.started_at_ms > (strftime('%s','now','-30 days')*1000)
   ```

3. Interpret:
   - 0 hits → rule is holding → reinforce 4a's verdict.
   - 1-2 hits → rule mostly holds → YELLOW with note "violated N times in 30d — may be acceptable exceptions".
   - ≥3 hits → rule is regularly violated → RED with note "violated N times across M sessions in 30d — reframe or remove". Propose rewording to match actual behavior or deletion.

Cap the LLM-judged claims at 10 per run to bound token cost. Enforcement SQL is cheap; no cap.

## Step 5 — Cross-memory consolidation (dedup pass)

After per-file analysis, compare memory files to each other to find duplicated content. Saves ambient-prompt tokens (each memory ships in every session) and prevents drift on multiple copies of the same claim.

1. For each pair `(file_a, file_b)` of memory files in the inventory, break both into 2-4 sentence chunks.
2. Use the LLM in batches (10 pairs per call) to flag chunks with high semantic overlap:
   > For each pair, return `OVERLAP` (same claim expressed differently), `DISTINCT` (different claims), or `PARTIAL` (shared topic, different specifics). For OVERLAP, give a one-line summary of the shared claim.
3. For each OVERLAP:
   - **Canonical location** = the memory closest in scope. Heuristic: project-leaf (`fml-inc/fml/`) > project-parent (`fml-inc/`) > user-global. Tie-breaker: more-recently-updated.
   - **Replacement plan**: keep the canonical chunk unchanged; replace the duplicate with a one-line pointer `<!-- consolidated → see [canonical-file](relative-path) -->` or a short reference line, user's choice.

Output records: `{ claim_summary, present_in: [file_a, file_b, ...], canonical: file_x, action: "replace with pointer" }`.

Skip pairs where overlap is trivial (single-word match, common preamble like "## Git Workflow"). Threshold: overlap must be a meaningful claim, not a section header.

## Step 6 — Missing-memory mining (proposed additions)

Turn repeated user corrections into candidate memory entries. The valuable productivity win isn't always fixing drift — sometimes it's capturing what was never remembered.

1. Pull recent corrective user messages:
   ```sql
   SELECT m.content, m.timestamp_ms, s.session_id, sc.cwd
   FROM messages m
   JOIN sessions s ON m.session_id = s.session_id
   LEFT JOIN session_cwds sc ON s.session_id = sc.session_id
   WHERE m.role = 'user'
     AND m.content_length BETWEEN 10 AND 400
     AND s.started_at_ms > (strftime('%s','now','-60 days')*1000)
     AND (
       lower(m.content) LIKE 'no,%'
       OR lower(m.content) LIKE '%don''t %'
       OR lower(m.content) LIKE 'stop %'
       OR lower(m.content) LIKE 'actually %'
       OR lower(m.content) LIKE 'wait %'
       OR lower(m.content) LIKE '%prefer %'
       OR lower(m.content) LIKE '%instead of %'
       OR lower(m.content) LIKE 'use %not %'
     )
   ORDER BY m.timestamp_ms DESC
   LIMIT 200
   ```

2. Cluster corrections by topic using the LLM in one batched call:
   > Group these user-corrective messages into clusters sharing the same underlying rule/preference. For each cluster with ≥3 members, produce: (a) a one-line rule in the user's register, (b) the strongest 2 exemplar quotes, (c) the target memory file (map cwd → project-slug → memory path; user-global if the corrections span multiple projects).

3. For each proposed cluster:
   - Check existing memory for overlap. If the candidate rule is already captured (even in softer form), skip — don't propose duplicates.
   - Tag with type: `preference`, `workflow-rule`, `constraint`, `correction-pattern`.
   - Keep only clusters with ≥3 examples across ≥2 sessions.

Output records: `{ suggested_line, rationale, target_file, example_quotes, correction_count, session_count }`.

Cap at 10 proposed additions per run.

## Step 7 — Classify and report

Per memory file, tally drift: `{ green, yellow, red }`. Globally, tally: `{ consolidations, additions }`.

Print a header summary:
```
Optimize Memory — scanned 3 memory files + 5 linked files (8 total)
  panopticon/MEMORY.md             2 RED   0 YELLOW  14 GREEN
  fml-inc-fml/MEMORY.md            1 RED   3 YELLOW   9 GREEN
  fml-inc/MEMORY.md                0 RED   2 YELLOW   5 GREEN
  linked: project_session_summaries.md   0 RED   1 YELLOW   4 GREEN

Cross-file: 2 consolidations proposed (auth stack, repo list)
Additions:  3 missing rules from user-correction patterns
```

Skip files with no drift *and* no consolidation involvement *and* no proposed additions — they're truly GREEN.

## Step 8 — Approval

`AskUserQuestion` accepts **1–4 questions per call**. Pack the top-level approvals into as few calls as possible so the user decides everything on one screen. Only fan out into follow-up calls when the user opts into per-item review.

### Packing rules for the top-level approvals

Total "items" awaiting approval = (drift files with changes) + (1 if consolidations exist) + (1 if additions exist). Pack into `AskUserQuestion` calls of ≤4 questions each, in this order of priority:

1. One question per **drift file** (truncate header to ≤12 chars).
2. One question for **consolidations**, if any.
3. One question for **additions**, if any.

If the total ≤4, use a single `AskUserQuestion` call. If 5–8, use two calls. Never issue separate calls for single items when they could be combined.

### Example: 4-question batch

```json
{
  "questions": [
    {
      "question": "Fix `panopticon/MEMORY.md`? (2 RED, 0 YELLOW)",
      "header": "panopticon",
      "multiSelect": false,
      "options": [
        { "label": "Apply RED, review YELLOW (Recommended)",
          "description": "2 drift fixes, then review the YELLOW items",
          "preview": "- plugin cache 0.1.2 → use glob\n- panopticon_query → query" },
        { "label": "Apply RED, skip YELLOW", "description": "Only apply confirmed-stale" },
        { "label": "Skip file", "description": "No changes this run" },
        { "label": "Review every claim", "description": "Per-item review (slower)" }
      ]
    },
    {
      "question": "Fix `fml-inc-fml/MEMORY.md`? (1 RED, 3 YELLOW)",
      "header": "fml",
      "multiSelect": false,
      "options": [ /* same shape */ ]
    },
    {
      "question": "Consolidate 2 overlapping claims across memory files?",
      "header": "dedup",
      "multiSelect": false,
      "options": [
        { "label": "Apply all (Recommended)",
          "description": "Keep canonical, replace dups with pointer",
          "preview": "auth stack → keep in fml-inc-fml, pointer in fml-inc\nrepo list → keep in fml-inc, pointer in user-global" },
        { "label": "Review each", "description": "Per-pair decision" },
        { "label": "Skip all", "description": "Leave duplicates in place" }
      ]
    },
    {
      "question": "Add 1 new memory entry from correction patterns?",
      "header": "add",
      "multiSelect": false,
      "options": [
        { "label": "Review each (Recommended)",
          "description": "Approve, edit, or skip each proposed line",
          "preview": "1. Never copy/install local code — 6 corrections, 4 sessions" },
        { "label": "Add all", "description": "Opt-in bulk accept" },
        { "label": "Skip all", "description": "Propose again next run" }
      ]
    }
  ]
}
```

### Follow-up calls for per-item review

These come AFTER the top-level batch, only if the user opted into review on some option.

- **"Review every claim"** (from a drift question) → batch up to 4 claims per follow-up `AskUserQuestion` call, each question: "Keep this memory?" with options Keep / Update / Delete.
- **"Review each"** consolidations → batch up to 4 pairs per call, each: Keep split / Consolidate into canonical / Change canonical.
- **"Review each"** additions → batch up to 4 proposed lines per call, each: Add as proposed / Edit / Skip.

Each follow-up call fills its 4-question budget with items of one review type — don't mix drift-review with addition-review in the same call (different question shapes).

### YELLOW-only files

When a file has no RED but ≥1 YELLOW, skip the drift top-level question for that file and include the YELLOWs in a direct per-item review call instead. Saves a click when there's nothing to bulk-approve.

### Header length

`AskUserQuestion` caps `header` at 12 characters. Truncate memory names: `panopticon/MEMORY.md` → `panopticon`, `fml-inc-fml/MEMORY.md` → `fml`, `fml-inc/MEMORY.md` → `fml-inc`. For dedup/addition use `dedup` and `add`.

### Mapping answers back

After each `AskUserQuestion` call, map `answers[questionText]` to action state:
- `"Apply RED..."` → enqueue file's RED edits
- `"Apply all"` (dedup) → enqueue all consolidations
- `"Add all"` (additions) → enqueue all additions
- Labels starting with `"Review"` → triggers a follow-up call (see above)
- `"Skip"` / `"Skip all"` / `"Skip file"` → no action; don't re-ask until next run

## Step 9 — Apply

All writes go through `Edit` or `Write`. The `PostToolUse` hook auto-captures each change into `user_config_snapshots.memory_files` — no local backup.

### 9a. Drift fixes
Per approved drift, `Edit` with `old_string` = exact line (from Step 2) and `new_string` = `""` for deletion, or the replacement. If a RED row shares a line with a YELLOW kept-as-is claim, do one combined edit.

If an edit would leave a section with only its heading, leave the heading and add `<!-- section emptied <date>; review if still needed -->`. Don't delete whole sections automatically.

### 9b. Consolidations
For each approved consolidation:
1. Leave the canonical file's chunk untouched.
2. In each duplicate, `Edit` the chunk to a pointer: `<!-- See [canonical-file](relative-path) — consolidated YYYY-MM-DD -->`.
3. If the duplicate file becomes empty except for headings after consolidation, flag to the user but don't auto-delete.

### 9c. Additions
For each approved new memory entry:
1. Append to the target file under the most relevant heading. If no fitting section exists, add a `## <Category>` heading (e.g., `## User Preferences`, `## Workflow Rules`).
2. Preserve the file's existing style (bullet vs prose, heading conventions).
3. If the target file doesn't exist yet (rare — would be a new `.md` in a memory dir), `Write` the file with a minimal header.

## Step 10 — Summary

```
Optimize Memory — Complete
══════════════════════════
Files scanned:     3 + 5 linked = 8
Files changed:     4
RED drifts fixed:  3
YELLOW resolved:   4 (2 updated, 1 deleted, 1 kept)
GREEN confirmed:   28
Consolidations:    2 applied (auth stack → fml-inc/fml; repo list → fml-inc)
Additions:         3 new memories (2 preferences, 1 workflow rule)
History:           tracked via panopticon config sync — query for prior state

Re-run after major refactors, version bumps, or when a memory feels like it's lying.
```

### Using snapshot history to sharpen the verdict

Snapshots of every tracked memory file live in `user_config_snapshots.memory_files` (keyed by project slug, then by relative path inside `memory/`). Use this to enrich verdicts:

**Find the oldest snapshot containing a given claim** — tells you how long the claim has gone unchallenged:
```sql
SELECT MIN(snapshot_at_ms) AS first_seen_ms
FROM user_config_snapshots
WHERE json_extract(memory_files, '$.' || :project_slug || '."MEMORY.md"') LIKE '%' || :claim_text || '%'
```

**Find the latest snapshot that LACKED a given claim** — tells you when it was added:
```sql
SELECT MAX(snapshot_at_ms) AS last_absent_ms
FROM user_config_snapshots
WHERE json_extract(memory_files, '$.' || :project_slug || '."MEMORY.md"') NOT LIKE '%' || :claim_text || '%'
```

Use the two together to narrow the "claim added" window to a specific session.

Verdict adjustments:
- Claim added in the **last 7 days** → bump YELLOW → GREEN (too fresh to be stale).
- Claim present for **60+ days without re-save** → bump GREEN → YELLOW (stale by age, worth re-checking).
- Claim was added, then referenced file was deleted (git log check) → firmly RED.

Snapshots were introduced in migration #4; if the table has no rows yet (fresh install), fall back to pure-heuristic mode. Check with:
```sql
SELECT COUNT(*) FROM user_config_snapshots WHERE memory_files != '{}'
```
Zero → heuristic only. Non-zero → use the enrichment queries.

## Edge cases

- **Paths outside `/Users/gus/`**: skip verification — likely system paths like `/opt/homebrew/...` that may not exist on another machine but shouldn't be flagged.
- **Claims with uncertainty markers** ("probably", "I think", "TBD"): always YELLOW, low-priority.
- **`MEMORY.md` index entries** (lines of the form `- [Title](file.md) — hook`): if the linked file exists and is non-empty, GREEN. These are the Claude-managed index.
- **Empty linked files**: YELLOW, justification "linked file exists but is empty — probably stub".
- **Multiple versions in one memory**: verify each independently; the claim-extractor returns a list per line.
- **Symlinks**: follow them (`test -e` does, which is right).
- **Consolidation ambiguity**: if two files have equally strong claim for canonical status, surface the pair and ask the user rather than guessing.
- **Proposed additions that conflict with existing denials**: if the user previously said "don't add memory about X" (captured via a correction pattern in earlier runs or explicit feedback memory), suppress the suggestion. Track suppression in a `~/.claude/projects/*/memory/.optimize-memory-denylist` file if needed.
- **Enforcement-check false positives**: a rule like "NEVER use `rm -rf`" will match legitimate scratch-dir cleanups. When the grep context makes violations look defensible (tmp paths, test setup), downgrade RED to YELLOW with a note.

## What NOT to do

- Don't `HEAD`-probe URLs — network calls are slow, often blocked, and outside the productivity scope.
- Don't delete a whole memory file even if 100% RED — the user's note may deserve a rewrite, not removal.
- Don't rewrite content the LLM judged YELLOW — only remove or replace, never paraphrase silently.
- Don't recurse into linked files beyond one hop. Deep link trees are out of scope.
- Don't auto-add additions. Every missing-memory proposal must be explicitly approved by the user; the skill *never* adds memory without a review prompt (even with "Add all", the user has opted in for the batch).
- Don't commit. This skill edits files only; any git operation is the user's call.
