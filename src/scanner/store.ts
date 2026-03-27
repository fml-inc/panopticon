import { getDb } from "../db/schema.js";
import type {
  ScannerParsedSession,
  ScannerParsedTurn,
} from "../targets/types.js";

// ── Session upsert ──────────────────────────────────────────────────────────

const UPSERT_SESSION_SQL = `
  INSERT INTO scanner_sessions (session_id, source, file_path, model, cwd, cli_version, started_at_ms, first_prompt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id, source) DO UPDATE SET
    model = COALESCE(excluded.model, scanner_sessions.model),
    cwd = COALESCE(excluded.cwd, scanner_sessions.cwd),
    cli_version = COALESCE(excluded.cli_version, scanner_sessions.cli_version),
    started_at_ms = COALESCE(excluded.started_at_ms, scanner_sessions.started_at_ms),
    first_prompt = COALESCE(excluded.first_prompt, scanner_sessions.first_prompt)
`;

export function upsertSession(
  meta: ScannerParsedSession,
  filePath: string,
  source: string,
): void {
  const db = getDb();
  db.prepare(UPSERT_SESSION_SQL).run(
    meta.sessionId,
    source,
    filePath,
    meta.model ?? null,
    meta.cwd ?? null,
    meta.cliVersion ?? null,
    meta.startedAtMs ?? null,
    meta.firstPrompt ?? null,
  );
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

// ── Session totals update ───────────────────────────────────────────────────

const UPDATE_TOTALS_SQL = `
  UPDATE scanner_sessions SET
    total_input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM scanner_turns WHERE session_id = ? AND source = ?),
    total_output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM scanner_turns WHERE session_id = ? AND source = ?),
    total_cache_read_tokens = (SELECT COALESCE(SUM(cache_read_tokens), 0) FROM scanner_turns WHERE session_id = ? AND source = ?),
    total_cache_creation_tokens = (SELECT COALESCE(SUM(cache_creation_tokens), 0) FROM scanner_turns WHERE session_id = ? AND source = ?),
    total_reasoning_tokens = (SELECT COALESCE(SUM(reasoning_tokens), 0) FROM scanner_turns WHERE session_id = ? AND source = ?),
    turn_count = (SELECT COUNT(*) FROM scanner_turns WHERE session_id = ? AND source = ?)
  WHERE session_id = ? AND source = ?
`;

export function updateSessionTotals(sessionId: string, source: string): void {
  const db = getDb();
  db.prepare(UPDATE_TOTALS_SQL).run(
    sessionId,
    source,
    sessionId,
    source,
    sessionId,
    source,
    sessionId,
    source,
    sessionId,
    source,
    sessionId,
    source,
    sessionId,
    source,
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
    DELETE FROM scanner_sessions;
  `);
}

export function resetScannerSource(source: string): void {
  const db = getDb();
  // Delete watermarks for files belonging to this source's sessions
  db.prepare(`
    DELETE FROM scanner_file_watermarks
    WHERE file_path IN (SELECT file_path FROM scanner_sessions WHERE source = ?)
  `).run(source);
  db.prepare("DELETE FROM scanner_turns WHERE source = ?").run(source);
  db.prepare("DELETE FROM scanner_sessions WHERE source = ?").run(source);
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
