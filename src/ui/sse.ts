/**
 * Server-Sent Events endpoint for Mission Control (`GET /api/events`).
 *
 * One long-lived response per connected dashboard. EventSource can't set
 * request headers, so the bearer token rides as a `?token=` query param —
 * acceptable on the localhost-only server, matching the existing auth boundary.
 * Initial state is fetched by the client over `/api/tool`; this stream carries
 * only deltas (presence + bus events) via ./events.ts.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { addClient, removeClient } from "./events.js";

const KEEPALIVE_MS = 15_000;

function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function handleEventStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  expectedToken: string,
): void {
  const url = new URL(req.url ?? "", "http://127.0.0.1");
  if (!tokenMatches(url.searchParams.get("token"), expectedToken)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering so events flush immediately.
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  addClient(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // Write failure means the socket is gone; cleanup runs on "close".
    }
  }, KEEPALIVE_MS);
  keepAlive.unref();

  req.on("close", () => {
    clearInterval(keepAlive);
    removeClient(res);
  });
}
