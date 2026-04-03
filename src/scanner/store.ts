import path from "node:path";
import { refreshIfStale } from "../db/pricing.js";
import { getDb } from "../db/schema.js";
import {
  upsertSessionCwd,
  upsertSessionRepository,
  upsertSession as upsertSessionRow,
} from "../db/store.js";
import { resolveRepoFromCwd } from "../repo.js";
import type {
  ParsedEvent,
  ParsedMessage,
  ParsedSession,
  ParsedTurn,
} from "../targets/types.js";

// ── Session upsert (writes to unified sessions table) ───────────────────────

export function upsertSession(
  meta: ParsedSession,
  filePath: string,
  source: string,
): void {
  // Derive project from repository or cwd basename
  let project: string | undefined;
  if (meta.cwd) {
    const info = resolveRepoFromCwd(meta.cwd);
    if (info) {
      project = info.repo; // e.g. "fml-inc/panopticon"
    } else {
      project = path.basename(meta.cwd);
    }
  }

  upsertSessionRow({
    session_id: meta.sessionId,
    target: source,
    started_at_ms: meta.startedAtMs,
    first_prompt: meta.firstPrompt,
    model: meta.model,
    cli_version: meta.cliVersion,
    scanner_file_path: filePath,
    has_scanner: 1,
    project,
    created_at: meta.startedAtMs ?? Date.now(),
    parent_session_id: meta.parentSessionId,
    relationship_type:
      meta.relationshipType ?? (meta.parentSessionId ? "subagent" : undefined),
  });

  // Record cwd and repo for scanner-only sessions
  if (meta.cwd) {
    upsertSessionCwd(meta.sessionId, meta.cwd, meta.startedAtMs ?? Date.now());
  }
  if (meta.cwd) {
    const info = resolveRepoFromCwd(meta.cwd);
    if (info) {
      upsertSessionRepository(
        meta.sessionId,
        info.repo,
        meta.startedAtMs ?? Date.now(),
        undefined,
        info.branch,
      );
    }
  }
}

// ── Turn insert ─────────────────────────────────────────────────────────────

const INSERT_TURN_SQL = `
  INSERT OR IGNORE INTO scanner_turns
    (session_id, source, turn_index, timestamp_ms, model, role,
     content_preview, input_tokens, output_tokens,
     cache_read_tokens, cache_creation_tokens, reasoning_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function insertTurns(turns: ParsedTurn[], source: string): void {
  if (turns.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(INSERT_TURN_SQL);
  const tx = db.transaction(() => {
    for (const t of turns) {
      stmt.run(
        t.sessionId,
        source,
        t.turnIndex,
        t.timestampMs,
        t.model ?? null,
        t.role,
        t.contentPreview ?? null,
        t.inputTokens,
        t.outputTokens,
        t.cacheReadTokens,
        t.cacheCreationTokens,
        t.reasoningTokens,
      );
    }
  });
  tx();
}

// ── Scanner events insert ───────────────────────────────────────────────────

const INSERT_EVENT_SQL = `
  INSERT OR IGNORE INTO scanner_events
    (session_id, source, event_type, timestamp_ms, tool_name, tool_input, tool_output, content, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function insertScannerEvents(
  events: ParsedEvent[],
  source: string,
): void {
  if (events.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(INSERT_EVENT_SQL);
  const tx = db.transaction(() => {
    for (const e of events) {
      stmt.run(
        e.sessionId,
        source,
        e.eventType,
        e.timestampMs,
        e.toolName ?? null,
        e.toolInput ?? null,
        e.toolOutput ?? null,
        e.content ?? null,
        e.metadata ? JSON.stringify(e.metadata) : null,
      );
    }
  });
  tx();

  // Resolve repos from file paths in tool_call events (greedy attribution)
  const seen = new Set<string>();
  for (const e of events) {
    if (e.eventType !== "tool_call" || !e.toolInput) continue;
    try {
      const input = JSON.parse(e.toolInput);
      const fp = input.file_path ?? input.path;
      if (typeof fp !== "string" || !path.isAbsolute(fp)) continue;
      const dir = path.dirname(fp);
      if (seen.has(dir)) continue;
      seen.add(dir);
      const info = resolveRepoFromCwd(dir);
      if (info) {
        upsertSessionRepository(
          e.sessionId,
          info.repo,
          e.timestampMs,
          undefined,
          info.branch,
        );
      }
    } catch {
      // malformed tool_input JSON
    }
  }
}

// ── Session totals update (writes to unified sessions table) ────────────────

const UPDATE_TOTALS_SQL = `
  UPDATE sessions SET
    total_input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM scanner_turns WHERE session_id = ?),
    total_output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM scanner_turns WHERE session_id = ?),
    total_cache_read_tokens = (SELECT COALESCE(SUM(cache_read_tokens), 0) FROM scanner_turns WHERE session_id = ?),
    total_cache_creation_tokens = (SELECT COALESCE(SUM(cache_creation_tokens), 0) FROM scanner_turns WHERE session_id = ?),
    total_reasoning_tokens = (SELECT COALESCE(SUM(reasoning_tokens), 0) FROM scanner_turns WHERE session_id = ?),
    turn_count = (SELECT COUNT(*) FROM scanner_turns WHERE session_id = ?)
  WHERE session_id = ?
`;

export function updateSessionTotals(sessionId: string): void {
  const db = getDb();
  db.prepare(UPDATE_TOTALS_SQL).run(
    sessionId,
    sessionId,
    sessionId,
    sessionId,
    sessionId,
    sessionId,
    sessionId,
  );
  // Scanner produces token data that needs pricing for cost queries
  refreshIfStale().catch(() => {});
}

// ── File watermarks ─────────────────────────────────────────────────────────

export function readFileWatermark(filePath: string): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT byte_offset FROM scanner_file_watermarks WHERE file_path = ?",
    )
    .get(filePath) as { byte_offset: number } | undefined;
  return row?.byte_offset ?? 0;
}

export function writeFileWatermark(filePath: string, byteOffset: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO scanner_file_watermarks (file_path, byte_offset, last_scanned_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET byte_offset = excluded.byte_offset, last_scanned_ms = excluded.last_scanned_ms`,
  ).run(filePath, byteOffset, Date.now());
}

/**
 * Reset a single file for full reparse: clear its watermark and delete
 * all turns, messages, tool_calls, and events for the session so the
 * full-file parse can re-insert cleanly (including fork detection).
 */
export function resetFileForReparse(
  filePath: string,
  sessionId?: string,
): void {
  const db = getDb();
  db.prepare("DELETE FROM scanner_file_watermarks WHERE file_path = ?").run(
    filePath,
  );
  if (sessionId) {
    db.prepare("DELETE FROM scanner_turns WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM scanner_events WHERE session_id = ?").run(
      sessionId,
    );
    db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(sessionId);
    db.prepare(
      "DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)",
    ).run(sessionId);
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    // Also clean up any previously-detected fork sessions from this file
    const forkSessionFilter =
      "SELECT session_id FROM sessions WHERE parent_session_id = ? AND relationship_type = 'fork'";
    db.prepare(
      `DELETE FROM scanner_turns WHERE session_id IN (${forkSessionFilter})`,
    ).run(sessionId);
    db.prepare(
      `DELETE FROM scanner_events WHERE session_id IN (${forkSessionFilter})`,
    ).run(sessionId);
    db.prepare(
      `DELETE FROM tool_calls WHERE session_id IN (${forkSessionFilter})`,
    ).run(sessionId);
    db.prepare(
      `DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id IN (${forkSessionFilter}))`,
    ).run(sessionId);
    db.prepare(
      `DELETE FROM messages WHERE session_id IN (${forkSessionFilter})`,
    ).run(sessionId);
    db.prepare(
      "DELETE FROM sessions WHERE parent_session_id = ? AND relationship_type = 'fork'",
    ).run(sessionId);
  }
}

export function resetScanner(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM scanner_file_watermarks;
    DELETE FROM scanner_turns;
    DELETE FROM scanner_events;
    DELETE FROM tool_calls;
    DELETE FROM messages_fts;
    DELETE FROM messages;
    UPDATE sessions SET
      model = NULL, cli_version = NULL, scanner_file_path = NULL,
      total_input_tokens = 0, total_output_tokens = 0,
      total_cache_read_tokens = 0, total_cache_creation_tokens = 0,
      total_reasoning_tokens = 0, turn_count = 0,
      message_count = 0, user_message_count = 0;
  `);
}

export function resetScannerSource(source: string): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM scanner_file_watermarks WHERE file_path IN (SELECT scanner_file_path FROM sessions WHERE target = ?)",
  ).run(source);
  db.prepare("DELETE FROM scanner_turns WHERE source = ?").run(source);
  db.prepare(
    "DELETE FROM tool_calls WHERE session_id IN (SELECT session_id FROM sessions WHERE target = ?)",
  ).run(source);
  db.prepare(
    "DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id IN (SELECT session_id FROM sessions WHERE target = ?))",
  ).run(source);
  db.prepare(
    "DELETE FROM messages WHERE session_id IN (SELECT session_id FROM sessions WHERE target = ?)",
  ).run(source);
  db.prepare(`
    UPDATE sessions SET
      model = NULL, cli_version = NULL, scanner_file_path = NULL,
      total_input_tokens = 0, total_output_tokens = 0,
      total_cache_read_tokens = 0, total_cache_creation_tokens = 0,
      total_reasoning_tokens = 0, turn_count = 0,
      message_count = 0, user_message_count = 0
    WHERE target = ?
  `).run(source);
}

// ── Turn count for incremental parsing ──────────────────────────────────────

export function getTurnCount(sessionId: string, source: string): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT COUNT(*) as count FROM scanner_turns WHERE session_id = ? AND source = ?",
    )
    .get(sessionId, source) as { count: number };
  return row.count;
}

// ── Archive watermarks ─────────────────────────────────────────────────────

export function readArchivedSize(filePath: string): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT archived_size FROM scanner_file_watermarks WHERE file_path = ?",
    )
    .get(filePath) as { archived_size: number } | undefined;
  return row?.archived_size ?? 0;
}

export function writeArchivedSize(filePath: string, size: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE scanner_file_watermarks SET archived_size = ? WHERE file_path = ?",
  ).run(size, filePath);
}

// ── Turn summaries ─────────────────────────────────────────────────────────

export function updateTurnSummary(id: number, summary: string): void {
  const db = getDb();
  db.prepare("UPDATE scanner_turns SET summary = ? WHERE id = ?").run(
    summary,
    id,
  );
}

export function getTurnsWithoutSummary(
  sessionId: string,
  source: string,
  limit: number,
): Array<{
  id: number;
  role: string | null;
  content_preview: string | null;
}> {
  const db = getDb();
  return db
    .prepare(
      "SELECT id, role, content_preview FROM scanner_turns WHERE session_id = ? AND source = ? AND summary IS NULL LIMIT ?",
    )
    .all(sessionId, source, limit) as Array<{
    id: number;
    role: string | null;
    content_preview: string | null;
  }>;
}

// ── Messages & tool calls insert ───────────────────────────────────────────

const INSERT_MESSAGE_SQL = `
  INSERT OR IGNORE INTO messages
    (session_id, ordinal, role, content, timestamp_ms,
     has_thinking, has_tool_use, content_length, is_system,
     model, token_usage, context_tokens, output_tokens,
     has_context_tokens, has_output_tokens, uuid, parent_uuid)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_TOOL_CALL_SQL = `
  INSERT INTO tool_calls
    (message_id, session_id, tool_name, category, tool_use_id,
     input_json, skill_name, result_content_length, result_content,
     subagent_session_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Insert parsed messages and their tool calls into the database.
 * Tool results from user messages are matched back to tool calls
 * from the preceding assistant message by tool_use_id.
 *
 * Also backfills tool_calls from previous scans whose result_content
 * was NULL because the tool_result arrived in a later batch.
 */
export function insertMessages(
  messages: ParsedMessage[],
  orphanedToolResults?: Map<
    string,
    { contentLength: number; contentRaw: string }
  >,
): void {
  if (messages.length === 0 && !orphanedToolResults?.size) return;
  const db = getDb();

  // Collect all tool results across user messages for backfilling
  const toolResultMap = new Map<
    string,
    { contentLength: number; contentRaw: string }
  >();
  // Include orphaned results from filtered-out messages
  if (orphanedToolResults) {
    for (const [id, result] of orphanedToolResults) {
      toolResultMap.set(id, result);
    }
  }
  for (const msg of messages) {
    for (const [id, result] of msg.toolResults) {
      toolResultMap.set(id, result);
    }
  }

  const msgStmt = db.prepare(INSERT_MESSAGE_SQL);
  const tcStmt = db.prepare(INSERT_TOOL_CALL_SQL);
  const ftsStmt = db.prepare(
    "INSERT INTO messages_fts(rowid, content) VALUES (?, ?)",
  );

  const tx = db.transaction(() => {
    for (const msg of messages) {
      const result = msgStmt.run(
        msg.sessionId,
        msg.ordinal,
        msg.role,
        msg.content,
        msg.timestampMs ?? null,
        msg.hasThinking ? 1 : 0,
        msg.hasToolUse ? 1 : 0,
        msg.contentLength,
        msg.isSystem ? 1 : 0,
        msg.model ?? "",
        msg.tokenUsage ?? "",
        msg.contextTokens ?? 0,
        msg.outputTokens ?? 0,
        msg.hasContextTokens ? 1 : 0,
        msg.hasOutputTokens ? 1 : 0,
        msg.uuid ?? null,
        msg.parentUuid ?? null,
      );

      // INSERT OR IGNORE returns 0 changes if the row already exists
      if (result.changes === 0) continue;

      const messageId = result.lastInsertRowid;
      ftsStmt.run(messageId, msg.content);

      for (const tc of msg.toolCalls) {
        // Look up result from the tool_result blocks
        const toolResult = toolResultMap.get(tc.toolUseId);
        tcStmt.run(
          messageId,
          msg.sessionId,
          tc.toolName,
          tc.category,
          tc.toolUseId,
          tc.inputJson ?? null,
          tc.skillName ?? null,
          toolResult?.contentLength ?? null,
          toolResult?.contentRaw ?? null,
          tc.subagentSessionId ?? null,
        );
      }
    }

    // Backfill tool_calls from previous scans whose results arrived in this batch.
    if (toolResultMap.size > 0) {
      const backfillStmt = db.prepare(
        `UPDATE tool_calls
         SET result_content = ?, result_content_length = ?
         WHERE tool_use_id = ? AND result_content IS NULL`,
      );
      for (const [toolUseId, result] of toolResultMap) {
        backfillStmt.run(result.contentRaw, result.contentLength, toolUseId);
      }
    }
  });
  tx();
}

/**
 * Link subagent sessions to their parents.
 * Finds sessions whose ID appears in tool_calls.subagent_session_id
 * and sets their parent_session_id and relationship_type accordingly.
 */
export function linkSubagentSessions(): number {
  const db = getDb();
  // Only check sessions that don't already have a relationship set,
  // which limits work to newly-discovered sessions.
  const result = db
    .prepare(
      `UPDATE sessions
     SET parent_session_id = (
           SELECT tc.session_id
           FROM tool_calls tc
           WHERE tc.subagent_session_id = sessions.session_id
           LIMIT 1
         ),
         relationship_type = 'subagent',
         sync_seq = COALESCE(sync_seq, 0) + 1
     WHERE (relationship_type = '' OR relationship_type IS NULL)
       AND parent_session_id IS NULL
       AND EXISTS (
           SELECT 1 FROM tool_calls tc
           WHERE tc.subagent_session_id = sessions.session_id
         )`,
    )
    .run();
  return result.changes;
}

/**
 * Get the highest message ordinal for a session, or -1 if no messages exist.
 */
export function getMaxOrdinal(sessionId: string): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT MAX(ordinal) as max_ord FROM messages WHERE session_id = ?",
    )
    .get(sessionId) as { max_ord: number | null };
  return row.max_ord ?? -1;
}
