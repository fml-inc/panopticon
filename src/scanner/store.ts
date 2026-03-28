import { getDb } from "../db/schema.js";
import {
  upsertSessionRepository,
  upsertSession as upsertSessionRow,
} from "../db/store.js";
import { resolveRepoFromCwd } from "../repo.js";
import type {
  ScannerParsedEvent,
  ScannerParsedSession,
  ScannerParsedTurn,
} from "../targets/types.js";

// ── Session upsert (writes to unified sessions table) ───────────────────────

export function upsertSession(
  meta: ScannerParsedSession,
  filePath: string,
  source: string,
): void {
  upsertSessionRow({
    session_id: meta.sessionId,
    target: source,
    started_at_ms: meta.startedAtMs,
    cwd: meta.cwd,
    first_prompt: meta.firstPrompt,
    model: meta.model,
    cli_version: meta.cliVersion,
    scanner_file_path: filePath,
    has_scanner: 1,
  });

  // Resolve repo from cwd for scanner-only sessions
  if (meta.cwd) {
    const repo = resolveRepoFromCwd(meta.cwd);
    if (repo) {
      upsertSessionRepository(
        meta.sessionId,
        repo,
        meta.startedAtMs ?? Date.now(),
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

export function insertTurns(turns: ScannerParsedTurn[], source: string): void {
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
  events: ScannerParsedEvent[],
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

export function resetScanner(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM scanner_file_watermarks;
    DELETE FROM scanner_turns;
    UPDATE sessions SET
      model = NULL, cli_version = NULL, scanner_file_path = NULL,
      total_input_tokens = 0, total_output_tokens = 0,
      total_cache_read_tokens = 0, total_cache_creation_tokens = 0,
      total_reasoning_tokens = 0, turn_count = 0;
  `);
}

export function resetScannerSource(source: string): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM scanner_file_watermarks WHERE file_path IN (SELECT scanner_file_path FROM sessions WHERE target = ?)",
  ).run(source);
  db.prepare("DELETE FROM scanner_turns WHERE source = ?").run(source);
  db.prepare(`
    UPDATE sessions SET
      model = NULL, cli_version = NULL, scanner_file_path = NULL,
      total_input_tokens = 0, total_output_tokens = 0,
      total_cache_read_tokens = 0, total_cache_creation_tokens = 0,
      total_reasoning_tokens = 0, turn_count = 0
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
