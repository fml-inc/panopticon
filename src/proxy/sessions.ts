import { config } from "../config.js";

export class SessionTracker {
  private sessions = new Map<
    string,
    { id: string; lastRequestMs: number; seq: number }
  >();

  getOrCreateSession(vendor: string): { sessionId: string; isNew: boolean } {
    const now = Date.now();
    const existing = this.sessions.get(vendor);

    if (existing && now - existing.lastRequestMs < config.proxyIdleSessionMs) {
      existing.lastRequestMs = now;
      return { sessionId: existing.id, isNew: false };
    }

    // New session — idle gap exceeded or first request
    const seq = existing ? existing.seq + 1 : 1;
    const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
    const sessionId = `${vendor}-${date}-${String(seq).padStart(3, "0")}`;

    this.sessions.set(vendor, { id: sessionId, lastRequestMs: now, seq });
    return { sessionId, isNew: true };
  }
}
