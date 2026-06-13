/**
 * `panopticon chat` — live agent-to-agent conversation over the bus.
 *
 * The model is ClawChat's: a real agent participates by spending a turn blocked
 * in `chat wait` (a long-poll) until a peer message arrives, then replies with
 * `chat send`. Send → wait → receive → respond → wait. No orchestrator wakes an
 * idle agent; the agent makes itself a listener by blocking in the wait.
 *
 * Panopticon's edge over a bare chat transport: identity is automatic (resolved
 * from the process ancestry), the delivery table guarantees no message is missed
 * between turns, and `wait`'s heartbeat surfaces the peer's REAL activity from
 * the observability layer — so a blocked agent can tell "peer is working" from
 * "peer is gone" without the peer having to narrate.
 */

import type { AgentMessageRow } from "../db/bus.js";
import type {
  BusReadInput,
  BusReadResult,
  BusRosterInput,
  InstancesResult,
  WaitForActivityInput,
  WaitForActivityResult,
} from "../service/types.js";

/** Subset of the service the chat loop needs (injectable for tests). */
export interface ChatDeps {
  busRead: (input: BusReadInput) => Promise<BusReadResult>;
  waitForActivity: (
    input: WaitForActivityInput,
  ) => Promise<WaitForActivityResult>;
  busRoster: (input: BusRosterInput) => Promise<InstancesResult>;
  now: () => number;
  /** Emit a liveness/heartbeat line (stderr in the CLI). */
  onHeartbeat: (line: string) => void;
}

export interface ChatWaitOptions {
  room: string;
  /** Caller's session id — excludes own messages, addresses directed mail. */
  selfSession?: string;
  /** Only return messages from this peer session. */
  onlyFrom?: string;
  /** Start cursor: only messages with id greater than this. */
  sinceId: number;
  /** Per server long-poll, ms (clamped server-side). */
  longPollMs?: number;
  /** Overall budget before returning timedOut so the caller can re-invoke. */
  budgetMs?: number;
  /** Heartbeat cadence to stderr, ms. */
  heartbeatMs?: number;
}

export interface ChatWaitResult {
  messages: AgentMessageRow[];
  /** Highest message id seen — pass back as sinceId on the next wait. */
  cursor: number;
  timedOut: boolean;
}

const DEFAULT_LONG_POLL_MS = 25_000;
const DEFAULT_BUDGET_MS = 540_000; // under the 600s Bash-tool ceiling
const DEFAULT_HEARTBEAT_MS = 30_000;

/** Relative-time helper for liveness lines: 1500 -> "1s", 65000 -> "1m". */
export function formatAgo(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/**
 * A one-line liveness summary of the OTHER agents in the room, drawn from
 * presence — the panopticon advantage: a blocked agent sees the peer is alive
 * and what state it's in without the peer narrating.
 */
export function formatPeerLiveness(
  roster: InstancesResult,
  selfSession: string | undefined,
  nowMs: number,
): string {
  const peers = roster.instances.filter(
    (i) =>
      i.session_id !== selfSession &&
      i.role !== "frenemy" &&
      i.status !== "exited",
  );
  if (peers.length === 0) return "no other agents in the room";
  return peers
    .map((p) => {
      const who = p.session_id.slice(0, 8);
      const ago = formatAgo(Math.max(0, nowMs - p.last_seen_ms));
      return `${who} ${p.status} (last seen ${ago})`;
    })
    .join(", ");
}

/**
 * Block until a new chat message (not the caller's own) lands in the room, or
 * the budget expires. Re-polls across server long-polls so it survives minutes,
 * emitting a peer-liveness heartbeat between polls. Returns the new message(s)
 * and an advanced cursor.
 */
export async function runChatWait(
  opts: ChatWaitOptions,
  deps: ChatDeps,
): Promise<ChatWaitResult> {
  const longPollMs = opts.longPollMs ?? DEFAULT_LONG_POLL_MS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const startedAt = deps.now();
  const deadline = startedAt + budgetMs;

  let cursor = opts.sinceId;
  // Only wake on room activity newer than now, so a backlog of stale hook
  // events doesn't spin the loop.
  let activityCursor = startedAt;
  let lastHeartbeat = startedAt;

  while (deps.now() < deadline) {
    const read = await deps.busRead({
      room: opts.room,
      session_id: opts.selfSession,
      sinceId: cursor,
      kinds: ["chat"],
      limit: 50,
    });
    cursor = Math.max(cursor, read.cursor);
    const incoming = opts.onlyFrom
      ? read.messages.filter((m) => m.from_session === opts.onlyFrom)
      : read.messages;
    if (incoming.length > 0) {
      return { messages: incoming, cursor, timedOut: false };
    }

    const remaining = deadline - deps.now();
    if (remaining <= 0) break;
    const res = await deps.waitForActivity({
      room: opts.room,
      sinceMs: activityCursor,
      timeoutMs: Math.min(longPollMs, Math.max(1000, remaining)),
    });
    if (res.activityMs != null) activityCursor = res.activityMs;

    const now = deps.now();
    if (now - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now;
      try {
        const roster = await deps.busRoster({ room: opts.room });
        deps.onHeartbeat(
          `waiting ${formatAgo(now - startedAt).replace(" ago", "")} · ${formatPeerLiveness(roster, opts.selfSession, now)}`,
        );
      } catch {
        deps.onHeartbeat(`waiting ${formatAgo(now - startedAt)}`);
      }
    }
  }
  return { messages: [], cursor, timedOut: true };
}

/** Render a received chat message for the agent (text form). */
export function formatMessage(m: AgentMessageRow): string {
  const who = m.from_session.slice(0, 8);
  const to = m.to_session ? " (→ you)" : "";
  return `#${m.id} ${who}${to}: ${m.body}`;
}
