/**
 * Mission Control event broadcaster — a tiny in-process pub/sub over the set of
 * connected SSE clients. Presence and (later) bus code call `broadcast(...)`
 * without knowing anything about HTTP; the SSE handler (see ./sse.ts) registers
 * and unregisters the underlying responses.
 *
 * The event union is deliberately open-ended so the dashboard can grow into a
 * fully-featured app (sessions, costs, rebuild progress) without reworking the
 * transport: add a variant here, emit it from the relevant subsystem, handle it
 * in the client.
 */

import type http from "node:http";
import type { InstanceView } from "../presence/store.js";

export type UiEvent =
  /** Presence change: an instance was upserted (heartbeat) or ended (exit). */
  | { type: "instance"; data: InstanceView }
  /** Bus message appended (Layer 1 `agent_messages`). Typed loosely until the
   *  bus lands so this module has no dependency on Layer 1. */
  | { type: "message"; data: Record<string, unknown> }
  /** Bus messages drained/delivered into an agent (Layer 2). Carries the ids
   *  that flipped to delivered so the feed can mark them. */
  | {
      type: "delivery";
      data: { ids: number[]; session_id?: string; delivered_at_ms: number };
    };

const clients = new Set<http.ServerResponse>();

/** Register an SSE response to receive future events. */
export function addClient(res: http.ServerResponse): void {
  clients.add(res);
}

/** Stop sending events to a response (on disconnect). */
export function removeClient(res: http.ServerResponse): void {
  clients.delete(res);
}

/** True if any dashboard is connected. Hot paths (e.g. the hook ingest that
 *  upserts presence) check this to skip read-back work when no UI is open. */
export function hasClients(): boolean {
  return clients.size > 0;
}

export function clientCount(): number {
  return clients.size;
}

/**
 * Fan an event out to every connected client as a named SSE frame. Never throws
 * into the caller: a write to a half-closed socket just drops that client.
 */
export function broadcast(event: UiEvent): void {
  if (clients.size === 0) return;
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}
