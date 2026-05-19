# Pi session capability findings

Research target: installed `@earendil-works/pi-coding-agent` package, version `0.75.3` (`pi --version` also reports `0.75.3`). This document records what Panopticon can rely on for downstream Pi data-gap work.

## Evidence inspected

- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts`

## Findings matrix

| Capability | Exposed to extensions? | Persisted locally? | Downstream implication |
| --- | --- | --- | --- |
| User prompts | Yes: `input`, `before_agent_start`, `message_start`, `message_end`, and session manager entries expose user messages. | Yes: session JSONL `message` entries with `message.role === "user"`. | Panopticon may capture prompt text from extension events or scan session JSONL. |
| Assistant final output | Yes: `message_end` includes final `AgentMessage`; `turn_end.message` and `agent_end.messages` include assistant messages. | Yes: session JSONL `message` entries with `message.role === "assistant"`. | Real assistant messages are available; do not rely only on synthetic tool-use messages. |
| Assistant streaming deltas | Yes: `message_update` includes an `AssistantMessageEvent` with `text_delta`, `thinking_delta`, and `toolcall_delta` variants plus partial message. | Final message is persisted; per-token deltas are not represented as separate session entries. | Live extension capture can observe deltas, but scanner normalization should use finalized session messages. |
| Thinking/reasoning content | Yes when the provider emits it: assistant content supports `ThinkingContent`; `message_update` has `thinking_*` events; `thinking_level_select` exposes selected level. | Yes when present in final assistant message content; thinking-level changes are separate `thinking_level_change` entries. | Capture only actual `content[].type === "thinking"`; absence means unavailable for that response, not zero/empty reasoning. |
| Token usage / cost | Yes through assistant messages: `AssistantMessage.usage` has input/output/cache/cost totals. Extension context also exposes estimated current context usage via `ctx.getContextUsage()`. | Yes in assistant message entries as `message.usage`; compaction entries store `tokensBefore`. | Prefer persisted assistant `usage` for per-response totals; context usage is an estimate/status value, not a replacement for response usage. |
| Turn boundaries | Yes: `turn_start` has `turnIndex` and timestamp; `turn_end` has `turnIndex`, final `message`, and `toolResults`. | Not as explicit top-level turn entries. Boundaries can be inferred from message order/tool calls in JSONL, but the `turnIndex` itself is live-event-only. | Live extension can record exact turn boundaries. Scanner/backfill should infer boundaries conservatively from session sequence unless Panopticon recorded live `turn_*` events. |
| Tool calls/results | Yes: `tool_call`, `tool_result`, `tool_execution_*`, `message_update` tool-call deltas, and assistant `toolCall` content blocks. | Yes: assistant `content[].type === "toolCall"` and `toolResult` messages are persisted. | Existing hook-derived tool capture can be augmented from session logs if needed. |
| Durable local session logs | N/A. Extension context exposes read-only `ctx.sessionManager` including `getSessionFile()`, `getEntries()`, `getBranch()`, `getTree()`, and `getHeader()`. | Yes: documented JSONL files under `~/.pi/agent/sessions/--<cwd-with-slashes-replaced-by-dashes>--/<timestamp>_<uuid>.jsonl`. | A Pi scanner adapter is feasible against session JSONL files. |
| Extension private state | Yes: `pi.appendEntry(customType, data)` for custom entries; commands can send custom/user messages. | Yes: `custom` entries persist extension state; `custom_message` entries persist extension-injected context messages. | Panopticon extension may store its own capture metadata, but should not use custom entries to fabricate assistant/tokens. |

## Session file details to rely on

Pi sessions are JSONL. The header is a `session` object with `version`, `id`, `timestamp`, and `cwd`. Conversation entries are append-only tree nodes with `id`, `parentId`, and ISO `timestamp`.

Relevant persisted entry shapes from `session-format.md` and `session-manager.d.ts`:

- `type: "message"` with `message: AgentMessage` for user, assistant, toolResult, bashExecution, custom, branchSummary, and compactionSummary messages.
- `type: "model_change"` with provider/model.
- `type: "thinking_level_change"` with selected thinking level.
- `type: "compaction"` with summary, `firstKeptEntryId`, and `tokensBefore`.
- `type: "branch_summary"`, `custom`, `custom_message`, `label`, and `session_info` entries.

Assistant messages contain `content` blocks (`text`, `thinking`, `toolCall`), provider/model/api metadata, `usage`, `stopReason`, optional response identifiers/diagnostics, and a millisecond timestamp.

## Unsupported or cautionary notes

- Per-token streaming deltas are extension events, not durable log entries. Historical scanner code should not claim delta-level replay from session JSONL.
- Exact `turnIndex` values are live extension event data. Session JSONL persists messages and tool calls, but not explicit `turn_start`/`turn_end` entries.
- Thinking content and token usage are provider-dependent at the assistant-message level. Missing fields/content should be treated as unavailable for that response, not fabricated.
- `after_provider_response` exposes status and headers only, before the stream is consumed; it is not a transcript source.
- Extension `appendEntry` is for extension state. It can support Panopticon bookkeeping, but should not be used as evidence for model output unless paired with actual Pi events/session messages.
