# Claude Agent SDK + Panopticon

Use Panopticon's `observe()` wrapper to capture telemetry from Claude Agent SDK sessions. The wrapper is transparent — you use the SDK normally, and panopticon records everything (prompts, tool calls, token usage, cost, latency) in the background.

## Prerequisites

- Panopticon installed and server running (`panopticon install && panopticon start`)
- Claude Code logged in (`claude auth status`) — this example uses Claude Code's OAuth session, no `ANTHROPIC_API_KEY` needed

## Setup

```bash
cd examples/claude-agent-sdk
npm install
```

## Usage

```bash
node index.js "What files are in the current directory?"
```

The script sends a prompt to the Claude Agent SDK, streams the response, and prints a summary (turns, cost, tokens, latency). Panopticon captures the full session in the background.

## How it works

```javascript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { observe } from "@fml-inc/panopticon/sdk";

for await (const msg of observe(query({ prompt: "..." }))) {
  // use msg normally — panopticon captures everything
}
```

`observe()` wraps any async iterable from the Claude Agent SDK. It intercepts messages and emits them to the panopticon server as OTel signals and hook events. The wrapper adds no latency — events are sent asynchronously.

## What gets captured

| Data | Where |
|------|-------|
| User prompts | `hook_events` (UserPromptSubmit) |
| Tool calls + results | `hook_events` (PreToolUse, PostToolUse) |
| API requests | `otel_logs` (model, tokens, cost, latency) |
| Token usage | `otel_metrics` (input/output by model) |
| Session lifecycle | `hook_events` (SessionStart, SessionEnd) |

## Verify

After running the example, check that data was captured:

```bash
panopticon sessions --limit 1
panopticon costs --group-by session
```
