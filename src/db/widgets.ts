import crypto from "node:crypto";
import { rawQuery } from "./query.js";
import { getDb } from "./schema.js";

export interface Widget {
  id: string;
  type: "chart" | "table" | "kpi" | "markdown";
  title: string;
  query: string;
  config: string; // JSON string
  position: number;
  group_name: string | null;
  status: "active" | "pending";
  chat_id: string | null;
  created_at: number;
  updated_at: number;
}

export function listWidgets(opts?: {
  status?: string;
  chat_id?: string;
}): Widget[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts?.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts?.chat_id) {
    clauses.push("chat_id = ?");
    params.push(opts.chat_id);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT * FROM widgets${where} ORDER BY position ASC, created_at DESC`,
    )
    .all(...params) as Widget[];
}

export function getWidget(id: string): Widget | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM widgets WHERE id = ?").get(id) as Widget) ?? null
  );
}

export function createWidget(opts: {
  type: "chart" | "table" | "kpi" | "markdown";
  title: string;
  query: string;
  config?: Record<string, any>;
  position?: number;
  group_name?: string;
  status?: "active" | "pending";
  chat_id?: string;
}): Widget {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  const config = JSON.stringify(opts.config ?? {});
  const position = opts.position ?? 0;
  const group_name = opts.group_name ?? null;
  const status = opts.status ?? "active";
  const chat_id = opts.chat_id ?? null;

  // Validate query is read-only
  const trimmed = opts.query.trim().toUpperCase();
  if (
    !trimmed.startsWith("SELECT") &&
    !trimmed.startsWith("WITH") &&
    !trimmed.startsWith("PRAGMA")
  ) {
    throw new Error(
      "Only SELECT, WITH, and PRAGMA statements are allowed in widget queries",
    );
  }

  db.prepare(
    "INSERT INTO widgets (id, type, title, query, config, position, group_name, status, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    opts.type,
    opts.title,
    opts.query,
    config,
    position,
    group_name,
    status,
    chat_id,
    now,
    now,
  );

  return {
    id,
    type: opts.type,
    title: opts.title,
    query: opts.query,
    config,
    position,
    group_name,
    status,
    chat_id,
    created_at: now,
    updated_at: now,
  };
}

export function updateWidget(
  id: string,
  opts: {
    title?: string;
    query?: string;
    config?: Record<string, any>;
    position?: number;
    group_name?: string | null;
    status?: "active" | "pending";
  },
): Widget | null {
  const db = getDb();
  const existing = getWidget(id);
  if (!existing) return null;

  const now = Date.now();
  const title = opts.title ?? existing.title;
  const query = opts.query ?? existing.query;
  const config = opts.config ? JSON.stringify(opts.config) : existing.config;
  const position = opts.position ?? existing.position;
  const group_name =
    opts.group_name !== undefined ? opts.group_name : existing.group_name;
  const status = opts.status ?? existing.status;

  if (opts.query) {
    const trimmed = opts.query.trim().toUpperCase();
    if (
      !trimmed.startsWith("SELECT") &&
      !trimmed.startsWith("WITH") &&
      !trimmed.startsWith("PRAGMA")
    ) {
      throw new Error(
        "Only SELECT, WITH, and PRAGMA statements are allowed in widget queries",
      );
    }
  }

  db.prepare(
    "UPDATE widgets SET title = ?, query = ?, config = ?, position = ?, group_name = ?, status = ?, updated_at = ? WHERE id = ?",
  ).run(title, query, config, position, group_name, status, now, id);

  return {
    ...existing,
    title,
    query,
    config,
    position,
    group_name,
    status,
    updated_at: now,
  };
}

export function promoteWidget(id: string, groupName?: string): Widget | null {
  return updateWidget(id, {
    status: "active",
    group_name: groupName ?? undefined,
  });
}

export function deleteWidget(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM widgets WHERE id = ?").run(id);
  return result.changes > 0;
}

export function executeWidgetQuery(id: string): {
  columns: string[];
  rows: any[];
} {
  const widget = getWidget(id);
  if (!widget) throw new Error(`Widget ${id} not found`);

  const rows = rawQuery(widget.query) as Record<string, any>[];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}
