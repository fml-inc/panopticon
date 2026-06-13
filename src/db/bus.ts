/**
 * Agent-to-agent message bus storage. An append-only log of messages between
 * agent sessions sharing a room (workspace). Carries ephemeral events
 * (challenge/activity, consumed once via delivered_at_ms) and the source events
 * for durable state (claim/release, projected elsewhere).
 */

import { broadcast, hasClients } from "../ui/events.js";
import { getDb } from "./schema.js";

const MESSAGE_COLUMNS =
  "id, room, from_session, to_session, kind, body, subject, ref_tool, ref_path, source, created_at_ms, delivered_at_ms";

export interface AgentMessageInsert {
  room: string;
  from_session: string;
  to_session?: string | null;
  kind: string;
  body: string;
  subject?: string | null;
  ref_tool?: string | null;
  ref_path?: string | null;
  source?: string | null;
  created_at_ms: number;
}

export interface AgentMessageRow {
  id: number;
  room: string;
  from_session: string;
  to_session: string | null;
  kind: string;
  body: string;
  subject: string | null;
  ref_tool: string | null;
  ref_path: string | null;
  source: string | null;
  created_at_ms: number;
  delivered_at_ms: number | null;
}

export function insertAgentMessage(row: AgentMessageInsert): number {
  const result = getDb()
    .prepare(
      `INSERT INTO agent_messages
         (room, from_session, to_session, kind, body, subject,
          ref_tool, ref_path, source, created_at_ms)
       VALUES
         (@room, @from_session, @to_session, @kind, @body, @subject,
          @ref_tool, @ref_path, @source, @created_at_ms)`,
    )
    .run({
      room: row.room,
      from_session: row.from_session,
      to_session: row.to_session ?? null,
      kind: row.kind,
      body: row.body,
      subject: row.subject ?? null,
      ref_tool: row.ref_tool ?? null,
      ref_path: row.ref_path ?? null,
      source: row.source ?? null,
      created_at_ms: row.created_at_ms,
    });
  const id = Number(result.lastInsertRowid);

  // Push to any connected Mission Control dashboard. Cross-room: the dashboard
  // shows the whole fleet, so we broadcast regardless of room. Never throws into
  // the caller — a UI listener error must not break a bus write.
  if (hasClients()) {
    try {
      broadcast({
        type: "message",
        data: {
          id,
          room: row.room,
          from_session: row.from_session,
          to_session: row.to_session ?? null,
          kind: row.kind,
          body: row.body,
          subject: row.subject ?? null,
          ref_tool: row.ref_tool ?? null,
          ref_path: row.ref_path ?? null,
          source: row.source ?? null,
          created_at_ms: row.created_at_ms,
        },
      });
    } catch {
      // ignore
    }
  }

  return id;
}

export interface ReadMessagesOptions {
  room: string;
  /** Only messages with id greater than this cursor. */
  sinceId?: number;
  /** Restrict to these kinds. */
  kinds?: string[];
  /** Address filter: include broadcasts (to_session NULL) and messages to this session. */
  toSession?: string;
  /** Exclude messages sent by this session (so a reader never sees its own). */
  excludeFrom?: string;
  /** Only messages globally undelivered (legacy 1:1 gate; prefer undeliveredTo). */
  undeliveredOnly?: boolean;
  /** Exclude messages already delivered to THIS session (per-recipient gate). */
  undeliveredTo?: string;
  /** Only messages created at or after this time (e.g. the reader's join time). */
  sinceMs?: number;
  /** Max rows (default 200, capped 1000). */
  limit?: number;
}

export function readAgentMessages(
  opts: ReadMessagesOptions,
): AgentMessageRow[] {
  const clauses: string[] = ["room = @room"];
  const params: Record<string, unknown> = { room: opts.room };

  if (typeof opts.sinceId === "number") {
    clauses.push("id > @sinceId");
    params.sinceId = opts.sinceId;
  }
  if (opts.kinds && opts.kinds.length > 0) {
    const placeholders = opts.kinds.map((_, i) => `@kind${i}`);
    clauses.push(`kind IN (${placeholders.join(", ")})`);
    opts.kinds.forEach((k, i) => {
      params[`kind${i}`] = k;
    });
  }
  if (opts.toSession) {
    clauses.push("(to_session IS NULL OR to_session = @toSession)");
    params.toSession = opts.toSession;
  }
  if (opts.excludeFrom) {
    clauses.push("from_session <> @excludeFrom");
    params.excludeFrom = opts.excludeFrom;
  }
  if (opts.undeliveredOnly) {
    clauses.push("delivered_at_ms IS NULL");
  }
  if (opts.undeliveredTo) {
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM agent_message_deliveries d
                    WHERE d.message_id = agent_messages.id
                      AND d.session_id = @undeliveredTo)`,
    );
    params.undeliveredTo = opts.undeliveredTo;
  }
  if (typeof opts.sinceMs === "number") {
    // Backlog gate for BROADCASTS only: a fresh reader shouldn't drain room
    // history posted before it joined. Messages directed to the reader are its
    // mail — always delivered, regardless of join time.
    clauses.push(
      opts.toSession
        ? "(to_session = @toSession OR created_at_ms >= @sinceMs)"
        : "created_at_ms >= @sinceMs",
    );
    params.sinceMs = opts.sinceMs;
  }

  params.limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 200)), 1000);

  // Without a cursor, a fresh reader wants the NEWEST N (the present), so tail
  // the log with DESC + LIMIT and flip back to ascending. With a cursor, page
  // forward in ascending id order from where the reader left off.
  const tailMode = typeof opts.sinceId !== "number";
  const rows = getDb()
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM agent_messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY id ${tailMode ? "DESC" : "ASC"}
         LIMIT @limit`,
    )
    .all(params) as AgentMessageRow[];
  return tailMode ? rows.reverse() : rows;
}

/**
 * Mark messages delivered to one recipient session (group-chat consume-once).
 * Records a row per (message, session) so a broadcast delivered to session A is
 * still pending for session B. Idempotent: re-delivering to the same session is
 * a no-op. Returns the number of newly-recorded deliveries.
 */
export function markDelivered(
  ids: number[],
  sessionId: string,
  nowMs: number,
): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO agent_message_deliveries (message_id, session_id, delivered_at_ms)
     VALUES (?, ?, ?)`,
  );
  const deliveredIds: number[] = [];
  const tx = db.transaction((rows: number[]) => {
    for (const id of rows) {
      if (stmt.run(id, sessionId, nowMs).changes > 0) deliveredIds.push(id);
    }
    return deliveredIds.length;
  });
  const changed = tx(ids) as number;

  // Notify Mission Control so the feed can flip these messages to delivered.
  // Per-recipient now, so carry the session it was delivered to.
  if (changed > 0 && hasClients()) {
    try {
      broadcast({
        type: "delivery",
        data: {
          ids: deliveredIds,
          session_id: sessionId,
          delivered_at_ms: nowMs,
        },
      });
    } catch {
      // ignore
    }
  }

  return changed;
}
