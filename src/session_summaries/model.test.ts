import { describe, expect, it } from "vitest";

import {
  buildDeterministicSessionSummaryDocs,
  mergeSessionSummaryEnrichment,
  SESSION_SUMMARY_ENRICHMENT_VERSION,
  type SessionSummaryDeterministicInput,
  type SessionSummaryEnrichmentRow,
} from "./model.js";

const NOW_MS = 1_700_000_000_000;

describe("mergeSessionSummaryEnrichment", () => {
  it("marks cold sessions dirty immediately", () => {
    const input = makeInput({
      lastActivityMs: NOW_MS - 7 * 60 * 60 * 1000,
    });

    const merged = mergeSessionSummaryEnrichment(null, input, NOW_MS);

    expect(merged.dirty).toBe(1);
    expect(dirtyReasons(merged)).toEqual(
      expect.arrayContaining(["missing", "session_cold", "refresh_pending"]),
    );
  });

  it("classifies hot sessions without forcing an immediate refresh", () => {
    const input = makeInput({
      messageCount: 5,
      lastActivityMs: NOW_MS - 5 * 60 * 1000,
    });
    const existing = makeExisting(input, {
      enriched_input_hash: null,
      enriched_message_count: 0,
      last_material_change_at_ms: NOW_MS - 5 * 60 * 1000,
    });

    const merged = mergeSessionSummaryEnrichment(existing, input, NOW_MS);

    expect(merged.dirty).toBe(0);
    expect(dirtyReasons(merged)).toEqual(
      expect.arrayContaining(["session_hot"]),
    );
  });

  it("classifies warm sessions without forcing an immediate refresh", () => {
    const input = makeInput({
      messageCount: 5,
      lastActivityMs: NOW_MS - 2 * 60 * 60 * 1000,
    });
    const existing = makeExisting(input, {
      enriched_input_hash: null,
      enriched_message_count: 0,
      last_material_change_at_ms: NOW_MS - 5 * 60 * 1000,
    });

    const merged = mergeSessionSummaryEnrichment(existing, input, NOW_MS);

    expect(merged.dirty).toBe(0);
    expect(dirtyReasons(merged)).toEqual(
      expect.arrayContaining(["session_warm"]),
    );
  });

  it("forces a refresh when the message threshold is reached", () => {
    const input = makeInput({
      messageCount: 20,
      lastActivityMs: NOW_MS - 2 * 60 * 60 * 1000,
    });
    const existing = makeExisting(input, {
      enriched_input_hash: null,
      enriched_message_count: 0,
      last_material_change_at_ms: NOW_MS - 5 * 60 * 1000,
    });

    const merged = mergeSessionSummaryEnrichment(existing, input, NOW_MS);

    expect(merged.dirty).toBe(1);
    expect(dirtyReasons(merged)).toEqual(
      expect.arrayContaining(["message_threshold_reached"]),
    );
  });

  it("forces a refresh when the pending age threshold is reached", () => {
    const input = makeInput({
      messageCount: 5,
      lastActivityMs: NOW_MS - 2 * 60 * 60 * 1000,
    });
    const existing = makeExisting(input, {
      enriched_input_hash: null,
      enriched_message_count: 0,
      last_material_change_at_ms: NOW_MS - 31 * 60 * 1000,
    });

    const merged = mergeSessionSummaryEnrichment(existing, input, NOW_MS);

    expect(merged.dirty).toBe(1);
    expect(dirtyReasons(merged)).toEqual(
      expect.arrayContaining(["pending_age_threshold_reached"]),
    );
  });
});

function makeInput(
  overrides: Partial<SessionSummaryDeterministicInput> = {},
): SessionSummaryDeterministicInput {
  return {
    sessionSummaryKey: "ss:local:test-session",
    sessionId: "test-session",
    title: "Add summary coverage",
    status: "mixed",
    repository: "/tmp/panopticon",
    cwd: "/tmp/panopticon",
    branch: "main",
    intentCount: 2,
    editCount: 3,
    landedEditCount: 1,
    openEditCount: 2,
    messageCount: 1,
    lastActivityMs: NOW_MS - 2 * 60 * 60 * 1000,
    intents: ["add direct model tests", "cover summary thresholds"],
    files: [
      {
        filePath: "src/session_summaries/model.ts",
        editCount: 2,
        landedCount: 1,
      },
    ],
    tools: ["Edit"],
    ...overrides,
  };
}

function makeExisting(
  input: SessionSummaryDeterministicInput,
  overrides: Partial<SessionSummaryEnrichmentRow> = {},
): SessionSummaryEnrichmentRow {
  const docs = buildDeterministicSessionSummaryDocs(input);
  return {
    session_summary_key: input.sessionSummaryKey,
    session_id: input.sessionId,
    summary_text: docs.summaryText,
    summary_search_text: docs.summarySearchText,
    summary_source: "deterministic",
    summary_runner: null,
    summary_model: null,
    summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
    summary_generated_at_ms: NOW_MS - 60 * 1000,
    projection_hash: docs.projectionHash,
    summary_input_hash: docs.summaryInputHash,
    summary_policy_hash: null,
    enriched_input_hash: docs.summaryInputHash,
    enriched_message_count: input.messageCount,
    dirty: 0,
    dirty_reason_json: null,
    last_material_change_at_ms: NOW_MS - 5 * 60 * 1000,
    last_attempted_at_ms: null,
    failure_count: 0,
    last_error: null,
    ...overrides,
  };
}

function dirtyReasons(
  row: Pick<SessionSummaryEnrichmentRow, "dirty_reason_json">,
) {
  return JSON.parse(row.dirty_reason_json ?? '{"reasons":[]}')
    .reasons as string[];
}
