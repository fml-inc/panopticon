import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParseResult } from "../targets/types.js";

const { fakeDiscoverMock, fakeParseFileMock } = vi.hoisted(() => ({
  fakeDiscoverMock: vi.fn(),
  fakeParseFileMock: vi.fn(),
}));

const testHomeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "pano-reparse-derived-home-"),
);
process.env.HOME = testHomeDir;

const codexDir = path.join(testHomeDir, ".codex");
process.env.PANOPTICON_CODEX_DIR = codexDir;

vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const dir = _fs.mkdtempSync(
    _path.join(_os.tmpdir(), "pano-reparse-derived-test-"),
  );
  return {
    config: {
      dataDir: dir,
      dbPath: _path.join(dir, "panopticon.db"),
      scannerStatusFile: _path.join(dir, "scanner-status.json"),
      port: 14318,
      host: "127.0.0.1",
      serverPidFile: "",
    },
    ensureDataDir: () => _fs.mkdirSync(dir, { recursive: true }),
  };
});

vi.mock("../targets/claude.js", () => ({}));
vi.mock("../targets/codex.js", () => ({}));
vi.mock("../targets/gemini.js", () => ({}));
vi.mock("../targets/registry.js", () => ({
  allTargets: () => [
    {
      id: "codex",
      scanner: {
        discover: fakeDiscoverMock,
        parseFile: fakeParseFileMock,
        normalizeToolCategory: () => "Edit",
      },
    },
  ],
  getTarget: vi.fn(),
  getTargetOrThrow: vi.fn(),
  registerTarget: vi.fn(),
  targetIds: () => ["codex"],
}));

import { config } from "../config.js";
import { ALL_DATA_COMPONENTS, targetDataVersion } from "../db/data-versions.js";
import { Database } from "../db/driver.js";
import { MIGRATIONS } from "../db/migrations.js";
import {
  closeDb,
  getDb,
  needsClaimsRebuild,
  needsRawDataResync,
  needsResync,
  SCHEMA_SQL,
} from "../db/schema.js";
import { insertHookEvent, insertOtelLogs, upsertSession } from "../db/store.js";
import { buildMessageSyncId } from "../db/sync-ids.js";
import { outcomesForIntent, searchIntent } from "../intent/query.js";
import { createDirectPanopticonService } from "../service/direct.js";
import { SESSION_SUMMARY_SEARCH_CORPUS } from "../session_summaries/search-index.js";
import {
  rebuildDerivedStateFromRaw,
  reparseAll,
  rewindTargetSessionSyncForScannerReparse,
} from "./reparse.js";

function clearDbFiles(): void {
  try {
    fs.unlinkSync(config.dbPath);
  } catch {}
  try {
    fs.unlinkSync(`${config.dbPath}-wal`);
  } catch {}
  try {
    fs.unlinkSync(`${config.dbPath}-shm`);
  } catch {}
}

function clearCodexSessions(): void {
  fs.rmSync(codexDir, { recursive: true, force: true });
  fs.mkdirSync(codexDir, { recursive: true });
}

function writeCodexSessionFile(args: {
  sessionId: string;
  cwd: string;
  prompt: string;
  patch: string;
}): string {
  const sessionsDir = path.join(codexDir, "sessions", "2026", "04", "21");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, `${args.sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: "2026-04-21T03:53:36.000Z",
      type: "session_meta",
      payload: {
        id: args.sessionId,
        cwd: args.cwd,
        cli_version: "0.117.0",
        timestamp: "2026-04-21T03:53:36.000Z",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T03:53:37.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.4" },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T03:53:38.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: args.prompt },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T03:53:39.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "call-apply-patch-1",
        input: args.patch,
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-21T03:53:40.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
          },
        },
      },
    }),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

function buildFakeCodexParseResult(args: {
  filePath: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  patch: string;
}): ParseResult {
  return {
    meta: {
      sessionId: args.sessionId,
      cwd: args.cwd,
      cliVersion: "0.117.0",
      model: "gpt-5.4",
      startedAtMs: 1_713_670_416_000,
      firstPrompt: args.prompt,
    },
    turns: [
      {
        sessionId: args.sessionId,
        turnIndex: 0,
        timestampMs: 1_713_670_418_000,
        role: "user",
        contentPreview: args.prompt,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
      {
        sessionId: args.sessionId,
        turnIndex: 1,
        timestampMs: 1_713_670_420_000,
        model: "gpt-5.4",
        role: "assistant",
        contentPreview: "",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
    ],
    events: [],
    messages: [
      {
        sessionId: args.sessionId,
        ordinal: 0,
        role: "user",
        content: args.prompt,
        timestampMs: 1_713_670_418_000,
        hasThinking: false,
        hasToolUse: false,
        isSystem: false,
        contentLength: args.prompt.length,
        hasContextTokens: false,
        hasOutputTokens: false,
        toolCalls: [],
        toolResults: new Map(),
      },
      {
        sessionId: args.sessionId,
        ordinal: 1,
        role: "assistant",
        content: "",
        timestampMs: 1_713_670_420_000,
        hasThinking: false,
        hasToolUse: true,
        isSystem: false,
        contentLength: 0,
        model: "gpt-5.4",
        tokenUsage: JSON.stringify({
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        }),
        contextTokens: 10,
        outputTokens: 5,
        hasContextTokens: true,
        hasOutputTokens: true,
        toolCalls: [
          {
            toolUseId: "call-apply-patch-1",
            toolName: "apply_patch",
            category: "Edit",
            inputJson: JSON.stringify({ input: args.patch }),
            timestampMs: 1_713_670_419_000,
          },
        ],
        toolResults: new Map(),
      },
    ],
    newByteOffset: fs.statSync(args.filePath).size,
  };
}

function seedPreUpgradeDb(args: {
  sessionId: string;
  cwd: string;
  scannerFilePath: string;
}): void {
  clearDbFiles();
  const raw = new Database(config.dbPath);
  raw.exec(SCHEMA_SQL);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const stampMigration = raw.prepare(
    "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
  );
  for (const migration of MIGRATIONS.filter((entry) => entry.id < 12)) {
    stampMigration.run(migration.id, migration.name);
  }

  raw
    .prepare(
      `INSERT INTO sessions
       (session_id, target, started_at_ms, cwd, first_prompt, scanner_file_path, has_scanner, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.sessionId,
      "codex",
      1_713_670_416_000,
      args.cwd,
      "stale prompt",
      args.scannerFilePath,
      1,
      1_713_670_416_000,
    );

  raw
    .prepare(
      `INSERT INTO claims (
       observation_key, head_key, predicate, subject_kind, subject,
       value_kind, value_text, source_type, observed_at_ms, asserted_at_ms,
       asserter, asserter_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "stale-observation",
      "stale-head",
      "intent/prompt-text",
      "intent",
      "stale-intent",
      "text",
      "stale prompt",
      "scanner",
      1,
      1,
      "test",
      1,
    );
  const claimId = (
    raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;

  raw
    .prepare(
      `INSERT INTO evidence_refs (ref_key, kind, file_path, locator_json)
     VALUES (?, ?, ?, ?)`,
    )
    .run("stale:tool_call", "tool_call", "/stale/path.ts", "{}");
  const evidenceRefId = (
    raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;

  raw
    .prepare(
      `INSERT INTO evidence_ref_paths (evidence_ref_id, file_path)
     VALUES (?, ?)`,
    )
    .run(evidenceRefId, "/stale/path.ts");
  raw
    .prepare(
      `INSERT INTO claim_evidence (claim_id, evidence_ref_id)
     VALUES (?, ?)`,
    )
    .run(claimId, evidenceRefId);
  raw
    .prepare(
      `INSERT INTO active_claims (head_key, claim_id, selected_at_ms, selection_reason)
     VALUES (?, ?, ?, ?)`,
    )
    .run("stale-head", claimId, 1, "test");
  raw
    .prepare(
      `INSERT INTO intent_units (intent_key, session_id, prompt_text)
     VALUES (?, ?, ?)`,
    )
    .run("stale-intent", args.sessionId, "stale prompt");
  const intentUnitId = (
    raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
  raw
    .prepare(
      `INSERT INTO intent_edits (edit_key, intent_unit_id, session_id, file_path)
     VALUES (?, ?, ?, ?)`,
    )
    .run("stale-edit", intentUnitId, args.sessionId, "/stale/path.ts");
  raw.close();
}

function seedPreRepoRelativePathUpgradeDb(args: {
  sessionId: string;
  cwd: string;
  filePath: string;
  prompt: string;
  llmSummaryText: string;
}): void {
  clearDbFiles();
  const raw = new Database(config.dbPath);
  raw.exec(SCHEMA_SQL);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const stampMigration = raw.prepare(
    "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
  );
  for (const migration of MIGRATIONS.filter((entry) => entry.id < 18)) {
    stampMigration.run(migration.id, migration.name);
  }

  const insertDataVersion = raw.prepare(
    `INSERT INTO data_versions (component, version, updated_at_ms)
     VALUES (?, ?, ?)`,
  );
  for (const component of ALL_DATA_COMPONENTS) {
    insertDataVersion.run(component, targetDataVersion(component), 1000);
  }

  raw
    .prepare(
      `INSERT INTO sessions
       (session_id, target, started_at_ms, ended_at_ms, cwd, first_prompt,
        has_scanner, message_count, user_message_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.sessionId,
      "codex",
      1_713_670_416_000,
      1_713_670_420_000,
      args.cwd,
      args.prompt,
      1,
      2,
      1,
      1_713_670_416_000,
    );
  raw
    .prepare(
      `INSERT INTO session_repositories
       (session_id, repository, first_seen_ms)
       VALUES (?, ?, ?)`,
    )
    .run(args.sessionId, args.cwd, 1_713_670_416_000);
  raw
    .prepare(
      `INSERT INTO session_cwds (session_id, cwd, first_seen_ms)
       VALUES (?, ?, ?)`,
    )
    .run(args.sessionId, args.cwd, 1_713_670_416_000);

  raw
    .prepare(
      `INSERT INTO messages
       (session_id, ordinal, role, content, timestamp_ms, is_system, sync_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.sessionId,
      0,
      "user",
      args.prompt,
      1_713_670_418_000,
      0,
      buildMessageSyncId(args.sessionId, 0),
    );
  raw
    .prepare(
      `INSERT INTO messages
       (session_id, ordinal, role, content, timestamp_ms, has_tool_use, is_system, sync_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.sessionId,
      1,
      "assistant",
      "",
      1_713_670_419_000,
      1,
      0,
      buildMessageSyncId(args.sessionId, 1),
    );
  const assistantMessageId = (
    raw
      .prepare(
        `SELECT id
         FROM messages
         WHERE session_id = ? AND ordinal = 1`,
      )
      .get(args.sessionId) as { id: number }
  ).id;

  const patch = [
    "*** Begin Patch",
    `*** Update File: ${args.filePath}`,
    "@@",
    "-export const upgraded = false;",
    "+export const upgraded = true;",
    "*** End Patch",
  ].join("\n");
  raw
    .prepare(
      `INSERT INTO tool_calls
       (message_id, session_id, call_index, tool_name, category, input_json, sync_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      assistantMessageId,
      args.sessionId,
      0,
      "apply_patch",
      "Edit",
      JSON.stringify({ input: patch }),
      "tool-call-sync-1",
    );

  raw
    .prepare(
      `INSERT INTO claims (
         observation_key, head_key, predicate, subject_kind, subject,
         value_kind, value_text, source_type, observed_at_ms, asserted_at_ms,
         asserter, asserter_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "stale-observation",
      "stale-head",
      "intent/prompt-text",
      "intent",
      "stale-intent",
      "text",
      "stale prompt",
      "scanner",
      1,
      1,
      "test",
      1,
    );
  const staleClaimId = (
    raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
  raw
    .prepare(
      `INSERT INTO evidence_refs (ref_key, kind, file_path, locator_json)
       VALUES (?, ?, ?, ?)`,
    )
    .run("stale:tool_call", "tool_call", args.filePath, "{}");
  const staleEvidenceRefId = (
    raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
  raw
    .prepare(
      `INSERT INTO evidence_ref_paths (evidence_ref_id, file_path)
       VALUES (?, ?)`,
    )
    .run(staleEvidenceRefId, args.filePath);
  raw
    .prepare(
      `INSERT INTO claim_evidence (claim_id, evidence_ref_id)
       VALUES (?, ?)`,
    )
    .run(staleClaimId, staleEvidenceRefId);
  raw
    .prepare(
      `INSERT INTO active_claims (head_key, claim_id, selected_at_ms, selection_reason)
       VALUES (?, ?, ?, ?)`,
    )
    .run("stale-head", staleClaimId, 1, "test");
  raw
    .prepare(
      `INSERT INTO intent_units
       (intent_key, session_id, prompt_text, repository, cwd)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("stale-intent", args.sessionId, "stale prompt", args.cwd, args.cwd);
  const staleIntentUnitId = (
    raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
  raw
    .prepare(
      `INSERT INTO intent_edits
       (edit_key, intent_unit_id, session_id, file_path, tool_name)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "stale-edit",
      staleIntentUnitId,
      args.sessionId,
      args.filePath,
      "apply_patch",
    );
  raw
    .prepare(
      `INSERT INTO session_summaries
       (session_summary_key, session_id, repository, cwd, title, status,
        projection_hash, projected_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ss:local:${args.sessionId}`,
      args.sessionId,
      args.cwd,
      args.cwd,
      "stale title",
      "active",
      "stale-hash",
      1_713_670_420_000,
    );
  raw
    .prepare(
      `INSERT INTO session_summary_enrichments
       (session_summary_key, session_id, summary_text, summary_source, dirty,
        last_material_change_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ss:local:${args.sessionId}`,
      args.sessionId,
      args.llmSummaryText,
      "llm",
      1,
      1_713_670_420_000,
    );
  raw
    .prepare(
      `INSERT INTO session_summary_search_index
       (session_summary_key, session_id, corpus_key, source, priority, search_text, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ss:local:${args.sessionId}`,
      args.sessionId,
      SESSION_SUMMARY_SEARCH_CORPUS.deterministicSummary,
      "deterministic",
      40,
      "stale deterministic summary",
      1_713_670_420_000,
    );

  raw.close();
}

function readDerivedCounts(db: Database): {
  claims: number;
  evidenceRefs: number;
  evidenceRefPaths: number;
  intents: number;
  edits: number;
} {
  return {
    claims: (
      db.prepare("SELECT COUNT(*) AS count FROM claims").get() as {
        count: number;
      }
    ).count,
    evidenceRefs: (
      db.prepare("SELECT COUNT(*) AS count FROM evidence_refs").get() as {
        count: number;
      }
    ).count,
    evidenceRefPaths: (
      db.prepare("SELECT COUNT(*) AS count FROM evidence_ref_paths").get() as {
        count: number;
      }
    ).count,
    intents: (
      db.prepare("SELECT COUNT(*) AS count FROM intent_units").get() as {
        count: number;
      }
    ).count,
    edits: (
      db.prepare("SELECT COUNT(*) AS count FROM intent_edits").get() as {
        count: number;
      }
    ).count,
  };
}

beforeEach(() => {
  closeDb();
  clearDbFiles();
  clearCodexSessions();
  fakeDiscoverMock.mockReset();
  fakeParseFileMock.mockReset();
});

afterEach(() => {
  closeDb();
});

describe("rebuildDerivedStateFromRaw", () => {
  it("rebuilds hook-derived intents and edits idempotently", () => {
    const db = getDb();
    const sessionId = "hook-reparse-session";
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pano-reparse-derived-scratch-"),
    );
    const filePath = path.join(scratchDir, "hook-edit.ts");
    fs.writeFileSync(filePath, "new text");

    upsertSession({
      session_id: sessionId,
      target: "claude",
      started_at_ms: 1_700_000_000_000,
      first_prompt: "change file",
      has_hooks: 1,
    });

    db.prepare(
      `INSERT INTO messages (session_id, ordinal, role, content, timestamp_ms, is_system, sync_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      0,
      "user",
      "change file",
      1_700_000_000_000,
      0,
      buildMessageSyncId(sessionId, 0),
    );

    insertHookEvent({
      session_id: sessionId,
      event_type: "UserPromptSubmit",
      timestamp_ms: 1_700_000_000_000,
      cwd: scratchDir,
      repository: scratchDir,
      target: "claude-code",
      payload: { prompt: "change file", session_id: sessionId },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "PostToolUse",
      timestamp_ms: 1_700_000_000_100,
      cwd: scratchDir,
      repository: scratchDir,
      tool_name: "Edit",
      target: "claude-code",
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: filePath,
          old_string: "old text",
          new_string: "new text",
        },
      },
    });
    insertHookEvent({
      session_id: sessionId,
      event_type: "Stop",
      timestamp_ms: 1_700_000_000_200,
      cwd: scratchDir,
      repository: scratchDir,
      target: "claude-code",
      payload: { session_id: sessionId },
    });

    const first = rebuildDerivedStateFromRaw();
    const countsAfterFirst = db
      .prepare(
        `SELECT COUNT(DISTINCT iu.id) AS intents,
                COUNT(ie.id) AS edits,
                SUM(CASE WHEN ie.landed = 1 THEN 1 ELSE 0 END) AS landed_edits
         FROM intent_units iu
         LEFT JOIN intent_edits ie ON ie.intent_unit_id = iu.id
         WHERE iu.session_id = ?`,
      )
      .get(sessionId) as {
      intents: number;
      edits: number;
      landed_edits: number | null;
    };

    expect(first.hookPrompts).toBe(1);
    expect(first.hookEdits).toBe(1);
    expect(first.projectedIntents).toBe(1);
    expect(first.projectedEdits).toBe(1);
    expect(countsAfterFirst).toEqual({
      intents: 1,
      edits: 1,
      landed_edits: 1,
    });

    const evidenceRows = db
      .prepare(
        `SELECT er.kind, er.ref_key, er.session_id
         FROM claim_evidence ce
         JOIN evidence_refs er ON er.id = ce.evidence_ref_id
         ORDER BY er.ref_key ASC`,
      )
      .all() as Array<{
      kind: string;
      ref_key: string;
      session_id: string | null;
    }>;
    expect(
      evidenceRows.some(
        (row) => row.kind === "hook_event" && row.session_id === sessionId,
      ),
    ).toBe(true);
    expect(
      evidenceRows.some((row) => row.ref_key.startsWith("file_snapshot:")),
    ).toBe(true);

    const second = rebuildDerivedStateFromRaw();
    const countsAfterSecond = db
      .prepare(
        `SELECT COUNT(DISTINCT iu.id) AS intents,
                COUNT(ie.id) AS edits,
                SUM(CASE WHEN ie.landed = 1 THEN 1 ELSE 0 END) AS landed_edits
         FROM intent_units iu
         LEFT JOIN intent_edits ie ON ie.intent_unit_id = iu.id
         WHERE iu.session_id = ?`,
      )
      .get(sessionId) as {
      intents: number;
      edits: number;
      landed_edits: number | null;
    };

    expect(second.projectedIntents).toBe(1);
    expect(second.projectedEdits).toBe(1);
    expect(countsAfterSecond).toEqual(countsAfterFirst);

    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
});

describe("rewindTargetSessionSyncForScannerReparse", () => {
  it("rewinds only scanner-owned session sync state", () => {
    const db = getDb();

    db.prepare(
      `INSERT INTO sessions (session_id, sync_seq, has_scanner, has_hooks, machine, relationship_type)
       VALUES (?, ?, ?, ?, 'local', 'standalone')`,
    ).run("scanner-session", 5, 1, 1);
    db.prepare(
      `INSERT INTO sessions (session_id, sync_seq, has_scanner, has_hooks, machine, relationship_type)
       VALUES (?, ?, ?, ?, 'local', 'standalone')`,
    ).run("hooks-only-session", 7, 0, 1);

    db.prepare(
      `INSERT INTO target_session_sync (
         session_id, target, confirmed, sync_seq, synced_seq,
         wm_messages, wm_tool_calls, wm_scanner_turns, wm_scanner_events,
         wm_hook_events, wm_otel_logs, wm_otel_metrics, wm_otel_spans
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "scanner-session",
      "fml",
      99,
      99,
      101,
      102,
      103,
      104,
      205,
      206,
      207,
      208,
    );
    db.prepare(
      `INSERT INTO target_session_sync (
         session_id, target, confirmed, sync_seq, synced_seq,
         wm_messages, wm_tool_calls, wm_scanner_turns, wm_scanner_events,
         wm_hook_events, wm_otel_logs, wm_otel_metrics, wm_otel_spans
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "hooks-only-session",
      "fml",
      88,
      88,
      111,
      112,
      113,
      114,
      215,
      216,
      217,
      218,
    );

    const rewound = rewindTargetSessionSyncForScannerReparse(db);
    expect(rewound.rewoundRows).toBe(1);

    const scannerRow = db
      .prepare("SELECT * FROM target_session_sync WHERE session_id = ?")
      .get("scanner-session") as {
      sync_seq: number;
      synced_seq: number;
      wm_messages: number;
      wm_tool_calls: number;
      wm_scanner_turns: number;
      wm_scanner_events: number;
      wm_hook_events: number;
      wm_otel_logs: number;
      wm_otel_metrics: number;
      wm_otel_spans: number;
    };
    expect(scannerRow).toMatchObject({
      sync_seq: 4,
      synced_seq: 4,
      wm_messages: 0,
      wm_tool_calls: 0,
      wm_scanner_turns: 0,
      wm_scanner_events: 0,
      wm_hook_events: 205,
      wm_otel_logs: 206,
      wm_otel_metrics: 207,
      wm_otel_spans: 208,
    });

    const hooksOnlyRow = db
      .prepare("SELECT * FROM target_session_sync WHERE session_id = ?")
      .get("hooks-only-session") as {
      sync_seq: number;
      synced_seq: number;
      wm_messages: number;
      wm_tool_calls: number;
      wm_scanner_turns: number;
      wm_scanner_events: number;
      wm_hook_events: number;
      wm_otel_logs: number;
      wm_otel_metrics: number;
      wm_otel_spans: number;
    };
    expect(hooksOnlyRow).toMatchObject({
      sync_seq: 88,
      synced_seq: 88,
      wm_messages: 111,
      wm_tool_calls: 112,
      wm_scanner_turns: 113,
      wm_scanner_events: 114,
      wm_hook_events: 215,
      wm_otel_logs: 216,
      wm_otel_metrics: 217,
      wm_otel_spans: 218,
    });
  });
});

describe("reparseAll", () => {
  it("preserves hook-only and otel-only sessions across atomic reparse", () => {
    const scannerSessionId = "scanner-reparse-session";
    const hooksOnlySessionId = "hooks-only-session";
    const otelOnlySessionId = "otel-only-session";
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pano-reparse-preserve-sessions-"),
    );

    try {
      const scannerFilePath = writeCodexSessionFile({
        sessionId: scannerSessionId,
        cwd: scratchDir,
        prompt: "reparse scanner session",
        patch: [
          "*** Begin Patch",
          `*** Add File: ${path.join(scratchDir, "preserved.ts")}`,
          "+export const preserved = true;",
          "*** End Patch",
        ].join("\n"),
      });
      fakeDiscoverMock.mockReturnValue([{ filePath: scannerFilePath }]);
      fakeParseFileMock.mockImplementation((filePath: string) =>
        buildFakeCodexParseResult({
          filePath,
          sessionId: scannerSessionId,
          cwd: scratchDir,
          prompt: "reparse scanner session",
          patch: [
            "*** Begin Patch",
            `*** Add File: ${path.join(scratchDir, "preserved.ts")}`,
            "+export const preserved = true;",
            "*** End Patch",
          ].join("\n"),
        }),
      );

      upsertSession({
        session_id: hooksOnlySessionId,
        started_at_ms: 1_713_670_000_000,
        has_hooks: 1,
        has_scanner: 0,
        relationship_type: "standalone",
      });
      upsertSession({
        session_id: otelOnlySessionId,
        started_at_ms: 1_713_670_100_000,
        has_otel: 1,
        has_scanner: 0,
        relationship_type: "standalone",
      });
      insertHookEvent({
        session_id: hooksOnlySessionId,
        event_type: "SessionStart",
        timestamp_ms: 1_713_670_000_000,
        cwd: scratchDir,
        payload: { session_id: hooksOnlySessionId },
      });
      insertOtelLogs([
        {
          timestamp_ns: 1_713_670_100_000_000_000,
          body: "otel-only event",
          session_id: otelOnlySessionId,
        },
      ]);

      const result = reparseAll();
      expect(result.success).toBe(true);

      const db = getDb();
      expect(
        db
          .prepare(
            `SELECT has_hooks, has_otel, has_scanner
             FROM sessions
             WHERE session_id = ?`,
          )
          .get(hooksOnlySessionId),
      ).toEqual({
        has_hooks: 1,
        has_otel: null,
        has_scanner: 0,
      });
      expect(
        db
          .prepare(
            `SELECT has_hooks, has_otel, has_scanner
             FROM sessions
             WHERE session_id = ?`,
          )
          .get(otelOnlySessionId),
      ).toEqual({
        has_hooks: null,
        has_otel: 1,
        has_scanner: 0,
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM hook_events WHERE session_id = ?",
          )
          .get(hooksOnlySessionId),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM otel_logs WHERE session_id = ?",
          )
          .get(otelOnlySessionId),
      ).toEqual({ count: 1 });
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("succeeds when the DB has only hook-only sessions (no scanner sessions)", () => {
    // Regression for the abort guard: previously compared
    // `tempSessionCount === 0 && oldSessionCount > 0`, where oldSessionCount
    // counted ALL sessions. A pure hook-only install has no scanner files,
    // so tempSessionCount is 0 but oldSessionCount is > 0 — reparse aborted
    // on every migration, leaving needsResync() true and 503'ing derived
    // MCP tools until manual intervention.
    const hooksOnlySessionId = "hooks-only-no-scanner-sess";
    fakeDiscoverMock.mockReturnValue([]); // no scanner files at all

    upsertSession({
      session_id: hooksOnlySessionId,
      started_at_ms: 1_713_680_000_000,
      has_hooks: 1,
      has_scanner: 0,
      relationship_type: "standalone",
    });
    insertHookEvent({
      session_id: hooksOnlySessionId,
      event_type: "SessionStart",
      timestamp_ms: 1_713_680_000_000,
      cwd: "/tmp",
      payload: { session_id: hooksOnlySessionId },
    });

    const result = reparseAll();
    expect(result.success).toBe(true);

    const db = getDb();
    // The hook-only session must survive the reparse.
    expect(
      db
        .prepare(
          `SELECT has_hooks, has_scanner FROM sessions WHERE session_id = ?`,
        )
        .get(hooksOnlySessionId),
    ).toEqual({ has_hooks: 1, has_scanner: 0 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM hook_events WHERE session_id = ?",
        )
        .get(hooksOnlySessionId),
    ).toEqual({ count: 1 });
  });
});

describe("startup reparse after migration 12", () => {
  it("clears stale derived state on upgrade and rebuilds multi-file evidence refs", async () => {
    const sessionId = "codex-reparse-session";
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pano-reparse-startup-scratch-"),
    );

    try {
      const fileA = path.join(scratchDir, "src", "a.ts");
      const fileB = path.join(scratchDir, "src", "b.ts");
      fs.mkdirSync(path.dirname(fileA), { recursive: true });
      fs.writeFileSync(fileA, "const alpha = 1;\n");
      fs.writeFileSync(fileB, "const beta = 2;\n");

      const patch = [
        "*** Begin Patch",
        `*** Update File: ${fileA}`,
        "@@",
        "-const alpha = 0;",
        "+const alpha = 1;",
        `*** Update File: ${fileB}`,
        "@@",
        "-const beta = 0;",
        "+const beta = 2;",
        "*** End Patch",
      ].join("\n");

      const scannerFilePath = writeCodexSessionFile({
        sessionId,
        cwd: scratchDir,
        prompt: "patch both files",
        patch,
      });
      fakeDiscoverMock.mockReturnValue([{ filePath: scannerFilePath }]);
      fakeParseFileMock.mockImplementation((filePath: string) =>
        buildFakeCodexParseResult({
          filePath,
          sessionId,
          cwd: scratchDir,
          prompt: "patch both files",
          patch,
        }),
      );
      seedPreUpgradeDb({
        sessionId,
        cwd: scratchDir,
        scannerFilePath,
      });

      const migratedDb = getDb();
      expect(needsResync()).toBe(true);
      expect(readDerivedCounts(migratedDb)).toEqual({
        claims: 0,
        evidenceRefs: 0,
        evidenceRefPaths: 0,
        intents: 0,
        edits: 0,
      });

      const service = createDirectPanopticonService();
      const result = await service.scan({ summaries: false });

      expect(result.filesScanned).toBe(1);
      expect(result.newTurns).toBeGreaterThan(0);
      expect(needsResync()).toBe(false);

      const db = getDb();
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?",
          )
          .get(sessionId),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            `SELECT prompt_text, edit_count, landed_count
           FROM intent_units
           WHERE session_id = ?`,
          )
          .get(sessionId),
      ).toEqual({
        prompt_text: "patch both files",
        edit_count: 2,
        landed_count: null,
      });

      const rebuiltEdits = db
        .prepare(
          `SELECT file_path, landed
           FROM intent_edits
           WHERE session_id = ?
           ORDER BY file_path ASC`,
        )
        .all(sessionId) as Array<{
        file_path: string;
        landed: number | null;
      }>;
      expect(rebuiltEdits).toEqual([
        { file_path: fileA, landed: null },
        { file_path: fileB, landed: null },
      ]);

      const toolRef = db
        .prepare(
          `SELECT id, file_path
           FROM evidence_refs
           WHERE session_id = ? AND kind = 'tool_call'`,
        )
        .get(sessionId) as { id: number; file_path: string | null };
      expect(toolRef.file_path).toBeNull();

      const rebuiltPaths = db
        .prepare(
          `SELECT file_path
           FROM evidence_ref_paths
           WHERE evidence_ref_id = ?
           ORDER BY file_path ASC`,
        )
        .all(toolRef.id) as Array<{ file_path: string }>;
      expect(rebuiltPaths).toEqual([
        { file_path: fileA },
        { file_path: fileB },
      ]);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("startup claims rebuild after migration 18", () => {
  it("rebuilds from local raw DB data without scanner replay and preserves llm enrichments", async () => {
    const sessionId = "repo-relative-upgrade-session";
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pano-repo-relative-upgrade-"),
    );

    try {
      const filePath = path.join(scratchDir, "src", "upgraded.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "export const upgraded = true;\n");

      seedPreRepoRelativePathUpgradeDb({
        sessionId,
        cwd: scratchDir,
        filePath,
        prompt: "patch repo relative file",
        llmSummaryText: "Existing LLM summary",
      });

      fakeDiscoverMock.mockImplementation(() => {
        throw new Error(
          "scanner discover should not run during claims rebuild",
        );
      });
      fakeParseFileMock.mockImplementation(() => {
        throw new Error("scanner parse should not run during claims rebuild");
      });

      const migratedDb = getDb();
      expect(needsResync()).toBe(true);
      expect(needsRawDataResync()).toBe(false);
      expect(needsClaimsRebuild()).toBe(true);
      expect(
        migratedDb
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM claims) AS claims,
               (SELECT COUNT(*) FROM evidence_refs) AS evidence_refs,
               (SELECT COUNT(*) FROM intent_units) AS intent_units,
               (SELECT COUNT(*) FROM intent_edits) AS intent_edits,
               (SELECT COUNT(*) FROM session_summaries) AS session_summaries,
               (SELECT COUNT(*) FROM session_summary_enrichments) AS enrichments,
               (SELECT COUNT(*) FROM session_summary_search_index) AS search_index`,
          )
          .get(),
      ).toEqual({
        claims: 0,
        evidence_refs: 0,
        intent_units: 0,
        intent_edits: 0,
        session_summaries: 0,
        enrichments: 1,
        search_index: 0,
      });

      const service = createDirectPanopticonService();
      const result = await service.scan({ summaries: false });

      expect(result).toEqual({
        filesScanned: 0,
        newTurns: 0,
        summariesUpdated: 0,
      });
      expect(fakeDiscoverMock).not.toHaveBeenCalled();
      expect(fakeParseFileMock).not.toHaveBeenCalled();
      expect(needsResync()).toBe(false);
      expect(needsRawDataResync()).toBe(false);
      expect(needsClaimsRebuild()).toBe(false);

      const db = getDb();
      expect(
        db
          .prepare(
            `SELECT prompt_text, edit_count, landed_count, repository, cwd
             FROM intent_units
             WHERE session_id = ?`,
          )
          .get(sessionId),
      ).toEqual({
        prompt_text: "patch repo relative file",
        edit_count: 1,
        landed_count: 1,
        repository: scratchDir,
        cwd: scratchDir,
      });
      expect(
        db
          .prepare(
            `SELECT file_path, landed, landed_reason
             FROM intent_edits
             WHERE session_id = ?`,
          )
          .get(sessionId),
      ).toEqual({
        file_path: "src/upgraded.ts",
        landed: 1,
        landed_reason: "present_in_file",
      });

      const search = searchIntent({ query: "repo relative file" });
      expect(search).toHaveLength(1);
      expect(search[0]).toMatchObject({
        prompt_text: "patch repo relative file",
        files: [
          expect.objectContaining({
            file_path: filePath,
            landed: 1,
          }),
        ],
      });

      const outcomes = outcomesForIntent({
        intent_unit_id: search[0].intent_unit_id,
      });
      expect(outcomes).not.toBeNull();
      expect(outcomes!.t0_session_end.edits_survived).toEqual([
        expect.objectContaining({
          file_path: filePath,
          reason: "present_in_file",
        }),
      ]);

      expect(
        db
          .prepare(
            `SELECT summary_text, summary_source, session_id
             FROM session_summary_enrichments
             WHERE session_summary_key = ?`,
          )
          .get(`ss:local:${sessionId}`),
      ).toEqual({
        summary_text: "Existing LLM summary",
        summary_source: "llm",
        session_id: sessionId,
      });
      expect(
        db
          .prepare(
            `SELECT corpus_key, search_text
             FROM session_summary_search_index
             WHERE session_summary_key = ?
               AND corpus_key IN (?, ?)
             ORDER BY corpus_key ASC`,
          )
          .all(
            `ss:local:${sessionId}`,
            SESSION_SUMMARY_SEARCH_CORPUS.llmSearch,
            SESSION_SUMMARY_SEARCH_CORPUS.llmSummary,
          ),
      ).toEqual([
        {
          corpus_key: SESSION_SUMMARY_SEARCH_CORPUS.llmSearch,
          search_text: "Existing LLM summary",
        },
        {
          corpus_key: SESSION_SUMMARY_SEARCH_CORPUS.llmSummary,
          search_text: "Existing LLM summary",
        },
      ]);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
