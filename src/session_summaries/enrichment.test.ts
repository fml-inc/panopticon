import { describe, expect, it } from "vitest";
import { selectSessionSummaryRunner } from "./enrichment.js";
import {
  buildDeterministicSessionSummaryDocs,
  mergeSessionSummaryEnrichment,
  SESSION_SUMMARY_ENRICHMENT_VERSION,
  shouldRefreshSessionSummaryNow,
} from "./model.js";
import { getSessionSummaryRunnerPolicy } from "./policy.js";

const BASE_INPUT = {
  sessionSummaryKey: "ss:local:test-session",
  sessionId: "test-session",
  title: "fix flaky summary runner",
  status: "mixed" as const,
  repository: "/repo",
  cwd: "/repo",
  branch: "main",
  intentCount: 2,
  editCount: 3,
  landedEditCount: 2,
  openEditCount: 1,
  messageCount: 3,
  lastActivityMs: 1_200,
  intents: ["diagnose flaky summary runner", "patch claude subprocess"],
  files: [
    { filePath: "/repo/src/summary/llm.ts", editCount: 2, landedCount: 1 },
    { filePath: "/repo/src/summary/loop.ts", editCount: 1, landedCount: 1 },
  ],
  tools: ["Edit", "Bash"],
};

describe("session summary enrichment merge", () => {
  it("marks a hot session stale without making it immediately refreshable", () => {
    const merged = mergeSessionSummaryEnrichment(
      null,
      BASE_INPUT,
      getSessionSummaryRunnerPolicy().policyHash,
      1234,
    );

    expect(merged.summary_source).toBe("deterministic");
    expect(merged.summary_version).toBe(SESSION_SUMMARY_ENRICHMENT_VERSION);
    expect(merged.summary_text).toBeNull();
    expect(merged.dirty).toBe(1);
    expect(merged.dirty_reason_json).toContain("missing");
    expect(merged.dirty_reason_json).toContain("session_hot");
    expect(merged.last_material_change_at_ms).toBe(BASE_INPUT.lastActivityMs);
    expect(
      shouldRefreshSessionSummaryNow(
        {
          enriched_message_count: merged.enriched_message_count,
          last_material_change_at_ms: merged.last_material_change_at_ms,
        },
        BASE_INPUT,
        1234,
      ),
    ).toBe(false);
  });

  it("uses session activity rather than rebuild time for deterministic backlog ordering", () => {
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    const docs = buildDeterministicSessionSummaryDocs(BASE_INPUT);
    const merged = mergeSessionSummaryEnrichment(
      {
        session_summary_key: BASE_INPUT.sessionSummaryKey,
        session_id: BASE_INPUT.sessionId,
        summary_text: null,
        summary_source: "deterministic",
        summary_runner: null,
        summary_model: null,
        summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
        summary_generated_at_ms: null,
        projection_hash: docs.projectionHash,
        summary_input_hash: docs.summaryInputHash,
        summary_policy_hash: null,
        enriched_input_hash: null,
        enriched_message_count: null,
        dirty: 1,
        dirty_reason_json: null,
        last_material_change_at_ms: 9_999,
        last_attempted_at_ms: null,
        failure_count: 0,
        last_error: null,
      },
      BASE_INPUT,
      policyHash,
      10_000,
    );

    expect(merged.summary_source).toBe("deterministic");
    expect(merged.dirty).toBe(1);
    expect(merged.last_material_change_at_ms).toBe(BASE_INPUT.lastActivityMs);
  });

  it("marks a cold session dirty even when it is still small", () => {
    const merged = mergeSessionSummaryEnrichment(
      null,
      {
        ...BASE_INPUT,
        lastActivityMs: 0,
        messageCount: 6,
      },
      getSessionSummaryRunnerPolicy().policyHash,
      7 * 60 * 60 * 1000,
    );

    expect(merged.summary_source).toBe("deterministic");
    expect(merged.dirty).toBe(1);
    expect(merged.dirty_reason_json).toContain("session_cold");
    expect(merged.last_material_change_at_ms).toBe(0);
    expect(
      shouldRefreshSessionSummaryNow(
        {
          enriched_message_count: merged.enriched_message_count,
          last_material_change_at_ms: merged.last_material_change_at_ms,
        },
        {
          ...BASE_INPUT,
          lastActivityMs: 0,
          messageCount: 6,
        },
        7 * 60 * 60 * 1000,
      ),
    ).toBe(true);
  });

  it("preserves an llm summary when the summary input hash is unchanged", () => {
    const docs = buildDeterministicSessionSummaryDocs(BASE_INPUT);
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    const merged = mergeSessionSummaryEnrichment(
      {
        session_summary_key: BASE_INPUT.sessionSummaryKey,
        session_id: BASE_INPUT.sessionId,
        summary_text: "LLM summary text.",
        summary_source: "llm",
        summary_runner: "claude",
        summary_model: "sonnet",
        summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
        summary_generated_at_ms: 1000,
        projection_hash: docs.projectionHash,
        summary_input_hash: docs.summaryInputHash,
        summary_policy_hash: policyHash,
        enriched_input_hash: docs.summaryInputHash,
        enriched_message_count: BASE_INPUT.messageCount,
        dirty: 0,
        dirty_reason_json: null,
        last_material_change_at_ms: null,
        last_attempted_at_ms: 1000,
        failure_count: 0,
        last_error: null,
      },
      BASE_INPUT,
      policyHash,
      2000,
    );

    expect(merged.summary_text).toBe("LLM summary text.");
    expect(merged.summary_source).toBe("llm");
    expect(merged.dirty).toBe(0);
  });

  it("keeps the last llm summary visible while a hot material change is still below refresh thresholds", () => {
    const docs = buildDeterministicSessionSummaryDocs(BASE_INPUT);
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    const merged = mergeSessionSummaryEnrichment(
      {
        session_summary_key: BASE_INPUT.sessionSummaryKey,
        session_id: BASE_INPUT.sessionId,
        summary_text: "LLM summary text.",
        summary_source: "llm",
        summary_runner: "claude",
        summary_model: "sonnet",
        summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
        summary_generated_at_ms: 1000,
        projection_hash: docs.projectionHash,
        summary_input_hash: docs.summaryInputHash,
        summary_policy_hash: policyHash,
        enriched_input_hash: docs.summaryInputHash,
        enriched_message_count: 4,
        dirty: 0,
        dirty_reason_json: null,
        last_material_change_at_ms: 1000,
        last_attempted_at_ms: 1000,
        failure_count: 0,
        last_error: null,
      },
      {
        ...BASE_INPUT,
        intentCount: 3,
        editCount: 4,
        openEditCount: 0,
        messageCount: 5,
        intents: [...BASE_INPUT.intents, "verify final behavior"],
      },
      policyHash,
      3010,
    );

    expect(merged.summary_source).toBe("llm");
    expect(merged.summary_text).toBe("LLM summary text.");
    expect(merged.summary_input_hash).not.toBe(docs.summaryInputHash);
    expect(merged.summary_policy_hash).toBe(policyHash);
    expect(merged.dirty).toBe(1);
    expect(merged.dirty_reason_json).toContain("summary_input_changed");
    expect(merged.dirty_reason_json).toContain("session_hot");
    expect(merged.last_attempted_at_ms).toBeNull();
    expect(merged.failure_count).toBe(0);
    expect(merged.last_error).toBeNull();
    expect(
      shouldRefreshSessionSummaryNow(
        {
          enriched_message_count: merged.enriched_message_count,
          last_material_change_at_ms: merged.last_material_change_at_ms,
        },
        {
          messageCount: 5,
          lastActivityMs: BASE_INPUT.lastActivityMs,
        },
        3010,
      ),
    ).toBe(false);
  });

  it("marks a changed hot session dirty after the message threshold", () => {
    const docs = buildDeterministicSessionSummaryDocs(BASE_INPUT);
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    const merged = mergeSessionSummaryEnrichment(
      {
        session_summary_key: BASE_INPUT.sessionSummaryKey,
        session_id: BASE_INPUT.sessionId,
        summary_text: "LLM summary text.",
        summary_source: "llm",
        summary_runner: "claude",
        summary_model: "sonnet",
        summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
        summary_generated_at_ms: 1000,
        projection_hash: docs.projectionHash,
        summary_input_hash: docs.summaryInputHash,
        summary_policy_hash: policyHash,
        enriched_input_hash: docs.summaryInputHash,
        enriched_message_count: 2,
        dirty: 0,
        dirty_reason_json: null,
        last_material_change_at_ms: 1000,
        last_attempted_at_ms: 1000,
        failure_count: 0,
        last_error: null,
      },
      {
        ...BASE_INPUT,
        messageCount: 25,
        intentCount: 3,
        editCount: 4,
        intents: [...BASE_INPUT.intents, "verify final behavior"],
      },
      policyHash,
      3010,
    );

    expect(merged.summary_source).toBe("llm");
    expect(merged.summary_text).toBe("LLM summary text.");
    expect(merged.dirty).toBe(1);
    expect(merged.dirty_reason_json).toContain("message_threshold_reached");
    expect(
      shouldRefreshSessionSummaryNow(
        {
          enriched_message_count: merged.enriched_message_count,
          last_material_change_at_ms: merged.last_material_change_at_ms,
        },
        {
          messageCount: 25,
          lastActivityMs: BASE_INPUT.lastActivityMs,
        },
        3010,
      ),
    ).toBe(true);
  });

  it("marks message-only growth dirty once the llm summary crosses the threshold", () => {
    const docs = buildDeterministicSessionSummaryDocs(BASE_INPUT);
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    const merged = mergeSessionSummaryEnrichment(
      {
        session_summary_key: BASE_INPUT.sessionSummaryKey,
        session_id: BASE_INPUT.sessionId,
        summary_text: "LLM summary text.",
        summary_source: "llm",
        summary_runner: "claude",
        summary_model: "sonnet",
        summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
        summary_generated_at_ms: 1000,
        projection_hash: docs.projectionHash,
        summary_input_hash: docs.summaryInputHash,
        summary_policy_hash: policyHash,
        enriched_input_hash: docs.summaryInputHash,
        enriched_message_count: BASE_INPUT.messageCount,
        dirty: 0,
        dirty_reason_json: null,
        last_material_change_at_ms: null,
        last_attempted_at_ms: 1000,
        failure_count: 0,
        last_error: null,
      },
      {
        ...BASE_INPUT,
        messageCount: BASE_INPUT.messageCount + 20,
      },
      policyHash,
      2000,
    );

    expect(merged.summary_source).toBe("llm");
    expect(merged.summary_text).toBe("LLM summary text.");
    expect(merged.dirty).toBe(1);
    expect(merged.dirty_reason_json).toContain("message_threshold_reached");
    expect(merged.dirty_reason_json).toContain("refresh_pending");
    expect(
      shouldRefreshSessionSummaryNow(
        {
          enriched_message_count: merged.enriched_message_count,
          last_material_change_at_ms: merged.last_material_change_at_ms,
        },
        {
          messageCount: BASE_INPUT.messageCount + 20,
          lastActivityMs: BASE_INPUT.lastActivityMs,
        },
        2000,
      ),
    ).toBe(true);
  });

  it("prefers the sticky accepted runner before same-as-session inference", () => {
    const selection = selectSessionSummaryRunner({
      sessionTarget: "codex",
      stickyRunner: "claude",
      policy: getSessionSummaryRunnerPolicy(),
      detector: (runner) => `/usr/local/bin/${runner}`,
    });

    expect(selection.runner).toBe("claude");
    expect(selection.attemptedRunners[0]).toBe("claude");
  });

  it("uses the fixed runner before any sticky runner", () => {
    const selection = selectSessionSummaryRunner({
      sessionTarget: "claude",
      stickyRunner: "claude",
      policy: {
        ...getSessionSummaryRunnerPolicy(),
        strategy: "fixed",
        fixedRunner: "codex",
        allowedRunners: ["claude", "codex"],
        fallbackRunners: ["claude"],
      },
      detector: (runner) => `/usr/local/bin/${runner}`,
    });

    expect(selection.runner).toBe("codex");
    expect(selection.attemptedRunners[0]).toBe("codex");
  });

  it("falls back when the inferred session runner is unavailable", () => {
    const selection = selectSessionSummaryRunner({
      sessionTarget: "codex",
      stickyRunner: null,
      policy: {
        ...getSessionSummaryRunnerPolicy(),
        allowedRunners: ["codex", "claude"],
        fallbackRunners: ["claude"],
      },
      detector: (runner) =>
        runner === "claude" ? "/usr/local/bin/claude" : null,
    });

    expect(selection.runner).toBe("claude");
    expect(selection.attemptedRunners).toEqual(["codex", "claude"]);
  });
});
