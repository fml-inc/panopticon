# Plan: Sync Scanner Data + Sessions Upstream

## Context

Panopticon collects data locally from three sources (hooks, OTLP, scanner) and syncs hook_events, otel_logs, and otel_metrics upstream via OTLP. Scanner data (turns, events) and the aggregated sessions table don't sync yet. We need them upstream for dashboards, multi-machine use, and eventual mesh deployments.

## Part 1: Sync scanner_turns as OTLP metrics

**File: `src/sync/reader.ts`** — add `readScannerTurns(afterId, limit)`
**File: `src/sync/serialize.ts`** — add `serializeScannerTurns()`
- Metric name: `scanner.token.usage`
- One gauge data point per non-zero token type per turn
- Attributes: `source=scanner`, `scanner.source=claude|codex|gemini`, `type`, `model`, `role`, `turn_index`
- Posted to `/v1/metrics`

**File: `src/sync/loop.ts`** — add `syncScannerTurns(target)` in `runOnce()`

## Part 2: Sync scanner_events as OTLP logs

**File: `src/sync/reader.ts`** — add `readScannerEvents(afterId, limit)`
**File: `src/sync/serialize.ts`** — add `serializeScannerEvents()`
- Body: event_type (e.g., `scanner.tool_call`, `scanner.error`, `scanner.reasoning`)
- Attributes: `source=scanner`, `scanner.source`, `tool_name`, `tool_input`, `tool_output`, `content`
- Posted to `/v1/logs`

**File: `src/sync/loop.ts`** — add `syncScannerEvents(target)` in `runOnce()`

## Part 3: Sync sessions table

**File: `src/db/schema.ts`** — add `sync_dirty INTEGER DEFAULT 1` to sessions (migration v8)
**File: `src/db/store.ts`** — set `sync_dirty = 1` in every `upsertSession()` call

**File: `src/sync/reader.ts`** — add `readDirtySessions(limit)`
```sql
SELECT * FROM sessions WHERE sync_dirty = 1 LIMIT ?
```

**File: `src/sync/serialize.ts`** — add `serializeSessions()`
- Body: `session.summary`
- Attributes: all session fields (target, models, timing, token totals from both sources, completeness flags, cwd, first_prompt, etc.)
- Posted to `/v1/logs`

**File: `src/sync/loop.ts`** — add `syncSessions(target)` in `runOnce()`
- After successful POST, clear `sync_dirty = 0` for those session_ids

**Hub-side: `src/otlp/server.ts`** — detect `body="session.summary"` in incoming OTLP logs and route to `upsertSession()` instead of `insertOtelLogs()`. This lets a receiving panopticon instance build its sessions table from upstream data.

## Part 4: Add `source` attribute to existing sync streams

**File: `src/sync/serialize.ts`**
- `serializeHookEvents`: add `kv("source", "hook")` to each log record's attributes
- `serializeOtelLogs`: add `kv("source", "otel")` to each log record's attributes
- `serializeMetrics`: add `kv("source", "otel")` to each data point's attributes

## Part 5: Debounce sync catchup

**File: `src/sync/loop.ts`**

Currently the sync loop fires every 1s when data is found (`DEFAULT_CATCHUP_MS = 1_000`). At high throughput this means many small POSTs. Add a minimum batch threshold — only fire when at least N rows are pending OR a max-wait timer expires:

```typescript
const MIN_BATCH_SIZE = 10;    // don't sync fewer than this many rows
const MAX_WAIT_MS = 5_000;    // but always sync within 5s of first new data
```

Implementation: track `firstNewDataAt` timestamp. On each tick, if total pending rows < MIN_BATCH_SIZE and elapsed time < MAX_WAIT_MS, skip and reschedule at CATCHUP_MS. If either threshold is met, sync.

This reduces POST frequency during bursty writes (e.g., rapid hook events during active tool use) while keeping latency bounded for live observation via Grafana.

## Part 6: Watermarks

**File: `src/sync/watermark.ts`** — add to `SYNCED_TABLES`:
```typescript
const SYNCED_TABLES = [
  "hook_events", "otel_logs", "otel_metrics",
  "scanner_turns", "scanner_events",
  // sessions use sync_dirty flag, not watermarks
];
```

## Part 7: Store OTLP traces

Currently the OTLP server accepts traces but drops them. Claude Code and Codex emit
span-level timing data we should capture.

**File: `src/db/schema.ts`** — migration v8 (or combined with sync_dirty):
```sql
CREATE TABLE otel_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind INTEGER,
  start_time_ns INTEGER NOT NULL,
  end_time_ns INTEGER NOT NULL,
  status_code INTEGER,
  status_message TEXT,
  attributes JSON,
  resource_attributes JSON,
  session_id TEXT,
  UNIQUE(trace_id, span_id)
);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON otel_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_session ON otel_spans(session_id);
CREATE INDEX IF NOT EXISTS idx_spans_start ON otel_spans(start_time_ns);
```

**File: `src/otlp/server.ts`** — replace the trace drop with actual decode + insert.
Proto definitions already imported. Add `decodeTraces()` and `insertOtelSpans()`.

**File: `src/sync/loop.ts`** — add `syncSpans()` to push spans upstream.

This gives us: per-operation latency, causality (parent/child spans), error attribution,
and correlation with otel_logs via shared trace_id/span_id.

## Data taxonomy

Three orthogonal attributes on every record:

| Attribute | Values | Meaning |
|---|---|---|
| **`target`** | `claude`, `codex`, `gemini` | Which CLI tool |
| **`source`** | `hooks`, `otel`, `scanner` | Data shape / table it lives in |
| **`emitter`** | `local`, `proxy` | Where the data was originally produced |

On the sessions table:
```sql
sources TEXT    -- comma-separated set: "hooks,otel,scanner"
emitter TEXT    -- "local" or "proxy" or "local,proxy"
```

Replaces the `has_hooks/has_otel/has_scanner` integer flags with a single
set field that's extensible and queryable via `sources LIKE '%scanner%'`.

## Attribute naming (updated)

| Stream | `target` | `source` | `emitter` | Endpoint | Watermark |
|---|---|---|---|---|---|
| Real hook events | claude/codex/gemini | hooks | local | `/v1/logs` | `hook_events:target` |
| Proxy-generated hooks | claude/codex/gemini | hooks | proxy | `/v1/logs` | `hook_events:target` |
| Real OTLP logs | claude/codex/gemini | otel | local | `/v1/logs` | `otel_logs:target` |
| Proxy-generated OTLP | claude/codex/gemini | otel | proxy | `/v1/logs` | `otel_logs:target` |
| OTLP metrics | claude/codex/gemini | otel | local/proxy | `/v1/metrics` | `otel_metrics:target` |
| OTLP spans | claude/codex/gemini | otel | local | `/v1/traces` | `otel_spans:target` |
| Scanner turns | claude/codex/gemini | scanner | local | `/v1/metrics` | `scanner_turns:target` |
| Scanner events | claude/codex/gemini | scanner | local | `/v1/logs` | `scanner_events:target` |
| Session summaries | claude/codex/gemini | session | — | `/v1/logs` | `sync_dirty` flag |

## Part 8: Full data archive (100% recall)

The scanner currently truncates content previews (200 chars), tool inputs (1000 chars),
and tool outputs (1000 chars). The raw session files have the full content — a Codex
tool output can be thousands of lines of stdout, a Gemini thoughts block can be pages
of reasoning. We need 100% data recall.

### Two-tier storage

**Tier 1: SQLite / Neon (queryable)** — smart summaries for fast queries. Not raw
truncation — each field gets an appropriate compression strategy.

**Tier 2: Archive (full content)** — original session files, compressed and stored by
session_id. One file per session (all three CLIs already use this layout). Stored on
local filesystem (default), S3, or forwarded to a hub panopticon.

### Archive backend interface

```typescript
interface ArchiveBackend {
  put(sessionId: string, source: string, content: Buffer): Promise<boolean>;
  get(sessionId: string, source: string): Promise<Buffer | null>;
  has(sessionId: string, source: string): Promise<boolean>;
}
```

Implementations: local filesystem (`~/.local/share/panopticon/archive/`), S3-compatible,
or remote panopticon (mesh). Config via `panopticon archive add <backend>`.

### Smart field summaries (replacing raw truncation)

Instead of `content.slice(0, 200)`, use strategies appropriate to each field:

| Field | Current | Better approach |
|---|---|---|
| `content_preview` (turns) | Truncate 200 chars | LLM one-liner: "Refactored auth validation and added 3 tests" |
| `tool_input` (events) | Truncate 1000 chars | Structured extract: `{command: "pytest", file: "test_auth.py"}` |
| `tool_output` (events) | Truncate 1000 chars | LLM summary: "8 tests passed, 0 failed" or structured: `{exit_code: 0, lines: 47}` |
| `content` (agent_message) | Truncate 500 chars | Keep as-is (already short commentary) |
| `content` (reasoning) | Truncate 500 chars | LLM compress: "Analyzed auth flow for injection vulnerabilities" |
| `content` (error) | Keep full | Keep full (errors are short and critical) |
| `first_prompt` (session) | Truncate 200 chars | Keep first sentence + LLM intent tag: "refactoring [auth]" |

The LLM summaries run locally (Haiku/Flash, ~$0.001 per field) during the scanner's
60s poll cycle. Fields that don't need LLM (structured extracts, short content) use
deterministic logic. The full content is always available in tier 2.

### Vector embeddings for semantic search

In addition to human-readable summaries, embed key text fields for semantic search
across sessions. "Find all sessions where someone worked on authentication" works
even if no session mentions the word "authentication" literally.

Embed:
- Turn summaries (the LLM one-liners)
- Session summaries (the flattened narrative from Part 9)
- First prompt
- Tool call context (tool name + summarized input)

Storage:
- Local: `sqlite-vss` extension or raw BLOB with app-side cosine similarity
- Server: `pgvector` in Neon (built-in, indexed)

Embedding model: local (e.g. `all-MiniLM-L6-v2` via ONNX, 384-dim, runs on CPU) or
API (OpenAI `text-embedding-3-small`, ~$0.00002 per embed). Local preferred to avoid
API dependency and keep everything offline-capable.

```sql
ALTER TABLE scanner_turns ADD COLUMN summary TEXT;
ALTER TABLE scanner_turns ADD COLUMN embedding BLOB;        -- 384-dim float32 vector

ALTER TABLE sessions ADD COLUMN summary_embedding BLOB;
```

CLI:
```
panopticon search "authentication refactor"    # semantic search across sessions
panopticon search "rate limiting" --since 7d   # scoped by time
```

This is additive — embeddings can be backfilled from existing summaries at any time.
Not required for the initial implementation of smart summaries.

### Open questions: search granularity

Vector search works best at the right granularity. Too fine (every tool output line)
produces millions of high-cardinality vectors that are noisier than ripgrep. Too coarse
(session-level only) can't answer "which turn hit the rate limit error?"

Current thinking — two search layers:

| Query type | Tool | Data source |
|---|---|---|
| Semantic: "sessions involving auth" | Vector search | Turn-level LLM summaries |
| Semantic: "sessions similar to this" | Vector similarity | Session summary embeddings |
| Exact: "which session edited auth.ts" | FTS / ripgrep | hook_events FTS, scanner_events, archive |
| Exact: "ECONNREFUSED errors" | FTS / ripgrep | Archive raw files, scanner_events.content |

We already have FTS on hook_events (`hook_events_fts` with trigram tokenizer). Adding
FTS on scanner_events would cover exact-match search without vectors.

Vectors only for the semantic layer (turn summaries + session summaries). Everything
else is better served by text search on raw data — either the existing FTS indexes or
ripgrep over the archive.

Questions to resolve:
- Is turn-level the right granularity for vectors, or should we embed at a coarser
  "phase" level (groups of related turns)?
- Should we embed the LLM summary or the raw content? Summary has less noise but
  loses detail. Raw content has signal but high cardinality.
- For the archive, is ripgrep over gzipped JSONL fast enough, or do we need a
  dedicated search index (tantivy, bleve)?
- How do vectors compose across the mesh? Does the hub re-embed, or do leaf nodes
  send pre-computed embeddings upstream?

### Archive integration with scanner

After parsing a session file (tier 1 data), archive the raw file (tier 2):

```typescript
if (archive && result.meta?.sessionId) {
  const content = fs.readFileSync(filePath);
  await archive.put(result.meta.sessionId, source, gzipSync(content));
}
```

Track `archived_size` on `scanner_file_watermarks` to avoid re-archiving unchanged files.

### CLI

```
panopticon archive list                  # list archived sessions
panopticon archive get <session-id>      # retrieve full session content
panopticon archive stats                 # total size by source
```

### Size estimates

| | Per developer | 1000 engineers × 1 year |
|---|---|---|
| Raw session files | ~274 MB | ~274 GB |
| Gzipped archive | ~30-50 MB | ~30-50 GB |
| S3 standard cost | ~$0.001/mo | ~$0.70/mo |

## Part 9: AI-generated session summaries

Each developer's panopticon generates incremental narrative summaries of active sessions
using a cheap model (Haiku/Flash), running locally where the full conversation context
is available from session files.

### Delta updates

Every ~10 turns or 5 minutes of activity, generate a one-sentence delta:
- Input: previous delta + new turns (from session file via archive/scanner)
- Prompt: "Given the previous state: '{last_delta}', summarize what happened in one sentence"
- Output: "Wrote 8 tests for token validation, all passing"
- Cost: ~$0.001 per delta

Deltas stream upstream immediately as part of the session sync.

### Flattening

When the delta chain exceeds a threshold (~20 deltas or 2KB total):
- Input: all deltas
- Prompt: "Compress these incremental summaries into 2-3 sentences"
- Output: "Refactored auth module: fixed 3 security issues, added rate limiting. Wrote 8 tests, opened and merged PR #234."
- Old deltas discarded, flat summary replaces them

### Data model

```sql
ALTER TABLE sessions ADD COLUMN summary TEXT;
ALTER TABLE sessions ADD COLUMN summary_version INTEGER DEFAULT 0;

CREATE TABLE session_summary_deltas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  delta TEXT NOT NULL,
  context_turns_start INTEGER,
  context_turns_end INTEGER,
  generated_at_ms INTEGER NOT NULL,
  UNIQUE(session_id, version)
);
```

### Why leaf-side

The leaf node has full conversation content from session files. The hub only receives
truncated previews and token counts — not enough to summarize. Running the LLM locally:
- Avoids sending full conversation text upstream (privacy)
- Distributes compute cost across developers (~$0.025/day each)
- Produces summaries at the point of highest context

The flat summary syncs as part of the session row. Deltas optionally sync as OTLP logs
for real-time status in dashboards ("what is this agent doing right now?").

## Part 10: Self-hosted LLM backend

All LLM features (turn summaries, session narratives, smart field compression) must
work without proprietary API dependencies. An `LlmBackend` interface abstracts the
model provider.

### Interface

```typescript
interface LlmBackend {
  generate(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
  embed?(text: string): Promise<Float32Array>;  // optional, for vector search
}
```

### Implementations

| Backend | Config | Use case |
|---|---|---|
| `ollama` | `http://localhost:11434` | Self-hosted, local GPU/CPU inference |
| `anthropic` | API key | Cloud, best quality |
| `openai` | API key | Cloud, alternative |
| `none` | — | Zero dependencies, deterministic fallbacks |

### Config

```toml
[llm]
backend = "ollama"             # "ollama" | "anthropic" | "openai" | "none"
model = "gemma3:4b"            # model name for the chosen backend
endpoint = "http://localhost:11434"  # for ollama
# api_key = "..."              # for cloud backends
```

### Degradation when `backend = "none"`

Every LLM feature has a deterministic fallback:

| Feature | With LLM | Without LLM |
|---|---|---|
| Turn summary | "Refactored auth validation" | First 200 chars of content (current behavior) |
| Tool output summary | "8 tests passed, 0 failed" | `{lines: 47, exit_code: 0}` structured extract |
| Session narrative | "Fixed 3 security issues, merged PR #234" | First prompt + turn count + tool count |
| Vector embeddings | Semantic search | Disabled, FTS/ripgrep only |

No feature is gated on having an LLM. The LLM makes summaries better but the system
is fully functional without one.

### Self-hosted audit

Every component of panopticon can run without proprietary services:

| Component | Proprietary option | Self-hosted option |
|---|---|---|
| Data collection | — | Local SQLite (always) |
| Upstream sync | — | Any OTLP receiver |
| Dashboards | — | Grafana LGTM (OSS, Docker) |
| Server storage | Neon (managed) | Self-host Postgres |
| LLM summaries | Anthropic/OpenAI API | Ollama + local model |
| Embeddings | OpenAI API | Local ONNX model |
| Archive | S3 | Local filesystem (default) |
| Search | — | sqlite-vss / pgvector (OSS) |

## Open question: Cross-user work correlation

Panopticon currently correlates sessions via git repo (`org/repo` from `git remote`),
which only works for SCM-based developer workflows. Many AI users do non-git work
(data analysis, writing, research, ops, design). How do we identify that two people
are working on the same thing?

Approaches under consideration:

1. **User-assigned tags/project labels** — `panopticon tag <session> "q3-forecast"` or
   a `PANOPTICON.md` file in the working directory that declares the project. Simple,
   high signal, requires user discipline.

2. **CWD path matching** — match on last path components across users. Fragile but free,
   works when teams use consistent directory naming.

3. **Semantic clustering** — use session/turn summary embeddings to cluster related work
   across users. "Alice and Bob both worked on auth refactoring" emerges from vector
   similarity. Requires the embedding infrastructure from Part 8.

4. **Shared entity extraction** — extract named entities from prompts and tool calls
   (file names, function names, service names, ticket IDs, URLs). Build a co-occurrence
   graph: sessions that mention the same entities are related work. Works across git and
   non-git workflows. Strongest signal but hardest to build — needs NER or structured
   extraction, entity dedup/normalization, and a graph query layer.

Likely path: start with explicit tags (#1) as the user-controlled foundation. Add
semantic clustering (#3) once embeddings exist. Invest in entity extraction (#4) as
the long-term solution — it's the only approach that produces precise, explainable
correlations without requiring user action.

## Files to modify

| File | Changes |
|---|---|
| `src/db/schema.ts` | Migration: `sync_dirty` + `sources`/`emitter` on sessions, `otel_spans` table |
| `src/db/store.ts` | Set `sync_dirty = 1` in `upsertSession()`, replace `has_*` with `sources`/`emitter` |
| `src/otlp/server.ts` | Decode + store traces, detect + route `session.summary`, add `emitter` attr |
| `src/sync/types.ts` | Add record interfaces for scanner turns/events, sessions, spans |
| `src/sync/reader.ts` | Add reader functions for scanner turns/events, dirty sessions, spans |
| `src/sync/serialize.ts` | Add serializers + `source`/`emitter` attributes on all streams |
| `src/sync/loop.ts` | Add sync functions for all new streams + debounce logic |
| `src/sync/watermark.ts` | Add scanner + span tables to `SYNCED_TABLES` |
| `src/proxy/emit.ts` | Tag emitted hooks/OTLP with `emitter=proxy` |
| `src/hooks/ingest.ts` | Tag with `emitter=local` (default) |

## Verification

1. `pnpm build && pnpm test`
2. Configure sync target → Grafana LGTM
3. Trigger hooks + run scanner → verify all streams appear in Loki/Prometheus
4. Query Loki: `{source="scanner"}` — scanner events/sessions
5. Query Prometheus: `scanner_token_usage` — per-turn metrics
6. Query Tempo: traces from Claude/Codex sessions — span waterfall
7. Modify a session → verify `sync_dirty` set → re-synced within 5s
8. Hub panopticon receives `session.summary` → check sessions table populated
9. Proxy mode: verify `emitter=proxy` on all proxy-generated data
10. E2E test: validate Loki count includes all streams
