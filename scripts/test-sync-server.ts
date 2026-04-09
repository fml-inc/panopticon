#!/usr/bin/env npx tsx

/**
 * Local test sync server — runs two independent HTTP endpoints on different
 * ports, each backed by its own SQLite DB. Accepts all sessions (no ACL).
 *
 * Tables are upserted using natural keys where available, or (sessionId, syncId)
 * for tables that lack a natural unique key. Rows without a syncId (old clients)
 * fall back to blind insert.
 *
 * Usage:
 *   npx tsx scripts/test-sync-server.ts
 *
 * Then add targets:
 *   panopticon sync add-target --name local-a --url http://localhost:9801 --token test
 *   panopticon sync add-target --name local-b --url http://localhost:9802 --token test
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/driver.js";

const PORT_A = 9801;
const PORT_B = 9802;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  data JSON,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000)
);

-- Natural key tables
CREATE TABLE IF NOT EXISTS messages (
  sessionId TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(sessionId, ordinal)
);

CREATE TABLE IF NOT EXISTS otel_spans (
  traceId TEXT NOT NULL,
  spanId TEXT NOT NULL,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(traceId, spanId)
);

CREATE TABLE IF NOT EXISTS user_config_snapshots (
  deviceName TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(deviceName, contentHash)
);

CREATE TABLE IF NOT EXISTS repo_config_snapshots (
  repository TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(repository, contentHash)
);

-- sync_id tables
CREATE TABLE IF NOT EXISTS tool_calls (
  sessionId TEXT NOT NULL,
  syncId TEXT,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(sessionId, syncId)
);

CREATE TABLE IF NOT EXISTS hook_events (
  sessionId TEXT NOT NULL,
  syncId TEXT,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(sessionId, syncId)
);

CREATE TABLE IF NOT EXISTS otel_logs (
  sessionId TEXT NOT NULL,
  syncId TEXT,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(sessionId, syncId)
);

CREATE TABLE IF NOT EXISTS otel_metrics (
  sessionId TEXT NOT NULL,
  syncId TEXT,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(sessionId, syncId)
);

CREATE TABLE IF NOT EXISTS scanner_events (
  sessionId TEXT NOT NULL,
  syncId TEXT,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(sessionId, syncId)
);

CREATE TABLE IF NOT EXISTS scanner_turns (
  sessionId TEXT NOT NULL,
  syncId TEXT,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000),
  UNIQUE(sessionId, syncId)
);

-- Fallback for unknown tables
CREATE TABLE IF NOT EXISTS unknown_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  sessionId TEXT,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000)
);
`;

// ── Upsert helpers ──────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface UpsertHandler {
  upsert: (rows: Row[]) => number;
}

function makeSyncIdHandler(db: Database, table: string): UpsertHandler {
  const upsertStmt = db.prepare(
    `INSERT INTO ${table} (sessionId, syncId, data) VALUES (?, ?, ?)
     ON CONFLICT(sessionId, syncId) DO UPDATE SET data = excluded.data, received_at = unixepoch('now','subsec')*1000`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO ${table} (sessionId, syncId, data) VALUES (?, NULL, ?)`,
  );

  return {
    upsert: (rows: Row[]) => {
      let count = 0;
      for (const row of rows) {
        const sessionId = (row.sessionId as string) ?? null;
        const syncId = (row.syncId as string) ?? null;
        if (syncId) {
          upsertStmt.run(sessionId, syncId, JSON.stringify(row));
        } else {
          // No syncId — blind insert (backward compat)
          insertStmt.run(sessionId, JSON.stringify(row));
        }
        count++;
      }
      return count;
    },
  };
}

function makeNaturalKeyHandler(
  db: Database,
  table: string,
  keyFields: string[],
): UpsertHandler {
  const cols = keyFields.join(", ");
  const placeholders = keyFields.map(() => "?").join(", ");
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols}, data) VALUES (${placeholders}, ?)
     ON CONFLICT(${cols}) DO UPDATE SET data = excluded.data, received_at = unixepoch('now','subsec')*1000`,
  );

  return {
    upsert: (rows: Row[]) => {
      let count = 0;
      for (const row of rows) {
        const keys = keyFields.map((k) => (row[k] as string | number) ?? null);
        stmt.run(...keys, JSON.stringify(row));
        count++;
      }
      return count;
    },
  };
}

// ── Server ──────────────────────────────────────────────────────────────────

const SYNC_ID_TABLES = [
  "tool_calls",
  "hook_events",
  "otel_logs",
  "otel_metrics",
  "scanner_events",
  "scanner_turns",
];

function createDb(name: string): Database {
  const dir = path.join(os.homedir(), ".panopticon-test-sync");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `${name}.db`);
  // Start fresh each run
  try {
    fs.unlinkSync(dbPath);
  } catch {}
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  console.log(`  DB: ${dbPath}`);
  return db;
}

function createServer(name: string, port: number, db: Database): http.Server {
  // Build handler map
  const upsertSession = db.prepare(
    `INSERT INTO sessions (sessionId, data) VALUES (?, ?)
     ON CONFLICT(sessionId) DO UPDATE SET data = excluded.data, received_at = unixepoch('now','subsec')*1000`,
  );

  const handlers: Record<string, UpsertHandler> = {
    messages: makeNaturalKeyHandler(db, "messages", ["sessionId", "ordinal"]),
    otel_spans: makeNaturalKeyHandler(db, "otel_spans", ["traceId", "spanId"]),
    user_config_snapshots: makeNaturalKeyHandler(db, "user_config_snapshots", [
      "deviceName",
      "contentHash",
    ]),
    repo_config_snapshots: makeNaturalKeyHandler(db, "repo_config_snapshots", [
      "repository",
      "contentHash",
    ]),
  };

  for (const table of SYNC_ID_TABLES) {
    handlers[table] = makeSyncIdHandler(db, table);
  }

  const insertUnknown = db.prepare(
    `INSERT INTO unknown_rows (tbl, sessionId, data) VALUES (?, ?, ?)`,
  );

  const server = http.createServer(async (req, res) => {
    // Stats endpoint
    if (req.method === "GET" && req.url === "/stats") {
      const sessions = db
        .prepare("SELECT COUNT(*) as cnt FROM sessions")
        .get() as { cnt: number };

      const knownTables = [
        "messages",
        "otel_spans",
        "user_config_snapshots",
        "repo_config_snapshots",
        ...SYNC_ID_TABLES,
      ];
      const tables: Array<{ tbl: string; cnt: number }> = [];
      for (const tbl of knownTables) {
        const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${tbl}`).get() as {
          cnt: number;
        };
        if (row.cnt > 0) tables.push({ tbl, cnt: row.cnt });
      }
      const unknownRow = db
        .prepare("SELECT COUNT(*) as cnt FROM unknown_rows")
        .get() as { cnt: number };
      if (unknownRow.cnt > 0)
        tables.push({ tbl: "unknown_rows", cnt: unknownRow.cnt });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ name, sessions: sessions.cnt, tables }, null, 2),
      );
      return;
    }

    // Only handle POST /v1/sync
    if (req.method !== "POST" || req.url !== "/v1/sync") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        table?: string;
        rows?: unknown[];
      };

      if (!body.table || !Array.isArray(body.rows)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Expected {table: string, rows: unknown[]}",
          }),
        );
        return;
      }

      const { table, rows } = body;

      // Sessions: special handling (returns accepted list)
      if (table === "sessions") {
        const accepted: string[] = [];
        for (const row of rows) {
          const r = row as Row;
          const sessionId = r.sessionId as string;
          if (!sessionId) continue;
          upsertSession.run(sessionId, JSON.stringify(r));
          accepted.push(sessionId);
        }
        console.log(`[${name}] sessions: ${accepted.length} upserted`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted }));
        return;
      }

      // Known tables: dispatch to handler
      const handler = handlers[table];
      if (handler) {
        const tx = db.transaction((tableRows: Row[]) =>
          handler.upsert(tableRows),
        );
        const count = tx(rows as Row[]);
        console.log(`[${name}] ${table}: ${count} rows upserted`);
      } else {
        // Unknown table: blind insert
        const tx = db.transaction((tableRows: unknown[]) => {
          for (const row of tableRows) {
            const r = row as Row;
            insertUnknown.run(
              table,
              (r.sessionId as string) ?? null,
              JSON.stringify(r),
            );
          }
        });
        tx(rows);
        console.log(
          `[${name}] ${table}: ${rows.length} rows inserted (unknown table)`,
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    } catch (err) {
      console.error(`[${name}] Error:`, err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "Internal error",
        }),
      );
    }
  });

  server.listen(port, () => {
    console.log(`  ${name} listening on http://localhost:${port}`);
  });

  return server;
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log("\nStarting test sync servers...\n");

const dbA = createDb("target-a");
const dbB = createDb("target-b");

const serverA = createServer("target-a", PORT_A, dbA);
const serverB = createServer("target-b", PORT_B, dbB);

console.log("\nEndpoints:");
console.log(`  POST http://localhost:${PORT_A}/v1/sync  (target-a)`);
console.log(`  POST http://localhost:${PORT_B}/v1/sync  (target-b)`);
console.log(`  GET  http://localhost:${PORT_A}/stats`);
console.log(`  GET  http://localhost:${PORT_B}/stats`);
console.log("\nCtrl+C to stop\n");

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  serverA.close();
  serverB.close();
  dbA.close();
  dbB.close();
  process.exit(0);
});
