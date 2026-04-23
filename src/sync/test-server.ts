import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/driver.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  data JSON,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000)
);

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

CREATE TABLE IF NOT EXISTS unknown_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  sessionId TEXT,
  data JSON NOT NULL,
  received_at INTEGER DEFAULT (unixepoch('now','subsec')*1000)
);
`;

const SYNC_ID_TABLES = [
  "tool_calls",
  "hook_events",
  "otel_logs",
  "otel_metrics",
  "scanner_events",
  "scanner_turns",
] as const;

type Row = Record<string, unknown>;

interface UpsertHandler {
  upsert: (rows: Row[]) => number;
}

export interface TestSyncServerDb {
  db: Database;
  dbPath: string;
}

export interface TestSyncFailureRule {
  table?: string;
  remaining: number;
  status?: number;
  body?: Record<string, unknown>;
}

export interface TestSyncServerStats {
  name: string;
  sessions: number;
  tables: Array<{ tbl: string; cnt: number }>;
  syncRequests: number;
  failedSyncRequests: number;
  requestsByTable: Array<{ table: string; count: number }>;
}

export interface TestSyncServerHandle {
  db: Database;
  server: http.Server;
  state: {
    syncRequests: number;
    failedSyncRequests: number;
    requestsByTable: Map<string, number>;
  };
  url: string;
  close: () => Promise<void>;
  stats: () => TestSyncServerStats;
}

interface TestSyncServerLogger {
  error: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
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
          insertStmt.run(sessionId, JSON.stringify(row));
        }
        count += 1;
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
        const keys = keyFields.map(
          (key) => (row[key] as string | number) ?? null,
        );
        stmt.run(...keys, JSON.stringify(row));
        count += 1;
      }
      return count;
    },
  };
}

function buildStats(
  name: string,
  db: Database,
  state: TestSyncServerHandle["state"],
): TestSyncServerStats {
  const sessions = db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as {
    cnt: number;
  };
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

  return {
    name,
    sessions: sessions.cnt,
    tables,
    syncRequests: state.syncRequests,
    failedSyncRequests: state.failedSyncRequests,
    requestsByTable: [...state.requestsByTable.entries()].map(
      ([table, count]) => ({
        table,
        count,
      }),
    ),
  };
}

export function createTestSyncServerDb(
  name: string,
  opts: {
    dir?: string;
    log?: TestSyncServerLogger;
  } = {},
): TestSyncServerDb {
  const log = opts.log ?? console;
  const dir = opts.dir ?? path.join(os.homedir(), ".panopticon-test-sync");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `${name}.db`);
  try {
    fs.unlinkSync(dbPath);
  } catch {}
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  log.log(`  DB: ${dbPath}`);
  return { db, dbPath };
}

export async function startTestSyncServer(opts: {
  db: Database;
  failureRules?: TestSyncFailureRule[];
  log?: TestSyncServerLogger;
  name: string;
  port?: number;
}): Promise<TestSyncServerHandle> {
  const log = opts.log ?? console;
  const rules = (opts.failureRules ?? []).map((rule) => ({ ...rule }));
  const state: TestSyncServerHandle["state"] = {
    syncRequests: 0,
    failedSyncRequests: 0,
    requestsByTable: new Map<string, number>(),
  };

  const upsertSession = opts.db.prepare(
    `INSERT INTO sessions (sessionId, data) VALUES (?, ?)
     ON CONFLICT(sessionId) DO UPDATE SET data = excluded.data, received_at = unixepoch('now','subsec')*1000`,
  );
  const handlers: Record<string, UpsertHandler> = {
    messages: makeNaturalKeyHandler(opts.db, "messages", [
      "sessionId",
      "ordinal",
    ]),
    otel_spans: makeNaturalKeyHandler(opts.db, "otel_spans", [
      "traceId",
      "spanId",
    ]),
    user_config_snapshots: makeNaturalKeyHandler(
      opts.db,
      "user_config_snapshots",
      ["deviceName", "contentHash"],
    ),
    repo_config_snapshots: makeNaturalKeyHandler(
      opts.db,
      "repo_config_snapshots",
      ["repository", "contentHash"],
    ),
  };
  for (const table of SYNC_ID_TABLES) {
    handlers[table] = makeSyncIdHandler(opts.db, table);
  }
  const insertUnknown = opts.db.prepare(
    `INSERT INTO unknown_rows (tbl, sessionId, data) VALUES (?, ?, ?)`,
  );

  const consumeFailure = (table: string) => {
    const rule = rules.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (candidate.table === undefined || candidate.table === table),
    );
    if (!rule) return null;
    rule.remaining -= 1;
    state.failedSyncRequests += 1;
    return {
      status: rule.status ?? 503,
      body: rule.body ?? { error: `synthetic sync failure for ${table}` },
    };
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildStats(opts.name, opts.db, state), null, 2));
      return;
    }

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
        rows?: unknown[];
        table?: string;
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

      const { rows, table } = body;
      state.syncRequests += 1;
      state.requestsByTable.set(
        table,
        (state.requestsByTable.get(table) ?? 0) + 1,
      );

      const failure = consumeFailure(table);
      if (failure) {
        log.log(`[${opts.name}] ${table}: synthetic ${failure.status}`);
        res.writeHead(failure.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(failure.body));
        return;
      }

      if (table === "sessions") {
        const accepted: string[] = [];
        for (const row of rows) {
          const sessionId = (row as Row).sessionId as string;
          if (!sessionId) continue;
          upsertSession.run(sessionId, JSON.stringify(row));
          accepted.push(sessionId);
        }
        log.log(`[${opts.name}] sessions: ${accepted.length} upserted`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted }));
        return;
      }

      const handler = handlers[table];
      if (handler) {
        const tx = opts.db.transaction((tableRows: Row[]) =>
          handler.upsert(tableRows),
        );
        const count = tx(rows as Row[]);
        log.log(`[${opts.name}] ${table}: ${count} rows upserted`);
      } else {
        const tx = opts.db.transaction((tableRows: unknown[]) => {
          for (const row of tableRows) {
            const record = row as Row;
            insertUnknown.run(
              table,
              (record.sessionId as string) ?? null,
              JSON.stringify(record),
            );
          }
        });
        tx(rows);
        log.log(
          `[${opts.name}] ${table}: ${rows.length} rows inserted (unknown table)`,
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    } catch (err) {
      log.error(`[${opts.name}] Error:`, err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "Internal error",
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("synthetic sync server failed to bind");
  }
  const url = `http://127.0.0.1:${address.port}`;
  log.log(`  ${opts.name} listening on ${url}`);

  return {
    db: opts.db,
    server,
    state,
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    stats: () => buildStats(opts.name, opts.db, state),
  };
}
