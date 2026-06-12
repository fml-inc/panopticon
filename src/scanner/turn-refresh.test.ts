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
});
