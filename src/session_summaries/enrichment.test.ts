import { describe, expect, it } from "vitest";
import {
  buildDeterministicSessionSummaryDocs,
  getSessionSummaryRunnerPolicy,
  mergeSessionSummaryEnrichment,
  SESSION_SUMMARY_ENRICHMENT_VERSION,
  selectSessionSummaryRunner,
} from "./enrichment.js";

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
  it("creates a deterministic non-dirty row for a hot session under the threshold", () => {
    const merged = mergeSessionSummaryEnrichment(
      null,
      BASE_INPUT,
      getSessionSummaryRunnerPolicy().policyHash,
      1234,
    );

    expect(merged.summary_source).toBe("deterministic");
    expect(merged.summary_version).toBe(SESSION_SUMMARY_ENRICHMENT_VERSION);
    expect(merged.summary_text).toContain("Status: mixed");
    expect(merged.summary_search_text).toContain("Files:");
    expect(merged.dirty).toBe(0);
    expect(merged.dirty_reason_json).toContain("missing");
    expect(merged.dirty_reason_json).toContain("session_hot");
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
  });

  it("preserves an llm summary when the summary input hash is unchanged", () => {
    const docs = buildDeterministicSessionSummaryDocs(BASE_INPUT);
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    const merged = mergeSessionSummaryEnrichment(
      {
        session_summary_key: BASE_INPUT.sessionSummaryKey,
        session_id: BASE_INPUT.sessionId,
        summary_text: "LLM summary text.",
        summary_search_text: "stale search text",
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
    expect(merged.summary_search_text).toContain("Prompts:");
  });

  it("resets to deterministic text and marks dirty after a material change", () => {
    const docs = buildDeterministicSessionSummaryDocs(BASE_INPUT);
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    const merged = mergeSessionSummaryEnrichment(
      {
        session_summary_key: BASE_INPUT.sessionSummaryKey,
        session_id: BASE_INPUT.sessionId,
        summary_text: "LLM summary text.",
        summary_search_text: docs.summarySearchText,
        summary_source: "llm",
        summary_runner: "claude",
        summary_model: "sonnet",
        summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
        summary_generated_at_ms: 1000,
        projection_hash: docs.projectionHash,
        summary_input_hash: docs.summaryInputHash,
        summary_policy_hash: "stale-policy-hash",
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

    expect(merged.summary_source).toBe("deterministic");
    expect(merged.summary_text).not.toBe("LLM summary text.");
    expect(merged.summary_policy_hash).toBe(policyHash);
    expect(merged.dirty).toBe(0);
    expect(merged.dirty_reason_json).toContain("summary_input_changed");
    expect(merged.dirty_reason_json).toContain("session_hot");
  });

  it("marks a changed hot session dirty after the message threshold", () => {
    const docs = buildDeterministicSessionSummaryDocs(BASE_INPUT);
    const policyHash = getSessionSummaryRunnerPolicy().policyHash;
    const merged = mergeSessionSummaryEnrichment(
      {
        session_summary_key: BASE_INPUT.sessionSummaryKey,
        session_id: BASE_INPUT.sessionId,
        summary_text: "LLM summary text.",
        summary_search_text: docs.summarySearchText,
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

    expect(merged.summary_source).toBe("deterministic");
    expect(merged.dirty).toBe(1);
    expect(merged.dirty_reason_json).toContain("message_threshold_reached");
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
