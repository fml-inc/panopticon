import crypto from "node:crypto";
import { getDb } from "./schema.js";

export interface Chat {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessage {
  id: number;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: string | null;
  cost: number | null;
  created_at: number;
}

export function listChats(): Chat[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM chats ORDER BY updated_at DESC")
    .all() as Chat[];
}

export function getChat(id: string): Chat | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as Chat) ?? null
  );
}

export function createChat(title?: string): Chat {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  const t = title || "New Chat";

  db.prepare(
    "INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, t, now, now);

  return { id, title: t, created_at: now, updated_at: now };
}

export function updateChat(id: string, opts: { title?: string }): Chat | null {
  const db = getDb();
  const existing = getChat(id);
  if (!existing) return null;

  const now = Date.now();
  const title = opts.title ?? existing.title;

  db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(
    title,
    now,
    id,
  );

  return { ...existing, title, updated_at: now };
}

export function deleteChat(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getChatMessages(chatId: string): ChatMessage[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC",
    )
    .all(chatId) as ChatMessage[];
}

export function addChatMessage(
  chatId: string,
  opts: {
    role: "user" | "assistant";
    content: string;
    tool_calls?: string;
    cost?: number;
  },
): ChatMessage {
  const db = getDb();
  const now = Date.now();

  // Touch parent chat's updated_at
  db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, chatId);

  const result = db
    .prepare(
      "INSERT INTO chat_messages (chat_id, role, content, tool_calls, cost, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      chatId,
      opts.role,
      opts.content,
      opts.tool_calls ?? null,
      opts.cost ?? null,
      now,
    );

  return {
    id: Number(result.lastInsertRowid),
    chat_id: chatId,
    role: opts.role,
    content: opts.content,
    tool_calls: opts.tool_calls ?? null,
    cost: opts.cost ?? null,
    created_at: now,
  };
}
