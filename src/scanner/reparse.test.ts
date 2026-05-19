import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config + os.homedir so the scanner discovers only our fixture file
// and writes to a throwaway database.  Temp dirs are created inside the
// mock factories (which run before the rest of the module loads) and the
// paths are passed back to the test body via env vars.
vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), "pano-reparse-data-"));
  process.env.__PANO_TEST_DATA = dir;
  return {
    config: {
      dataDir: dir,
      dbPath: _path.join(dir, "panopticon.db"),
      port: 14999,
      host: "127.0.0.1",
      serverPidFile: "",
      marketplaceDir: _path.join(dir, "marketplace"),
    },
    ensureDataDir: () => _fs.mkdirSync(dir, { recursive: true }),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    tmpdir(): string;
  };
  const _fs = require("node:fs");
  const _path = require("node:path");
  const home = _fs.mkdtempSync(
    _path.join(actual.tmpdir(), "pano-reparse-home-"),
  );
  process.env.__PANO_TEST_HOME = home;
  const mocked = { ...actual, homedir: () => home };
  return { ...mocked, default: mocked };
});

import { config } from "../config.js";
import { closeDb, getDb } from "../db/schema.js";
import { scanOnce } from "./loop.js";
import { reparseAll } from "./reparse.js";

const HOME = process.env.__PANO_TEST_HOME as string;

// ── Forked-session fixture ──────────────────────────────────────────────────
//
// DAG layout (file order = line order):
//
//   u0 ─ a0 ─┬─ u1 ─ a1 ─ u2 ─ a2 ─ u3 ─ a3 ─ u4 ─ a4   (main path)
//            └─ uf1 ─ af1 ─ uf2 ─ af2                     (fork branch)
//
// a0 has two children. The first child's subtree (u1..u4) has 4 user
// turns (> FORK_THRESHOLD = 3), so detectForks keeps it on the main path
// and splits the second child (uf1...) into a separate "fork" session.

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SLUG = "-test-workspace-forks";

interface Entry {
  uuid: string;
  parentUuid?: string;
  role: "user" | "assistant";
  text: string;
  toolUse?: { id: string; name: string };
}

function fixtureLines(): string[] {
  const entries: Entry[] = [
    { uuid: "u0", role: "user", text: "kick off the work" },
    { uuid: "a0", parentUuid: "u0", role: "assistant", text: "on it" },
    // main path
    { uuid: "u1", parentUuid: "a0", role: "user", text: "main step 1" },
    { uuid: "a1", parentUuid: "u1", role: "assistant", text: "main reply 1" },
    { uuid: "u2", parentUuid: "a1", role: "user", text: "main step 2" },
    { uuid: "a2", parentUuid: "u2", role: "assistant", text: "main reply 2" },
    { uuid: "u3", parentUuid: "a2", role: "user", text: "main step 3" },
    { uuid: "a3", parentUuid: "u3", role: "assistant", text: "main reply 3" },
    { uuid: "u4", parentUuid: "a3", role: "user", text: "main step 4" },
    { uuid: "a4", parentUuid: "u4", role: "assistant", text: "main reply 4" },
    // fork branch off a0
    { uuid: "uf1", parentUuid: "a0", role: "user", text: "fork step 1" },
    {
      uuid: "af1",
      parentUuid: "uf1",
      role: "assistant",
      text: "fork reply 1",
      toolUse: { id: "toolu_fork_1", name: "Bash" },
    },
    { uuid: "uf2", parentUuid: "af1", role: "user", text: "fork step 2" },
    { uuid: "af2", parentUuid: "uf2", role: "assistant", text: "fork reply 2" },
  ];

  const base = Date.parse("2026-05-19T12:00:00.000Z");
  return entries.map((e, i) => {
    const ts = new Date(base + i * 1000).toISOString();
    if (e.role === "user") {
      return JSON.stringify({
        type: "user",
        sessionId: SESSION_ID,
        version: "2.1.84",
        cwd: "/test/workspace/forks",
        uuid: e.uuid,
        parentUuid: e.parentUuid,
        timestamp: ts,
        message: { content: e.text },
      });
    }
    const content: unknown[] = [{ type: "text", text: e.text }];
    if (e.toolUse) {
      content.push({
        type: "tool_use",
        id: e.toolUse.id,
        name: e.toolUse.name,
        input: { command: "echo hi" },
      });
    }
    return JSON.stringify({
      type: "assistant",
      sessionId: SESSION_ID,
      uuid: e.uuid,
      parentUuid: e.parentUuid,
      timestamp: ts,
      message: {
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content,
      },
    });
  });
}

function writeFixture(): void {
  const dir = path.join(HOME, ".claude", "projects", SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${SESSION_ID}.jsonl`),
    `${fixtureLines().join("\n")}\n`,
  );
}

interface TurnRow {
  session_id: string;
  source: string;
  turn_index: number;
  sync_id: string;
}

function turnSyncIds(): TurnRow[] {
  return getDb()
    .prepare(
      "SELECT session_id, source, turn_index, sync_id FROM scanner_turns ORDER BY session_id, turn_index",
    )
    .all() as TurnRow[];
}

beforeEach(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(config.dbPath + suffix);
    } catch {}
  }
  fs.rmSync(path.join(HOME, ".claude"), { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
});

describe("reparse preserves sync_id for forked sessions", () => {
  it("detects the fork and assigns a deterministic compound session id", () => {
    writeFixture();
    scanOnce();

    const fork = getDb()
      .prepare(
        "SELECT session_id, parent_session_id, relationship_type FROM sessions WHERE relationship_type = 'fork'",
      )
      .get() as
      | {
          session_id: string;
          parent_session_id: string;
          relationship_type: string;
        }
      | undefined;

    expect(fork).toBeDefined();
    expect(fork!.session_id).toBe(`${SESSION_ID}-uf1`);
    expect(fork!.parent_session_id).toBe(SESSION_ID);
  });

  it("keeps scanner_turns sync_id stable across reparse for both the main and fork sessions", () => {
    writeFixture();
    scanOnce();

    const before = turnSyncIds();
    // Sanity: we have turns for both the main and the fork session.
    const forkId = `${SESSION_ID}-uf1`;
    expect(before.some((r) => r.session_id === SESSION_ID)).toBe(true);
    expect(before.some((r) => r.session_id === forkId)).toBe(true);

    const result = reparseAll();
    expect(result.success).toBe(true);

    const after = turnSyncIds();

    // Same set of (session_id, turn_index) rows...
    expect(after.map((r) => `${r.session_id}#${r.turn_index}`)).toEqual(
      before.map((r) => `${r.session_id}#${r.turn_index}`),
    );

    // ...and every sync_id is preserved, including the fork's.
    const beforeMap = new Map(
      before.map((r) => [`${r.session_id}#${r.turn_index}`, r.sync_id]),
    );
    for (const row of after) {
      expect(row.sync_id).toBe(
        beforeMap.get(`${row.session_id}#${row.turn_index}`),
      );
    }
    expect(after.filter((r) => r.session_id === forkId).length).toBeGreaterThan(
      0,
    );
  });

  it("preserves the fork's tool_calls sync_id across reparse", () => {
    writeFixture();
    scanOnce();

    const forkId = `${SESSION_ID}-uf1`;
    const readToolCalls = () =>
      getDb()
        .prepare(
          `SELECT tc.tool_use_id, tc.tool_name, tc.sync_id
             FROM tool_calls tc
             JOIN messages m ON tc.message_id = m.id
            WHERE m.session_id = ?
            ORDER BY tc.tool_use_id`,
        )
        .all(forkId) as {
        tool_use_id: string;
        tool_name: string;
        sync_id: string;
      }[];

    const before = readToolCalls();
    expect(before.length).toBe(1);
    expect(before[0].tool_use_id).toBe("toolu_fork_1");

    expect(reparseAll().success).toBe(true);

    const after = readToolCalls();
    expect(after.length).toBe(1);
    expect(after[0].tool_use_id).toBe("toolu_fork_1");
    expect(after[0].sync_id).toBe(before[0].sync_id);
  });
});
