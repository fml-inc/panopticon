#!/usr/bin/env npx tsx

/**
 * Local test sync server — runs two independent HTTP endpoints on different
 * ports, each backed by its own SQLite DB. Accepts all sessions by default.
 *
 * Optional failure injection:
 *   PANOPTICON_TEST_SYNC_FAIL_FIRST_REQUESTS=1
 *   PANOPTICON_TEST_SYNC_FAIL_FIRST_SESSIONS_REQUESTS=1
 *   PANOPTICON_TEST_SYNC_FAIL_STATUS=503
 *
 * Usage:
 *   npx tsx scripts/test-sync-server.ts
 *
 * Then add targets:
 *   panopticon sync add-target --name local-a --url http://localhost:9801 --token test
 *   panopticon sync add-target --name local-b --url http://localhost:9802 --token test
 */

import {
  createTestSyncServerDb,
  startTestSyncServer,
  type TestSyncFailureRule,
} from "../src/sync/test-server.js";

const PORT_A = 9801;
const PORT_B = 9802;

function parseEnvInt(name: string): number {
  const raw = process.env[name];
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildFailureRules(): TestSyncFailureRule[] {
  const status = parseEnvInt("PANOPTICON_TEST_SYNC_FAIL_STATUS") || 503;
  const rules: TestSyncFailureRule[] = [];

  const failFirstSessions = parseEnvInt(
    "PANOPTICON_TEST_SYNC_FAIL_FIRST_SESSIONS_REQUESTS",
  );
  if (failFirstSessions > 0) {
    rules.push({ table: "sessions", remaining: failFirstSessions, status });
  }

  const failFirstRequests = parseEnvInt(
    "PANOPTICON_TEST_SYNC_FAIL_FIRST_REQUESTS",
  );
  if (failFirstRequests > 0) {
    rules.push({ remaining: failFirstRequests, status });
  }

  return rules;
}

console.log("\nStarting test sync servers...\n");

const dbA = createTestSyncServerDb("target-a");
const dbB = createTestSyncServerDb("target-b");
const failureRules = buildFailureRules();

const serverA = await startTestSyncServer({
  db: dbA.db,
  failureRules,
  log: console,
  name: "target-a",
  port: PORT_A,
});
const serverB = await startTestSyncServer({
  db: dbB.db,
  failureRules,
  log: console,
  name: "target-b",
  port: PORT_B,
});

console.log("\nEndpoints:");
console.log(`  POST http://localhost:${PORT_A}/v1/sync  (target-a)`);
console.log(`  POST http://localhost:${PORT_B}/v1/sync  (target-b)`);
console.log(`  GET  http://localhost:${PORT_A}/stats`);
console.log(`  GET  http://localhost:${PORT_B}/stats`);
console.log("\nCtrl+C to stop\n");

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down...");
  await Promise.all([serverA.close(), serverB.close()]);
  dbA.db.close();
  dbB.db.close();
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
