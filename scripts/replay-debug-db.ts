#!/usr/bin/env npx tsx

/**
 * replay-debug-db.ts — Replay scanner data from a debug panopticon DB
 * into a fresh DB to reproduce session/repo attribution issues.
 *
 * Usage:
 *   npx tsx scripts/replay-debug-db.ts <source-db-path> [output-dir]
 *
 * Reads sessions, scanner_turns, and scanner_events from the source DB,
 * feeds them through the actual ingestion code, and writes to a new DB
 * at <output-dir>/data.db (default: <source-dir>/replay/).
 *
 * Does NOT require session JSONL files — replays from the already-parsed
 * data in the source DB.
 */

import fs from "node:fs";
import path from "node:path";
import { Database } from "../src/db/driver.js";

// Override panopticon config BEFORE importing anything that uses it
const sourceDbPath = process.argv[2];
if (!sourceDbPath) {
  console.error(
    "Usage: npx tsx scripts/replay-debug-db.ts <source-db-path> [output-dir]",
  );
  process.exit(1);
}

const outputDir =
  process.argv[3] ?? path.join(path.dirname(sourceDbPath), "replay");
fs.mkdirSync(outputDir, { recursive: true });

const outputDbPath = path.join(outputDir, "data.db");
if (fs.existsSync(outputDbPath)) {
  fs.unlinkSync(outputDbPath);
  console.log(`Removed existing ${outputDbPath}`);
}

// Point panopticon at the output directory
process.env.PANOPTICON_DATA_DIR = outputDir;

// Now import panopticon modules (they'll use the overridden data dir)
const { getDb } = await import("../src/db/schema.js");
const { upsertSession, upsertSessionRepository, upsertSessionCwd } =
  await import("../src/db/store.js");

// Initialize the fresh DB (runs migrations)
getDb();
console.log(`Fresh DB created at ${outputDbPath}`);

// Open the source DB read-only
const sourceDb = new Database(path.resolve(sourceDbPath), { readonly: true });

// ── Step 1: Replay sessions ────────────────────────────────────────────────

console.log("\n=== Replaying sessions ===");

const sessions = sourceDb
  .prepare(
    `SELECT session_id, target, started_at_ms, ended_at_ms, cwd,
            first_prompt, permission_mode, agent_version,
            model, cli_version, scanner_file_path,
            total_input_tokens, total_output_tokens,
            total_cache_read_tokens, total_cache_creation_tokens,
            total_reasoning_tokens, turn_count, models
     FROM sessions ORDER BY started_at_ms`,
  )
  .all() as Array<Record<string, unknown>>;

console.log(`  ${sessions.length} sessions to replay`);

for (const s of sessions) {
  upsertSession({
    session_id: s.session_id as string,
    target: (s.target as string) ?? undefined,
    started_at_ms: (s.started_at_ms as number) ?? undefined,
    ended_at_ms: (s.ended_at_ms as number) ?? undefined,
    first_prompt: (s.first_prompt as string) ?? undefined,
    permission_mode: (s.permission_mode as string) ?? undefined,
    agent_version: (s.agent_version as string) ?? undefined,
    model: (s.model as string) ?? undefined,
    cli_version: (s.cli_version as string) ?? undefined,
    scanner_file_path: (s.scanner_file_path as string) ?? undefined,
    total_input_tokens: (s.total_input_tokens as number) ?? undefined,
    total_output_tokens: (s.total_output_tokens as number) ?? undefined,
    total_cache_read_tokens: (s.total_cache_read_tokens as number) ?? undefined,
    total_cache_creation_tokens:
      (s.total_cache_creation_tokens as number) ?? undefined,
    total_reasoning_tokens: (s.total_reasoning_tokens as number) ?? undefined,
    turn_count: (s.turn_count as number) ?? undefined,
  });
}

console.log(`  ✓ ${sessions.length} sessions upserted`);

// ── Step 2: Replay session_repositories ──────────────────────────────────

console.log("\n=== Replaying session_repositories ===");

const repos = sourceDb
  .prepare(
    `SELECT session_id, repository, first_seen_ms,
            git_user_name, git_user_email, branch
     FROM session_repositories`,
  )
  .all() as Array<Record<string, unknown>>;

console.log(`  ${repos.length} repo entries to replay`);

for (const r of repos) {
  upsertSessionRepository(
    r.session_id as string,
    r.repository as string,
    (r.first_seen_ms as number) ?? Date.now(),
    {
      name: (r.git_user_name as string) ?? null,
      email: (r.git_user_email as string) ?? null,
    },
    (r.branch as string) ?? undefined,
  );
}

console.log(`  ✓ ${repos.length} repo entries upserted`);

// ── Step 3: Replay session_cwds ──────────────────────────────────────────

console.log("\n=== Replaying session_cwds ===");

const cwds = sourceDb
  .prepare(`SELECT session_id, cwd, first_seen_ms FROM session_cwds`)
  .all() as Array<Record<string, unknown>>;

console.log(`  ${cwds.length} cwd entries to replay`);

for (const c of cwds) {
  upsertSessionCwd(
    c.session_id as string,
    c.cwd as string,
    (c.first_seen_ms as number) ?? Date.now(),
  );
}

console.log(`  ✓ ${cwds.length} cwd entries upserted`);

// ── Step 4: Copy scanner_turns ───────────────────────────────────────────

console.log("\n=== Copying scanner_turns ===");

const turnCount = (
  sourceDb.prepare("SELECT count(*) as cnt FROM scanner_turns").get() as {
    cnt: number;
  }
).cnt;
console.log(`  ${turnCount} turns to copy`);

const destDb = getDb();
const BATCH = 5000;
let offset = 0;
let copied = 0;

const insertTurn = destDb.prepare(`
  INSERT OR IGNORE INTO scanner_turns
    (session_id, source, turn_index, timestamp_ms, model, role,
     content_preview, input_tokens, output_tokens,
     cache_read_tokens, cache_creation_tokens, reasoning_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

while (offset < turnCount) {
  const batch = sourceDb
    .prepare(
      `SELECT session_id, source, turn_index, timestamp_ms, model, role,
              content_preview, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, reasoning_tokens
       FROM scanner_turns ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(BATCH, offset) as Array<Record<string, unknown>>;

  const tx = destDb.transaction(() => {
    for (const t of batch) {
      insertTurn.run(
        t.session_id,
        t.source,
        t.turn_index,
        t.timestamp_ms,
        t.model ?? null,
        t.role,
        t.content_preview ?? null,
        t.input_tokens,
        t.output_tokens,
        t.cache_read_tokens,
        t.cache_creation_tokens,
        t.reasoning_tokens,
      );
    }
  });
  tx();

  copied += batch.length;
  offset += BATCH;
  process.stdout.write(`  ${copied}/${turnCount}\r`);
}

console.log(`  ✓ ${copied} turns copied`);

// ── Step 5: Copy scanner_events ──────────────────────────────────────────

console.log("\n=== Copying scanner_events ===");

const eventCount = (
  sourceDb.prepare("SELECT count(*) as cnt FROM scanner_events").get() as {
    cnt: number;
  }
).cnt;
console.log(`  ${eventCount} events to copy`);

const insertEvent = destDb.prepare(`
  INSERT OR IGNORE INTO scanner_events
    (session_id, source, event_type, timestamp_ms, tool_name,
     tool_input, tool_output, content, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

offset = 0;
copied = 0;

while (offset < eventCount) {
  const batch = sourceDb
    .prepare(
      `SELECT session_id, source, event_type, timestamp_ms, tool_name,
              tool_input, tool_output, content, metadata
       FROM scanner_events ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(BATCH, offset) as Array<Record<string, unknown>>;

  const tx = destDb.transaction(() => {
    for (const e of batch) {
      insertEvent.run(
        e.session_id,
        e.source,
        e.event_type,
        e.timestamp_ms,
        e.tool_name ?? null,
        e.tool_input ?? null,
        e.tool_output ?? null,
        e.content ?? null,
        e.metadata ?? null,
      );
    }
  });
  tx();

  copied += batch.length;
  offset += BATCH;
  process.stdout.write(`  ${copied}/${eventCount}\r`);
}

console.log(`  ✓ ${copied} events copied`);

// ── Step 6: Summary ──────────────────────────────────────────────────────

console.log("\n=== Replay complete ===");

const replaySessions = (
  destDb.prepare("SELECT count(*) as cnt FROM sessions").get() as {
    cnt: number;
  }
).cnt;
const replayRepos = (
  destDb.prepare("SELECT count(*) as cnt FROM session_repositories").get() as {
    cnt: number;
  }
).cnt;
const replayCwds = (
  destDb.prepare("SELECT count(*) as cnt FROM session_cwds").get() as {
    cnt: number;
  }
).cnt;
const replayTurns = (
  destDb.prepare("SELECT count(*) as cnt FROM scanner_turns").get() as {
    cnt: number;
  }
).cnt;
const replayEvents = (
  destDb.prepare("SELECT count(*) as cnt FROM scanner_events").get() as {
    cnt: number;
  }
).cnt;

console.log(`  Output DB: ${outputDbPath}`);
console.log(`  Sessions:       ${replaySessions}`);
console.log(`  Repositories:   ${replayRepos}`);
console.log(`  CWDs:           ${replayCwds}`);
console.log(`  Scanner turns:  ${replayTurns}`);
console.log(`  Scanner events: ${replayEvents}`);

// Compare with source
const srcRepos = (
  sourceDb
    .prepare("SELECT count(*) as cnt FROM session_repositories")
    .get() as { cnt: number }
).cnt;
const srcCwds = (
  sourceDb.prepare("SELECT count(*) as cnt FROM session_cwds").get() as {
    cnt: number;
  }
).cnt;

console.log(`\n  Source repos: ${srcRepos}, replay repos: ${replayRepos}`);
console.log(`  Source cwds:  ${srcCwds}, replay cwds:  ${replayCwds}`);

sourceDb.close();
