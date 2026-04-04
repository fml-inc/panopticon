#!/usr/bin/env npx tsx

/**
 * Local test sync server — runs two independent HTTP endpoints on different
 * ports, each backed by its own SQLite DB. Accepts all sessions (no ACL).
 *
 * Sessions are upserted by sessionId. All other tables blindly insert.
 * This lets us verify multi-target sync produces correct data without
 * server-side dedup masking client-side bugs.
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
import Database from "better-sqlite3";

const PORT_A = 9801;
const PORT_B = 9802;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  data JSON,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000)
);

CREATE TABLE IF NOT EXISTS rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  sessionId TEXT,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000)
);

CREATE INDEX IF NOT EXISTS idx_rows_tbl ON rows(tbl);
CREATE INDEX IF NOT EXISTS idx_rows_session ON rows(sessionId);
CREATE INDEX IF NOT EXISTS idx_rows_tbl_session ON rows(tbl, sessionId);
`;

function createDb(name: string): Database.Database {
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

function createServer(
  name: string,
  port: number,
  db: Database.Database,
): http.Server {
  const upsertSession = db.prepare(
    `INSERT INTO sessions (sessionId, data) VALUES (?, ?)
     ON CONFLICT(sessionId) DO UPDATE SET data = excluded.data, received_at = unixepoch('now','subsec')*1000`,
  );

  const insertRow = db.prepare(
    `INSERT INTO rows (tbl, sessionId, data) VALUES (?, ?, ?)`,
  );

  const server = http.createServer(async (req, res) => {
    // Stats endpoint
    if (req.method === "GET" && req.url === "/stats") {
      const sessions = db
        .prepare("SELECT COUNT(*) as cnt FROM sessions")
        .get() as { cnt: number };
      const tables = db
        .prepare(
          "SELECT tbl, COUNT(*) as cnt FROM rows GROUP BY tbl ORDER BY tbl",
        )
        .all() as Array<{ tbl: string; cnt: number }>;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ name, sessions: sessions.cnt, tables }, null, 2),
      );
      return;
    }

    // Duplicates check endpoint
    if (req.method === "GET" && req.url === "/duplicates") {
      const dupes = db
        .prepare(
          `SELECT tbl, sessionId, json_extract(data, '$.ordinal') as ordinal,
                  json_extract(data, '$.turnIndex') as turnIndex,
                  COUNT(*) as cnt
           FROM rows
           GROUP BY tbl, sessionId, COALESCE(ordinal, turnIndex, id)
           HAVING cnt > 1
           ORDER BY cnt DESC
           LIMIT 50`,
        )
        .all();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name, duplicates: dupes }, null, 2));
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

      if (table === "sessions") {
        const accepted: string[] = [];
        for (const row of rows) {
          const r = row as Record<string, unknown>;
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

      // All other tables: blind insert
      const insert = db.transaction((tableRows: unknown[]) => {
        for (const row of tableRows) {
          const r = row as Record<string, unknown>;
          insertRow.run(
            table,
            (r.sessionId as string) ?? null,
            JSON.stringify(r),
          );
        }
      });
      insert(rows);
      console.log(`[${name}] ${table}: ${rows.length} rows inserted`);

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
console.log(`  GET  http://localhost:${PORT_A}/duplicates`);
console.log(`  GET  http://localhost:${PORT_B}/duplicates`);
console.log("\nCtrl+C to stop\n");

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  serverA.close();
  serverB.close();
  dbA.close();
  dbB.close();
  process.exit(0);
});
