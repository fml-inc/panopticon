import {
  readHookEvents,
  readMessages,
  readMetrics,
  readOtelLogs,
  readOtelSpans,
  readRepoConfigSnapshots,
  readScannerEvents,
  readScannerTurns,
  readToolCalls,
  readUserConfigSnapshots,
} from "./reader.js";
import type { TableSyncDescriptor } from "./types.js";

/**
 * Ordered list of table sync descriptors. The order matches the
 * round-robin execution order in the sync loop.
 *
 * All tables sync via POST /v1/sync with {table, rows} payload.
 * Session-linked tables are filtered by repo attribution in the sync loop.
 *
 * NOTE: Sessions are NOT in this registry — they use direct comparison
 * against target_session_sync instead of a global watermark (sync_seq is
 * per-session, not globally monotonic).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TABLE_SYNC_REGISTRY: TableSyncDescriptor<any>[] = [
  // ── Session-linked tables (filtered by repo attribution) ─────────────────

  {
    table: "messages",
    logNoun: "messages",
    read: (afterId, limit) => readMessages(afterId, limit),
    sessionLinked: true,
  },

  {
    table: "tool_calls",
    logNoun: "tool calls",
    read: (afterId, limit) => readToolCalls(afterId, limit),
    sessionLinked: true,
  },

  {
    table: "scanner_turns",
    logNoun: "turns",
    read: (afterId, limit) => readScannerTurns(afterId, limit),
    sessionLinked: true,
  },

  {
    table: "scanner_events",
    logNoun: "events",
    read: (afterId, limit) => readScannerEvents(afterId, limit),
    sessionLinked: true,
  },

  {
    table: "hook_events",
    logNoun: "events",
    read: (afterId, limit) => readHookEvents(afterId, limit),
    sessionLinked: true,
  },

  {
    table: "otel_logs",
    logNoun: "logs",
    read: (afterId, limit) => readOtelLogs(afterId, limit, false),
    sessionLinked: true,
  },

  {
    table: "otel_metrics",
    logNoun: "metrics",
    read: (afterId, limit) => readMetrics(afterId, limit),
    sessionLinked: true,
  },

  {
    table: "otel_spans",
    logNoun: "spans",
    read: (afterId, limit) => readOtelSpans(afterId, limit),
    sessionLinked: true,
  },

  // ── Non-session tables (always synced) ────────────────────────────────────

  {
    table: "user_config_snapshots",
    logNoun: "snapshots",
    read: (afterId, limit) => readUserConfigSnapshots(afterId, limit),
    sessionLinked: false,
  },

  {
    table: "repo_config_snapshots",
    logNoun: "snapshots",
    read: (afterId, limit) => readRepoConfigSnapshots(afterId, limit),
    sessionLinked: false,
  },
];
