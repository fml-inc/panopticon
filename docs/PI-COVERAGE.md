# Pi coverage matrix and verification

Panopticon supports Pi through the installed Pi extension plus the Pi session
scanner. The table below reflects the behavior implemented for Pi 0.75.3 and
should be read together with the evidence in
[Pi session capability findings](PI-SESSION-CAPABILITY-FINDINGS.md).

## Coverage matrix

| Area | Coverage | Source | Expected Panopticon data | Notes / limitations |
| --- | --- | --- | --- | --- |
| Live hooks | Supported | Panopticon Pi extension HTTP events | `sessions.target = 'pi'`, `hook_events.target = 'pi'`, prompt/session metadata, tool hook payloads, touched file paths | Requires `panopticon install --target pi` and the Panopticon server to be reachable. Extension HTTP uses Panopticon auth token handling; do not copy tokens into logs. |
| Normalized user messages | Supported | Live `input`/message events and Pi JSONL scanner | `messages.role = 'user'` with stable ordering | Existing raw hook rows from earlier development builds are not migrated; use scanner coverage for persisted sessions. |
| Real assistant responses | Supported when Pi emits/persists them | Live `turn_end` extension events and Pi session JSONL `message.role === "assistant"` | `messages.role = 'assistant'` containing the actual assistant text/thinking content available from Pi | Panopticon does not fabricate missing assistant text. Synthetic tool-use summaries remain explicit hook-derived records, not replacements for real responses. If future Pi releases require `message_end`/`agent_end` for additional live coverage, Panopticon should add those subscriptions explicitly. |
| Turn/stop boundaries | Supported for exposed live events | Pi `turn_start`/`turn_end` extension events | Canonical stop/turn hook events plus chronological message state; scanner infers order from persisted messages | Pi JSONL does not persist explicit `turnIndex` entries, so exact live turn indexes are available only when captured live. |
| Tool calls | Supported | Live tool events, assistant `toolCall` content, and Pi JSONL tool/result messages | `tool_calls` rows linked to Pi sessions, with `message_id`/`tool_use_id` where available and normalized tool category/file path metadata | Tool rows are derived only from actual Pi hook/session data. |
| Token usage and costs | Supported when Pi/provider provides usage | Assistant `message.usage` in live events or Pi JSONL | `messages.token_usage`, per-message `context_tokens`/`output_tokens`, session token totals (`total_input_tokens`, `total_output_tokens`, cache/reasoning where present) | Missing usage means unknown/unavailable for that response, not a real zero. Cost queries include Pi only when model/pricing and token fields are populated. |
| Scanner | Supported | Pi JSONL files under `~/.pi/agent/sessions/...` | `sessions.has_scanner = 1` for scanner-backed Pi sessions; normalized `messages`, `tool_calls`, and token totals | Scanner is idempotent over session logs. |
| Headless `pi -p` | Supported with flush guard; gated smoke test | Pi extension tracks pending HTTP POSTs and awaits them during `session_shutdown` | Headless runs should record a Pi session, prompt, hooks, file paths, messages, and tool calls when Pi, credentials, build artifacts, and Panopticon server are available | Smoke coverage is opt-in because it depends on a real Pi binary/runtime and credentials. Use `PANOPTICON_PI_HEADLESS_SMOKE=1`. |
| Additional parity events | Partially supported | Exposed Pi events only | Canonical events for `turn_end`/Stop, compaction, model/thinking config changes, and interactive `user_bash` notifications | Pi 0.75.3 does not expose Claude-style permission prompt lifecycle, subagent/task lifecycle, or generic system notifications. Panopticon leaves those absent rather than faking them. |
| OTel / API proxy | Not supported for Pi | N/A | No Pi-native `otel_*` rows and no Pi proxy routing | Pi uses its own provider configuration; Panopticon observes Pi through extension/session sources. |

## Commands to exercise Pi coverage

Install or refresh Pi support after building Panopticon:

```sh
pnpm build
panopticon install --target pi
panopticon start
```

Run focused automated checks:

```sh
pnpm test -- src/targets/pi/extension.test.ts src/targets/pi-scanner.test.ts
```

Run the real headless smoke only on a machine where `pi -p` works and Pi has
usable credentials:

```sh
pnpm build
PANOPTICON_PI_HEADLESS_SMOKE=1 pnpm test -- src/targets/pi-headless-smoke.test.ts
```

In CI, the smoke remains skipped unless both `PANOPTICON_PI_HEADLESS_SMOKE=1`
and `PANOPTICON_PI_HEADLESS_SMOKE_CI=1` are set.

## Verification queries

The examples below can be run through `panopticon query`/MCP SQL tooling or any
read-only SQLite client pointed at the Panopticon database. Replace
`:session_id` with a Pi session id from the first query.

### 1. Recent Pi sessions and source coverage

```sql
SELECT
  session_id,
  datetime(started_at_ms / 1000, 'unixepoch') AS started_at,
  first_prompt,
  has_hooks,
  has_scanner,
  message_count,
  user_message_count,
  (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id = sessions.session_id) AS tool_call_count,
  total_input_tokens,
  total_output_tokens,
  total_cache_read_tokens,
  total_cache_creation_tokens,
  total_reasoning_tokens
FROM sessions
WHERE target = 'pi'
ORDER BY started_at_ms DESC
LIMIT 10;
```

Expected outcome: live extension sessions have `has_hooks = 1`; scanner-backed
sessions have `has_scanner = 1`; message/tool counts reflect normalized rows.
Token totals are populated only when Pi/provider usage data was present.

### 2. Raw hooks versus normalized records

```sql
SELECT
  s.session_id,
  COUNT(DISTINCT he.id) AS hook_events,
  COUNT(DISTINCT m.id) AS messages,
  COUNT(DISTINCT tc.id) AS tool_calls
FROM sessions s
LEFT JOIN hook_events he
  ON he.session_id = s.session_id AND he.target = 'pi'
LEFT JOIN messages m
  ON m.session_id = s.session_id
LEFT JOIN tool_calls tc
  ON tc.session_id = s.session_id
WHERE s.target = 'pi'
GROUP BY s.session_id
ORDER BY MAX(s.started_at_ms) DESC
LIMIT 20;
```

Expected outcome: new Pi sessions should have corresponding normalized
message/tool rows from live ingest or scanner coverage. A zero normalized count
usually means the session only has unsupported/malformed hook payloads or was
captured by an earlier development build before Pi normalization existed.

### 3. Chronological Pi transcript check

```sql
SELECT
  ordinal,
  role,
  substr(content, 1, 160) AS content_preview,
  token_usage,
  context_tokens,
  output_tokens
FROM messages
WHERE session_id = :session_id
ORDER BY ordinal, timestamp_ms, id;
```

Expected outcome: user prompts, real assistant responses, tool-result messages,
and explicit synthetic tool-use summaries appear in deterministic chronological
order. Assistant content should be real Pi output when Pi exposed it; if Pi did
not expose text for a record, Panopticon should not invent one.

### 4. Pi tool calls and file paths

```sql
SELECT
  tool_name,
  category,
  tool_use_id,
  message_id,
  json_extract(input_json, '$.file_path') AS file_path,
  json_extract(input_json, '$.path') AS path,
  substr(input_json, 1, 200) AS input_preview
FROM tool_calls
WHERE session_id = :session_id
ORDER BY message_id, call_index, id;
```

Expected outcome: tool calls from Pi hooks/session logs are present once
normalized, file-writing/editing tools include extracted `file_path` when the
Pi payload contains one, and linked ids are stable.

### 5. Token availability semantics

```sql
SELECT
  COUNT(*) AS assistant_messages,
  SUM(CASE WHEN token_usage IS NOT NULL AND token_usage <> '' THEN 1 ELSE 0 END)
    AS assistant_messages_with_usage,
  SUM(COALESCE(context_tokens, 0)) AS context_tokens,
  SUM(COALESCE(output_tokens, 0)) AS output_tokens
FROM messages
WHERE session_id = :session_id
  AND role = 'assistant';
```

Expected outcome: `assistant_messages_with_usage` may be lower than
`assistant_messages` when Pi/provider omitted usage. Treat absence as unknown,
not as proof the response consumed zero tokens.

### 6. Unsupported parity events should be absent

```sql
SELECT event_type, COUNT(*) AS events
FROM hook_events
WHERE target = 'pi'
  AND event_type IN (
    'PermissionRequest',
    'PermissionDenied',
    'SubagentStart',
    'SubagentStop',
    'TaskCreated',
    'TaskCompleted'
  )
GROUP BY event_type;
```

Expected outcome: no rows for Pi 0.75.3 unless a future Pi release exposes a
real source and Panopticon adds explicit support. Absence is intentional.

### 7. Sync ID sanity

```sql
SELECT sync_id, COUNT(*) AS duplicates
FROM (
  SELECT m.sync_id
  FROM messages m
  JOIN sessions s ON s.session_id = m.session_id
  WHERE s.target = 'pi' AND m.sync_id IS NOT NULL
  UNION ALL
  SELECT tc.sync_id
  FROM tool_calls tc
  JOIN sessions s ON s.session_id = tc.session_id
  WHERE s.target = 'pi' AND tc.sync_id IS NOT NULL
)
GROUP BY sync_id
HAVING COUNT(*) > 1;
```

Expected outcome: no duplicate `sync_id` rows.

## Known limitations

- Pi does not currently provide Panopticon with native OTel or proxy traffic.
- Pi 0.75.3 does not expose Claude-equivalent permission prompt lifecycle,
  subagent/task lifecycle, or generic system notification events.
- Exact live `turnIndex` values are available only from live extension events;
  historical JSONL scanning preserves chronological message order but not the
  original live turn index.
- Token, cost, and thinking data are provider-dependent. Panopticon records
  them when Pi exposes them and otherwise leaves them absent.
- Headless smoke tests are intentionally opt-in because they require a real Pi
  runtime, credentials, and a built extension bundle.
