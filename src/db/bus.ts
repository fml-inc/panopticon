/**
 * Agent-to-agent message bus storage. An append-only log of messages between
 * agent sessions sharing a room (workspace). Carries ephemeral events
 * (challenge/activity, consumed once via delivered_at_ms) and the source events
 * for durable state (claim/release, projected elsewhere).
 */

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
  return Number(result.lastInsertRowid);
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
  /** Only messages not yet marked delivered. */
  undeliveredOnly?: boolean;
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
 * Mark messages delivered (consume-once). Only flips rows that are still
 * undelivered, so a re-delivery is a no-op. Layer 2's hook drain uses this for
 * challenge messages; non-consumable kinds (activity) are simply never marked.
 */
export function markDelivered(ids: number[], nowMs: number): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE agent_messages SET delivered_at_ms = ? WHERE id = ? AND delivered_at_ms IS NULL",
  );
  const tx = db.transaction((rows: number[]) => {
    let changed = 0;
    for (const id of rows) changed += stmt.run(nowMs, id).changes;
    return changed;
  });
  return tx(ids) as number;
}
