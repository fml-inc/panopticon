import { config } from "../config.js";

interface SessionState {
  id: string;
  lastRequestMs: number;
  lastMessageCount: number;
  seq: number;
}

export class SessionTracker {
  private sessions = new Map<string, SessionState>();

  getOrCreateSession(
    target: string,
    requestBody?: unknown,
  ): { sessionId: string; isNew: boolean } {
    const now = Date.now();
    const existing = this.sessions.get(target);
    const messageCount = countMessages(requestBody);

    // Detect new session from conversation context
    if (existing) {
      const isReset = this.isConversationReset(existing, messageCount, now);
      if (!isReset) {
        existing.lastRequestMs = now;
        if (messageCount > 0) existing.lastMessageCount = messageCount;
        return { sessionId: existing.id, isNew: false };
      }
    }

    // New session
    const seq = existing ? existing.seq + 1 : 1;
    const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
    const sessionId = `${target}-${date}-${String(seq).padStart(3, "0")}`;

    this.sessions.set(target, {
      id: sessionId,
      lastRequestMs: now,
      lastMessageCount: messageCount,
      seq,
    });
    return { sessionId, isNew: true };
  }

  private isConversationReset(
    state: SessionState,
    messageCount: number,
    now: number,
  ): boolean {
    // Context-based detection: if message count drops significantly,
    // the conversation was cleared/reset. A request with <= 2 messages
    // (system + user) after a longer conversation is a strong reset signal.
    if (messageCount > 0 && state.lastMessageCount > 3 && messageCount <= 2) {
      return true;
    }

    // Significant drop in message count (more than halved and dropped by 3+)
    if (
      messageCount > 0 &&
      state.lastMessageCount > 0 &&
      messageCount < state.lastMessageCount / 2 &&
      state.lastMessageCount - messageCount >= 3
    ) {
      return true;
    }

    // Fallback: idle timeout
    if (now - state.lastRequestMs >= config.proxyIdleSessionMs) {
      return true;
    }

    return false;
  }
}

/** Count non-system messages in a chat request body. */
function countMessages(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return 0;

  // Count only non-system messages — system messages don't indicate
  // conversation depth and are present in every request
  return messages.filter((m: Record<string, unknown>) => m.role !== "system")
    .length;
}
