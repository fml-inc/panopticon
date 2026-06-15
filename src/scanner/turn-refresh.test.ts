/**
 * Tests that insertTurns refreshes existing rows on re-parse instead of
 * skipping them. Adapters with only session-aggregate token data (hermes)
 * attach the aggregate to the latest assistant turn, so a turn_index can
 * carry different values between parses; stale rows must not survive and
 * inflate updateSessionTotals.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const dir = _fs.mkdtempSync(
    _path.join(_os.tmpdir(), "pano-turn-refresh-test-"),
  );
  return {
    config: {
      dataDir: dir,
      dbPath: _path.join(dir, "panopticon.db"),
      port: 14318,
      host: "127.0.0.1",
      serverPidFile: "",
    },
    ensureDataDir: () => _fs.mkdirSync(dir, { recursive: true }),
  };
});

import { closeDb, getDb } from "../db/schema.js";
import type { ParsedTurn } from "../targets/types.js";
import { insertTurns, updateSessionTotals, upsertSession } from "./store.js";

const SESSION_ID = "hermes-refresh-session";

function turn(
  turnIndex: number,
  role: "user" | "assistant",
  tokens: Partial<
    Pick<
      ParsedTurn,
      | "inputTokens"
      | "outputTokens"
      | "cacheReadTokens"
      | "cacheCreationTokens"
      | "reasoningTokens"
    >
  > = {},
): ParsedTurn {
  return {
    sessionId: SESSION_ID,
    turnIndex,
    timestampMs: 1_780_000_000_000 + turnIndex,
    role,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    ...tokens,
  };
}

afterAll(() => closeDb());

describe("insertTurns refresh on conflict", () => {
  it("moves aggregate tokens to the new latest turn without double counting", () => {
    upsertSession({ sessionId: SESSION_ID }, "/tmp/state.db", "hermes");

    // Parse 1: two turns, session aggregate (100 in / 25 out) on turn 1.
    insertTurns(
      [
        turn(0, "user"),
        turn(1, "assistant", { inputTokens: 100, outputTokens: 25 }),
      ],
      "hermes",
    );
    updateSessionTotals(SESSION_ID);

    const syncIdBefore = (
      getDb()
        .prepare(
          "SELECT sync_id FROM scanner_turns WHERE session_id = ? AND turn_index = 1",
        )
        .get(SESSION_ID) as { sync_id: string }
    ).sync_id;

    // Parse 2: full re-snapshot — the aggregate (now 150/40) moved to turn 3;
    // turn 1 is re-emitted with zero tokens and must be refreshed, not kept.
    insertTurns(
      [
        turn(0, "user"),
        turn(1, "assistant"),
        turn(2, "user"),
        turn(3, "assistant", { inputTokens: 150, outputTokens: 40 }),
      ],
      "hermes",
    );
    updateSessionTotals(SESSION_ID);

    const db = getDb();
    const rows = db
      .prepare(
        "SELECT turn_index, input_tokens, output_tokens, sync_id FROM scanner_turns WHERE session_id = ? ORDER BY turn_index",
      )
      .all(SESSION_ID) as Array<{
      turn_index: number;
      input_tokens: number;
      output_tokens: number;
      sync_id: string;
    }>;
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ input_tokens: 0, output_tokens: 0 });
    expect(rows[3]).toMatchObject({ input_tokens: 150, output_tokens: 40 });
    // sync identity survives the refresh
    expect(rows[1].sync_id).toBe(syncIdBefore);

    const session = db
      .prepare(
        "SELECT total_input_tokens, total_output_tokens FROM sessions WHERE session_id = ?",
      )
      .get(SESSION_ID) as {
      total_input_tokens: number;
      total_output_tokens: number;
    };
    expect(session.total_input_tokens).toBe(150);
    expect(session.total_output_tokens).toBe(40);
  });

  it("forces a session's turns to re-sync when an already-synced turn's tokens change", () => {
    const db = getDb();
    const sessionId = "hermes-resync-session";
    upsertSession({ sessionId }, "/tmp/state.db", "hermes");

    // Parse 1: aggregate on turn 1.
    insertTurns(
      [
        { ...turn(0, "user"), sessionId },
        {
          ...turn(1, "assistant", { inputTokens: 100, outputTokens: 25 }),
          sessionId,
        },
      ],
      "hermes",
    );

    // Simulate a sync target that has already synced both turns: its
    // per-session watermark sits past their ids and synced_seq is caught up.
    const maxId = (
      db
        .prepare("SELECT MAX(id) AS m FROM scanner_turns WHERE session_id = ?")
        .get(sessionId) as { m: number }
    ).m;
    db.prepare(
      `INSERT INTO target_session_sync
         (session_id, target, confirmed, sync_seq, synced_seq, wm_scanner_turns)
       VALUES (?, 'fml', 1, 1, 1, ?)`,
    ).run(sessionId, maxId);

    const seqBefore = (
      db
        .prepare("SELECT sync_seq FROM sessions WHERE session_id = ?")
        .get(sessionId) as { sync_seq: number }
    ).sync_seq;

    // Parse 2: session grew; aggregate moved off turn 1 (reset to 0) onto a
    // new turn 3. Turn 1's tokens mutate — the row the remote already has.
    insertTurns(
      [
        { ...turn(0, "user"), sessionId },
        { ...turn(1, "assistant"), sessionId },
        { ...turn(2, "user"), sessionId },
        {
          ...turn(3, "assistant", { inputTokens: 150, outputTokens: 40 }),
          sessionId,
        },
      ],
      "hermes",
    );

    // The mutated session's turn watermark resets to 0 so readSessionScannerTurns
    // re-reads (and re-sends) every turn, letting the remote patch the stale
    // turn-1 row by sync_id. sync_seq is bumped so the session is re-selected.
    const tss = db
      .prepare(
        "SELECT wm_scanner_turns FROM target_session_sync WHERE session_id = ? AND target = 'fml'",
      )
      .get(sessionId) as { wm_scanner_turns: number };
    expect(tss.wm_scanner_turns).toBe(0);

    const seqAfter = (
      db
        .prepare("SELECT sync_seq FROM sessions WHERE session_id = ?")
        .get(sessionId) as { sync_seq: number }
    ).sync_seq;
    expect(seqAfter).toBeGreaterThan(seqBefore);
  });

  it("does not reset the watermark when turns are re-emitted unchanged", () => {
    const db = getDb();
    const sessionId = "hermes-stable-session";
    upsertSession({ sessionId }, "/tmp/state.db", "claude");

    insertTurns(
      [
        { ...turn(0, "user"), sessionId },
        {
          ...turn(1, "assistant", { inputTokens: 10, outputTokens: 5 }),
          sessionId,
        },
      ],
      "claude",
    );
    db.prepare(
      `INSERT INTO target_session_sync
         (session_id, target, confirmed, sync_seq, synced_seq, wm_scanner_turns)
       VALUES (?, 'fml', 1, 1, 1, 999)`,
    ).run(sessionId);

    // Re-emit identical turns (the normal case for every non-hermes adapter).
    insertTurns(
      [
        { ...turn(0, "user"), sessionId },
        {
          ...turn(1, "assistant", { inputTokens: 10, outputTokens: 5 }),
          sessionId,
        },
      ],
      "claude",
    );

    const tss = db
      .prepare(
        "SELECT wm_scanner_turns FROM target_session_sync WHERE session_id = ? AND target = 'fml'",
      )
      .get(sessionId) as { wm_scanner_turns: number };
    expect(tss.wm_scanner_turns).toBe(999);
  });
});
