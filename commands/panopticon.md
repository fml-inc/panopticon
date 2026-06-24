Deprecated compatibility command. Prefer `/fml` for new workflows.

Use the Panopticon command router for these arguments:

```
$ARGUMENTS
```

Route the request through the `panopticon` skill (its `SKILL.md`). If the first argument is `review`, read the skill's `references/review.md` and follow that PR review workflow. The skill is installed alongside this command in the harness skills directory (e.g. `~/.claude/skills/panopticon/` for Claude, `~/.pi/agent/skills/panopticon/` for Pi).

Do not use the legacy `panopticon-review` or `pr-review` command/skill names; they have been migrated to `/panopticon review`.
