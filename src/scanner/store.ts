import path from "node:path";
import { refreshIfStale } from "../db/pricing.js";
import { getDb } from "../db/schema.js";
import {
  upsertSessionCwd,
  upsertSessionRepository,
  upsertSession as upsertSessionRow,
} from "../db/store.js";
import {
  buildMessageSyncId,
  buildScannerEventSyncId,
  buildScannerTurnSyncId,
  buildToolCallSyncId,
} from "../db/sync-ids.js";
import { dirnameOfObservedPath, isObservedAbsolutePath } from "../paths.js";
import { resolveGitIdentity, resolveRepoFromCwd } from "../repo.js";
import type {
  ParsedEvent,
  ParsedMessage,
  ParsedSession,
  ParsedToolCall,
  ParsedTurn,
} from "../targets/types.js";

// ── Legacy sync-id snapshot shape ─────────────────────────────────────────

// Scanner-owned rows now recompute deterministic sync IDs on re-insert.
// Keep this shape temporarily so resetFileForReparse can return a stable
// value while older call sites are removed.

export interface SavedSyncIds {
  turns: Array<{
    sessionId: string;
    source: string;
    turnIndex: number;
    syncId: string;
  }>;
  events: Array<{
    sessionId: string;
    source: string;
    eventType: string;
    timestampMs: number;
    toolName: string;
    syncId: string;
  }>;
  toolCalls: Array<{
    sessionId: string;
    ordinal: number;
    callIndex: number;
    toolUseId: string;
    toolName: string;
    syncId: string;
  }>;
}

export interface FileWatermarkState {
  byteOffset: number;
  sessionId?: string;
}

// ── Session upsert (writes to unified sessions table) ───────────────────────

function scannerSessionNeedsUpsert(
  meta: ParsedSession,
  filePath: string,
  source: string,
  project: string | undefined,
  relationshipType: string | undefined,
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT target, started_at_ms, first_prompt, model, models, cli_version,
              scanner_file_path, project, parent_session_id, relationship_type,
              has_scanner
         FROM sessions
        WHERE session_id = ?`,
    )
    .get(meta.sessionId) as
    | {
        target: string | null;
        started_at_ms: number | null;
        first_prompt: string | null;
        model: string | null;
        models: string | null;
        cli_version: string | null;
        scanner_file_path: string | null;
        project: string | null;
        parent_session_id: string | null;
        relationship_type: string | null;
        has_scanner: number | null;
      }
    | undefined;

  if (!row) return true;
  if (row.target !== source) return true;
  if (meta.startedAtMs != null && row.started_at_ms !== meta.startedAtMs) {
    return true;
  }
  if (row.first_prompt == null && meta.firstPrompt != null) return true;
  if (meta.model != null) {
    if (row.model !== meta.model) return true;
    if (row.models == null || !row.models.includes(meta.model)) return true;
  }
  if (meta.cliVersion != null && row.cli_version !== meta.cliVersion) {
    return true;
  }
  if (row.scanner_file_path !== filePath) return true;
  if (row.project == null && project != null) return true;
  if (
    meta.parentSessionId != null &&
    row.parent_session_id !== meta.parentSessionId
  ) {
    return true;
  }
  if (relationshipType != null && row.relationship_type !== relationshipType) {
    return true;
  }
  if ((row.has_scanner ?? 0) !== 1) return true;
  return false;
}

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

  const relationshipType =
    meta.relationshipType ?? (meta.parentSessionId ? "subagent" : undefined);
  if (
    scannerSessionNeedsUpsert(meta, filePath, source, project, relationshipType)
  ) {
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
      relationship_type: relationshipType,
    });
  }

  // Record cwd and repo for scanner-only sessions
  if (meta.cwd) {
    upsertSessionCwd(meta.sessionId, meta.cwd, meta.startedAtMs ?? Date.now());
  }
  if (meta.cwd) {
    const info = resolveRepoFromCwd(meta.cwd);
    if (info) {
      const gitId = resolveGitIdentity(meta.cwd);
      upsertSessionRepository(
        meta.sessionId,
        info.repo,
        meta.startedAtMs ?? Date.now(),
        gitId,
        info.branch,
      );
    }
  }
}

export function readSessionIdByScannerFile(
  filePath: string,
  source: string,
): string | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.session_id
       FROM sessions s
       WHERE s.scanner_file_path = ?
         AND s.target = ?
       ORDER BY
         CASE WHEN COALESCE(s.relationship_type, '') = 'fork' THEN 1 ELSE 0 END,
         CASE WHEN COALESCE(s.relationship_type, '') = 'subagent' THEN 1 ELSE 0 END,
         COALESCE(s.started_at_ms, s.created_at, 0) ASC,
         s.session_id ASC
       LIMIT 1`,
    )
    .get(filePath, source) as { session_id: string } | undefined;

  return row?.session_id ?? undefined;
}

export function readKnownScannerFiles(source: string): string[] {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT DISTINCT scanner_file_path
         FROM sessions
         WHERE target = ?
           AND scanner_file_path IS NOT NULL
           AND scanner_file_path != ''
           AND COALESCE(has_scanner, 0) = 0
         ORDER BY scanner_file_path`,
      )
      .all(source) as Array<{ scanner_file_path: string }>
  ).map((row) => row.scanner_file_path);
}

// ── Turn insert ─────────────────────────────────────────────────────────────

// New turns insert verbatim. Re-parses of a full session snapshot are common
// (the scanner re-emits whole sessions), so a conflicting turn_index is the
// normal case, handled by UPDATE_TURN_SQL below.
const INSERT_TURN_SQL = `
  INSERT INTO scanner_turns
    (session_id, source, turn_index, timestamp_ms, model, role,
     content_preview, input_tokens, output_tokens,
     cache_read_tokens, cache_creation_tokens, reasoning_tokens, sync_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id, source, turn_index) DO NOTHING
`;

// Refresh an existing turn, but only when a token value actually changed.
// This is last-write-wins for ALL sources: the JSONL scanners
// (claude/codex/gemini/pi) re-emit identical turns so the guarded WHERE makes
// the UPDATE a no-op for them, while adapters whose per-turn values move
// between parses (hermes attaches its session-aggregate to the latest
// assistant turn) get refreshed. Crucially, changes() then precisely
// identifies the mutated rows: those already propagated to the sync remote and
// must be re-sent. sync_id is never rewritten — the remote keys on it, so
// re-sending the same sync_id patches the existing remote row in place.
const UPDATE_TURN_SQL = `
  UPDATE scanner_turns SET
    timestamp_ms = ?,
    model = ?,
    role = ?,
    content_preview = ?,
    input_tokens = ?,
    output_tokens = ?,
    cache_read_tokens = ?,
    cache_creation_tokens = ?,
    reasoning_tokens = ?
  WHERE session_id = ? AND source = ? AND turn_index = ?
    AND (
      input_tokens != ?
      OR output_tokens != ?
      OR cache_read_tokens != ?
      OR cache_creation_tokens != ?
      OR reasoning_tokens != ?
    )
`;

// When an already-synced turn's tokens change, force its session's
// scanner_turns rows to re-sync. The per-session sync watermark
// (target_session_sync.wm_scanner_turns) reads rows by `id > watermark`, so a
// mutated row (same id) would otherwise never be re-read; resetting to 0
// re-sends the whole session's turns and the remote patches each by sync_id.
// Bumping sessions.sync_seq guarantees the session is re-selected as pending
// regardless of whether tool/event counts also changed this pass.
const RESYNC_TURNS_SQL = `
  UPDATE target_session_sync SET wm_scanner_turns = 0 WHERE session_id = ?
`;
const BUMP_SESSION_SEQ_SQL = `
  UPDATE sessions SET sync_seq = COALESCE(sync_seq, 0) + 1 WHERE session_id = ?
`;

/**
 * Insert/refresh scanner turns. Returns the number of turns that were newly
 * inserted or had a token value change — i.e. actual work. A full re-snapshot
 * of an unchanged session (the recently-active revalidation path) returns 0,
 * so the scanner loop can treat it as idle rather than spinning at its
 * catch-up cadence.
 */
export function insertTurns(turns: ParsedTurn[], source: string): number {
  if (turns.length === 0) return 0;
  const db = getDb();
  const insertStmt = db.prepare(INSERT_TURN_SQL);
  const updateStmt = db.prepare(UPDATE_TURN_SQL);
  const resyncStmt = db.prepare(RESYNC_TURNS_SQL);
  const bumpSeqStmt = db.prepare(BUMP_SESSION_SEQ_SQL);

  let changedCount = 0;
  const tx = db.transaction(() => {
    const mutatedSessions = new Set<string>();
    for (const t of turns) {
      const inserted = insertStmt.run(
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
        buildScannerTurnSyncId(t.sessionId, source, t.turnIndex),
      );
      const updated = updateStmt.run(
        t.timestampMs,
        t.model ?? null,
        t.role,
        t.contentPreview ?? null,
        t.inputTokens,
        t.outputTokens,
        t.cacheReadTokens,
        t.cacheCreationTokens,
        t.reasoningTokens,
        t.sessionId,
        source,
        t.turnIndex,
        t.inputTokens,
        t.outputTokens,
        t.cacheReadTokens,
        t.cacheCreationTokens,
        t.reasoningTokens,
      );
      if (inserted.changes > 0 || updated.changes > 0) changedCount++;
      if (updated.changes > 0) mutatedSessions.add(t.sessionId);
    }
    for (const sessionId of mutatedSessions) {
      resyncStmt.run(sessionId);
      bumpSeqStmt.run(sessionId);
    }
  });
  tx();
  return changedCount;
}

// ── Scanner events insert ───────────────────────────────────────────────────

const INSERT_EVENT_SQL = `
  INSERT OR IGNORE INTO scanner_events
    (session_id, source, event_index, event_type, timestamp_ms, tool_name, tool_input, tool_output, content, metadata, sync_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

type ToolInputSessionPath = {
  dir: string;
  isWorkingDirectory: boolean;
};

function extractToolInputSessionPaths(
  toolInputJson: string | null | undefined,
  toolName?: string | null,
): ToolInputSessionPath[] {
  if (!toolInputJson) return [];

  let input: unknown;
  try {
    input = JSON.parse(toolInputJson);
  } catch {
    return [];
  }
  if (!input || typeof input !== "object") return [];

  const record = input as Record<string, unknown>;
  const paths: ToolInputSessionPath[] = [];
  const seen = new Set<string>();
  const add = (dir: string, isWorkingDirectory: boolean) => {
    if (!seen.has(dir)) {
      seen.add(dir);
      paths.push({ dir, isWorkingDirectory });
    } else if (isWorkingDirectory) {
      const existing = paths.find((p) => p.dir === dir);
      if (existing) existing.isWorkingDirectory = true;
    }
  };

  for (const key of ["shell_pwd", "workdir", "cwd"]) {
    const value = record[key];
    if (typeof value === "string" && isObservedAbsolutePath(value)) {
      add(value, true);
    }
  }

  if (toolName === "EnterWorktree") {
    const value = record.path;
    if (typeof value === "string" && isObservedAbsolutePath(value)) {
      add(value, true);
    }
  }

  const pathKeys =
    toolName === "EnterWorktree" ? ["file_path"] : ["file_path", "path"];
  for (const key of pathKeys) {
    const value = record[key];
    if (typeof value === "string" && isObservedAbsolutePath(value)) {
      add(dirnameOfObservedPath(value), false);
    }
  }

  return paths;
}

function attributeSessionPathsFromToolInput(
  sessionId: string,
  timestampMs: number,
  toolInputJson: string | null | undefined,
  toolName: string | null | undefined,
  seenCwds: Set<string>,
  seenRepoDirs: Set<string>,
): void {
  for (const { dir, isWorkingDirectory } of extractToolInputSessionPaths(
    toolInputJson,
    toolName,
  )) {
    const sessionCwdKey = `${sessionId}\0${dir}`;
    if (isWorkingDirectory && !seenCwds.has(sessionCwdKey)) {
      seenCwds.add(sessionCwdKey);
      upsertSessionCwd(sessionId, dir, timestampMs);
    }

    const repoDirKey = `${sessionId}\0${dir}`;
    if (seenRepoDirs.has(repoDirKey)) continue;
    seenRepoDirs.add(repoDirKey);

    const info = resolveRepoFromCwd(dir);
    if (info) {
      const gitId = resolveGitIdentity(dir);
      upsertSessionRepository(
        sessionId,
        info.repo,
        timestampMs,
        gitId,
        info.branch,
      );
    }
  }
}

export function insertScannerEvents(
  events: ParsedEvent[],
  source: string,
): void {
  if (events.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(INSERT_EVENT_SQL);
  const tx = db.transaction(() => {
    const nextEventIndexBySessionSource = new Map<string, number>();
    for (const e of events) {
      let eventIndex = e.eventIndex;
      if (eventIndex == null) {
        const eventStreamKey = `${e.sessionId}|${source}`;
        let next = nextEventIndexBySessionSource.get(eventStreamKey);
        if (next == null) {
          next = getEventCount(e.sessionId, source);
        }
        eventIndex = next;
        nextEventIndexBySessionSource.set(eventStreamKey, next + 1);
      }

      stmt.run(
        e.sessionId,
        source,
        eventIndex,
        e.eventType,
        e.timestampMs,
        e.toolName ?? null,
        e.toolInput ?? null,
        e.toolOutput ?? null,
        e.content ?? null,
        e.metadata ? JSON.stringify(e.metadata) : null,
        buildScannerEventSyncId(e.sessionId, source, eventIndex),
      );
    }
  });
  tx();

  // Resolve repos and actual working directories from tool_call inputs
  // (greedy attribution). Codex hook payloads may only expose the launch cwd,
  // while scanner tool inputs retain per-command workdir.
  const seenCwds = new Set<string>();
  const seenRepoDirs = new Set<string>();
  for (const e of events) {
    if (e.eventType !== "tool_call" || !e.toolInput) continue;
    attributeSessionPathsFromToolInput(
      e.sessionId,
      e.timestampMs,
      e.toolInput,
      e.toolName,
      seenCwds,
      seenRepoDirs,
    );
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
  // Snapshot the synced-relevant columns before recomputing so we only bump
  // sync_seq when something actually changed. Re-snapshotting an unchanged
  // session (the recently-active revalidation path) must NOT advance sync_seq,
  // or it would re-sync the same row to the remote every scan tick.
  const before = db
    .prepare(
      `SELECT total_input_tokens AS i, total_output_tokens AS o,
              total_cache_read_tokens AS cr, total_cache_creation_tokens AS cc,
              total_reasoning_tokens AS rt, turn_count AS tc,
              tool_counts AS tj, event_type_counts AS ej
         FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        i: number;
        o: number;
        cr: number;
        cc: number;
        rt: number;
        tc: number;
        tj: string | null;
        ej: string | null;
      }
    | undefined;

  db.prepare(UPDATE_TOTALS_SQL).run(
    sessionId,
    sessionId,
    sessionId,
    sessionId,
    sessionId,
    sessionId,
    sessionId,
  );

  // Compute tool_counts from scanner tool_calls table
  const toolRows = db
    .prepare(
      `SELECT tool_name, COUNT(*) as cnt FROM tool_calls WHERE session_id = ? GROUP BY tool_name`,
    )
    .all(sessionId) as Array<{ tool_name: string; cnt: number }>;

  // Compute event_type_counts from scanner_events (strip "progress:" prefix)
  const eventRows = db
    .prepare(
      `SELECT event_type, COUNT(*) as cnt FROM scanner_events WHERE session_id = ? GROUP BY event_type`,
    )
    .all(sessionId) as Array<{ event_type: string; cnt: number }>;

  const toolCounts: Record<string, number> = {};
  for (const r of toolRows) toolCounts[r.tool_name] = r.cnt;

  const eventCounts: Record<string, number> = {};
  for (const r of eventRows) {
    const key = r.event_type.startsWith("progress:")
      ? r.event_type.slice("progress:".length)
      : r.event_type;
    eventCounts[key] = (eventCounts[key] ?? 0) + r.cnt;
  }

  const hasCounts = toolRows.length > 0 || eventRows.length > 0;
  const newToolCountsJson = hasCounts
    ? JSON.stringify(toolCounts)
    : (before?.tj ?? null);
  const newEventCountsJson = hasCounts
    ? JSON.stringify(eventCounts)
    : (before?.ej ?? null);

  const after = db
    .prepare(
      `SELECT total_input_tokens AS i, total_output_tokens AS o,
              total_cache_read_tokens AS cr, total_cache_creation_tokens AS cc,
              total_reasoning_tokens AS rt, turn_count AS tc
         FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as {
    i: number;
    o: number;
    cr: number;
    cc: number;
    rt: number;
    tc: number;
  };

  const changed =
    !before ||
    before.i !== after.i ||
    before.o !== after.o ||
    before.cr !== after.cr ||
    before.cc !== after.cc ||
    before.rt !== after.rt ||
    before.tc !== after.tc ||
    (before.tj ?? null) !== newToolCountsJson ||
    (before.ej ?? null) !== newEventCountsJson;

  if (hasCounts) {
    // Persist counts; advance sync_seq only when a synced column changed.
    db.prepare(
      changed
        ? `UPDATE sessions
             SET tool_counts = ?, event_type_counts = ?,
                 sync_seq = COALESCE(sync_seq, 0) + 1
             WHERE session_id = ?`
        : `UPDATE sessions
             SET tool_counts = ?, event_type_counts = ?
             WHERE session_id = ?`,
    ).run(newToolCountsJson, newEventCountsJson, sessionId);
  } else if (changed) {
    // No tool/event rows, but token totals changed (e.g. hermes's late
    // aggregate update) — still mark the session for re-sync.
    db.prepare(
      "UPDATE sessions SET sync_seq = COALESCE(sync_seq, 0) + 1 WHERE session_id = ?",
    ).run(sessionId);
  }
  // Scanner produces token data that needs pricing for cost queries
  refreshIfStale().catch(() => {});
}

// ── File watermarks ─────────────────────────────────────────────────────────

/**
 * Returns true when the recorded watermark offset is past the file's
 * current end — i.e. the file was truncated, replaced, or recreated since
 * the last scan. The caller should reset the file's scanner state and
 * re-read from byte 0; without this the next read would skip events
 * (best case) or read garbage offsets (worst case).
 *
 * Pure function so tests don't need fs/db mocks — the loop stats the file
 * and passes the size in.
 *
 * Same-size-different-content (replace with content of the exact same
 * length) is not detected; an inode/mtime check would catch that but
 * requires schema changes. The size check covers truncation and
 * replacement-with-smaller-content, which is the common rotation pattern.
 */
export function shouldResetWatermark(
  fileSize: number,
  watermarkOffset: number,
): boolean {
  return watermarkOffset > 0 && fileSize < watermarkOffset;
}

export function readFileWatermark(filePath: string): FileWatermarkState {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT byte_offset, session_id FROM scanner_file_watermarks WHERE file_path = ?",
    )
    .get(filePath) as
    | {
        byte_offset: number;
        session_id: string | null;
      }
    | undefined;
  return {
    byteOffset: row?.byte_offset ?? 0,
    sessionId: row?.session_id ?? undefined,
  };
}

export function writeFileWatermark(
  filePath: string,
  byteOffset: number,
  sessionId?: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO scanner_file_watermarks (file_path, byte_offset, last_scanned_ms, session_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       byte_offset = excluded.byte_offset,
       last_scanned_ms = excluded.last_scanned_ms,
       session_id = COALESCE(excluded.session_id, scanner_file_watermarks.session_id)`,
  ).run(filePath, byteOffset, Date.now(), sessionId ?? null);
}

/**
 * Reset a single file for full reparse: clear its watermark and delete
 * all turns, messages, tool_calls, and events for the session so the
 * full-file parse can re-insert cleanly (including fork detection).
 *
 * Returns an empty legacy sync-id snapshot object; scanner rows now rebuild
 * deterministic sync IDs directly from their natural keys when re-inserted.
 */
export function resetFileForReparse(
  filePath: string,
  sessionId?: string,
): SavedSyncIds {
  const db = getDb();
  const saved: SavedSyncIds = { turns: [], events: [], toolCalls: [] };

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

  return saved;
}

/**
 * Legacy no-op: scanner rows now compute deterministic sync IDs at insert time.
 */
export function restoreSyncIds(_saved: SavedSyncIds): void {}

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

export function getEventCount(sessionId: string, source: string): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT COUNT(*) as count FROM scanner_events WHERE session_id = ? AND source = ?",
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

// ── Messages & tool calls insert ───────────────────────────────────────────

/** Build a short summary for tool-only assistant messages (no text content). */
function toolUseSummary(toolCalls: ParsedToolCall[]): string {
  return toolCalls
    .map((tc) => {
      let label = "";
      if (tc.inputJson) {
        try {
          const input = JSON.parse(tc.inputJson);
          label =
            input.description ??
            input.command ??
            input.pattern ??
            input.file_path ??
            input.query ??
            input.prompt ??
            input.skill ??
            "";
        } catch {}
      }
      return label ? `[${tc.toolName}: ${label}]` : `[${tc.toolName}]`;
    })
    .join("\n");
}

const INSERT_MESSAGE_SQL = `
  INSERT OR IGNORE INTO messages
    (session_id, ordinal, role, content, timestamp_ms,
     has_thinking, has_tool_use, content_length, is_system,
     model, token_usage, context_tokens, output_tokens,
     has_context_tokens, has_output_tokens, uuid, parent_uuid, sync_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_TOOL_CALL_SQL = `
  INSERT INTO tool_calls
    (message_id, session_id, call_index, tool_name, category, tool_use_id,
     input_json, skill_name, result_content_length, result_content,
     subagent_session_id, duration_ms, sync_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    { contentLength: number; contentRaw: string; timestampMs?: number }
  >,
): void {
  if (messages.length === 0 && !orphanedToolResults?.size) return;
  const db = getDb();
  const seenCwds = new Set<string>();
  const seenRepoDirs = new Set<string>();
  const toolInputAttributions: Array<{
    sessionId: string;
    timestampMs: number;
    toolName: string | undefined;
    inputJson: string | undefined;
  }> = [];

  // Collect all tool results across user messages for backfilling
  const toolResultMap = new Map<
    string,
    { contentLength: number; contentRaw: string; timestampMs?: number }
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
      // Synthesize content for empty assistant messages with tool calls
      let content = msg.content;
      if (!content && msg.role === "assistant" && msg.toolCalls.length > 0) {
        content = toolUseSummary(msg.toolCalls);
      }

      for (const tc of msg.toolCalls) {
        toolInputAttributions.push({
          sessionId: msg.sessionId,
          timestampMs: tc.timestampMs ?? msg.timestampMs ?? Date.now(),
          toolName: tc.toolName,
          inputJson: tc.inputJson,
        });
      }

      const result = msgStmt.run(
        msg.sessionId,
        msg.ordinal,
        msg.role,
        content,
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
        buildMessageSyncId(msg.sessionId, msg.ordinal, msg.uuid),
      );

      // INSERT OR IGNORE returns 0 changes if the row already exists
      if (result.changes === 0) continue;

      const messageId = result.lastInsertRowid;
      const messageSyncId = buildMessageSyncId(
        msg.sessionId,
        msg.ordinal,
        msg.uuid,
      );
      ftsStmt.run(messageId, content);

      for (const [callIndex, tc] of msg.toolCalls.entries()) {
        // Look up result from the tool_result blocks
        const toolResult = toolResultMap.get(tc.toolUseId);
        const durationMs =
          tc.timestampMs && toolResult?.timestampMs
            ? toolResult.timestampMs - tc.timestampMs
            : null;
        tcStmt.run(
          messageId,
          msg.sessionId,
          callIndex,
          tc.toolName,
          tc.category,
          tc.toolUseId,
          tc.inputJson ?? null,
          tc.skillName ?? null,
          toolResult?.contentLength ?? null,
          toolResult?.contentRaw ?? null,
          tc.subagentSessionId ?? null,
          durationMs != null && durationMs >= 0 ? durationMs : null,
          buildToolCallSyncId(messageSyncId, callIndex, tc.toolUseId),
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

  for (const item of toolInputAttributions) {
    attributeSessionPathsFromToolInput(
      item.sessionId,
      item.timestampMs,
      item.inputJson,
      item.toolName,
      seenCwds,
      seenRepoDirs,
    );
  }
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
