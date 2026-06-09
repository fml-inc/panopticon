# Panopticon Target Parity Plan

Objective: audit and improve feature parity across the three primary Panopticon targets: **Claude Code**, **Codex**, and **Pi**. Each parity area should be handled in a separate PR so changes remain reviewable and independently testable.

## PR 1 — Add explicit target capability matrix

Create a code-level and docs-level capability contract for each target.

Capabilities to track:

- hooks
- scanner
- OTel
- proxy
- permissions
- skills
- config snapshot
- session lifecycle
- tool lifecycle
- token accounting
- subagents/tasks
- fork/continuation detection

Deliverables:

- Add explicit capability metadata or tests.
- Make intentional target gaps visible.
- Prevent future parity regressions.

## PR 2 — Hook lifecycle parity

Compare and normalize live hook coverage across Claude Code, Codex, and Pi.

Focus events:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `Stop`
- `SessionEnd`
- `TurnStart`
- `PreCompact`
- `PostCompact`
- `ConfigChange`
- `Notification`
- subagent/task lifecycle events

Known gaps:

- Codex lacks some lifecycle hooks such as `SessionEnd` and `PostToolUseFailure`.
- Pi supports several lifecycle hooks through its extension, but only where Pi exposes events.
- Claude has broad plugin coverage but is represented differently because hooks are marketplace/plugin-driven.

Files:

- `src/targets/claude.ts`
- `src/targets/codex.ts`
- `src/targets/pi.ts`
- `src/targets/pi/extension.ts`
- `src/hooks/ingest.ts`

## PR 3 — Permission behavior parity

Audit and clarify permission behavior.

Current state:

| Target | Permission behavior |
| --- | --- |
| Claude | Can allow/deny via `PreToolUse` |
| Codex | Deny at `PreToolUse`; allow/deny via `PermissionRequest` |
| Pi | Informational only; cannot block tool calls |

Deliverables:

- Add tests documenting each target's permission semantics.
- Mark Pi permission enforcement as unsupported unless Pi extension APIs allow real blocking.
- Ensure docs do not imply Pi can enforce decisions.

Files:

- `src/targets/claude.ts`
- `src/targets/codex.ts`
- `src/targets/pi.ts`
- `src/targets/targets.test.ts`

## PR 4 — Scanner parity

Audit persisted session scanner behavior.

Feature areas:

- session discovery
- user messages
- assistant messages
- tool calls
- tool results
- thinking/reasoning
- token usage
- subagents
- forks/continuations
- file snapshots/errors/progress

Known gaps:

- Claude scanner is richest, including DAG/fork/subagent handling.
- Codex scanner captures many events but has less fork/subagent structure.
- Pi scanner captures persisted messages/tool calls/tokens when Pi exposes them, but lacks Claude-style fork/subagent richness.

Files:

- `src/targets/claude.ts`
- `src/targets/codex.ts`
- `src/targets/pi.ts`
- `src/targets/*scanner*.test.ts`

## PR 5 — OTel and proxy parity

Codify or improve telemetry/proxy support.

Current state:

| Target | OTel | Proxy |
| --- | --- | --- |
| Claude | Yes | Anthropic proxy |
| Codex | Yes | OpenAI/ChatGPT proxy |
| Pi | No | No |

Deliverables:

- Decide whether Pi's lack of OTel/proxy is permanent or future work.
- Add explicit capability metadata/tests.
- Update README/docs so Pi limitations are clear.

Files:

- `src/targets/types.ts`
- `src/targets/claude.ts`
- `src/targets/codex.ts`
- `src/targets/pi.ts`
- `README.md`
- `docs/PI-COVERAGE.md`

## PR 6 — Config snapshot parity

Audit target config snapshot depth.

Current state:

| Area | Claude | Codex | Pi |
| --- | --- | --- | --- |
| settings | yes | yes | yes |
| MCP servers | yes | yes | no/empty |
| permissions/rules | yes | yes | partial |
| instructions | `CLAUDE.md` | `AGENTS.md` | no |
| skills | yes | yes | yes |
| extensions/plugins | yes | hooks/plugin | yes |

Deliverables:

- Decide which Pi config areas are truly unsupported vs missing.
- Add tests for expected config snapshots.
- Ensure empty Pi fields are intentional and documented.

Files:

- `src/targets/claude/config.ts`
- `src/targets/codex/config.ts`
- `src/targets/pi/config.ts`

## PR 7 — Diagnostics/reporting parity

Fix reporting so supported targets appear correctly.

Known issue:

- `src/context-diagnostics.ts` filters hook targets by `target.hooks.events.length > 0`.
- Claude has `hooks.events: []` because hook registration is plugin-marketplace based.
- Result: Claude may be omitted from hook diagnostics despite supporting hooks.

Deliverables:

- Add a better hook-capability signal than `hooks.events.length`.
- Ensure Claude, Codex, and Pi all show accurate installed/configured status.
- Add regression tests.

Files:

- `src/context-diagnostics.ts`
- `src/targets/types.ts`
- `src/targets/claude.ts`
- tests for diagnostics output

## Recommended order

1. PR 1 — capability matrix
2. PR 7 — diagnostics parity
3. PR 2 — hook lifecycle parity
4. PR 3 — permission parity
5. PR 4 — scanner parity
6. PR 6 — config snapshot parity
7. PR 5 — OTel/proxy parity docs or implementation

This order establishes the parity contract first, then fixes user-visible reporting, then handles individual implementation surfaces.
