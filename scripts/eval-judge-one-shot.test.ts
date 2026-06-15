import { describe, expect, it } from "vitest";
import {
  buildOneShotJudgePrompt,
  buildPairwiseImpacts,
  buildResourceUsageDelta,
  computeOutcomeDiagnostics,
  parseJudgeResponse,
} from "./eval-judge-one-shot.js";

describe("one-shot outcome judge", () => {
  it("parses fenced JSON judge responses", () => {
    expect(
      parseJudgeResponse(
        '```json\n{"none":"accomplished","panop":"partial","quality_vs_original":{"none":"better","panop":"same"},"notes":"ok","quality_notes":"quality ok"}\n```',
        ["none", "panop"],
      ),
    ).toEqual({
      verdicts: { none: "accomplished", panop: "partial" },
      qualityVsOriginal: { none: "better", panop: "same" },
      notes: "ok",
      qualityNotes: "quality ok",
    });
  });

  it("returns unknown verdicts when the judge output is not parseable", () => {
    expect(parseJudgeResponse("not json", ["none"])).toEqual({
      verdicts: { none: "unknown" },
      qualityVsOriginal: { none: "unknown" },
      notes: "judge parse failed",
      qualityNotes: "judge parse failed",
    });
  });

  it("computes exact-file diagnostics without making them the outcome verdict", () => {
    expect(
      computeOutcomeDiagnostics(
        ["src/sync/loop.ts"],
        ["src/sync/post.ts", "src/sync/post.test.ts"],
      ),
    ).toEqual({
      matched_expected_files: [],
      unexpected_files: ["src/sync/post.ts", "src/sync/post.test.ts"],
      file_recall: 0,
      exact_file_set: false,
    });
  });

  it("computes paired control versus treatment impact", () => {
    const baseArm = {
      worktree: "/tmp/wt",
      worktree_exists: true,
      status: "",
      matched_expected_files: [],
      diff_summary: "",
      diff_patch: "",
      diff_patch_truncated: false,
      final_message_path: null,
      final_message_excerpt: null,
      resource_usage: unavailableUsage("/tmp/wt"),
    };

    expect(
      buildPairwiseImpacts(
        [
          {
            ...baseArm,
            arm: "none",
            changed_files: ["src/a.ts"],
            unexpected_files: ["src/a.ts"],
            file_recall: 0,
            exact_file_set: false,
          },
          {
            ...baseArm,
            arm: "panop",
            changed_files: ["src/a.ts", "src/b.ts"],
            unexpected_files: ["src/a.ts", "src/b.ts"],
            file_recall: 0.5,
            exact_file_set: false,
          },
        ],
        { none: "partial", panop: "accomplished" },
        { none: "same", panop: "better" },
      ),
    ).toEqual([
      {
        control_arm: "none",
        treatment_arm: "panop",
        outcome: "win",
        control_verdict: "partial",
        treatment_verdict: "accomplished",
        verdict_delta: 1,
        control_quality_vs_original: "same",
        treatment_quality_vs_original: "better",
        quality_delta: 1,
        file_recall_delta: 0.5,
        unexpected_files_delta: 1,
        changed_files_delta: 1,
        exact_file_set_change: "same",
        resource_usage_delta: {
          control_available: false,
          treatment_available: false,
          elapsed_ms_delta: null,
          elapsed_pct_delta: null,
          turn_delta: null,
          turn_pct_delta: null,
          input_token_delta: null,
          input_token_pct_delta: null,
          cache_read_token_delta: null,
          cache_read_token_pct_delta: null,
          context_token_delta: null,
          context_token_pct_delta: null,
          output_token_delta: null,
          output_token_pct_delta: null,
          reasoning_token_delta: null,
          reasoning_token_pct_delta: null,
          total_token_delta: null,
          total_token_pct_delta: null,
          estimated_cost_usd_delta: null,
          estimated_cost_pct_delta: null,
          tool_call_delta: null,
          tool_call_pct_delta: null,
          tool_duration_ms_delta: null,
          tool_duration_pct_delta: null,
        },
      },
    ]);
  });

  it("computes resource usage deltas for matched replay sessions", () => {
    const delta = buildResourceUsageDelta(
      availableUsage({
        context_tokens: 1000,
        total_tokens: 1100,
        estimated_cost_usd: 0.1,
        turn_count: 10,
      }),
      availableUsage({
        context_tokens: 750,
        total_tokens: 850,
        estimated_cost_usd: 0.08,
        turn_count: 8,
      }),
    );

    expect(delta).toMatchObject({
      control_available: true,
      treatment_available: true,
      context_token_delta: -250,
      context_token_pct_delta: -25,
      total_token_delta: -250,
      turn_delta: -2,
      turn_pct_delta: -20,
    });
    expect(delta?.estimated_cost_usd_delta).toBeCloseTo(-0.02);
  });

  it("builds a behavior-first rubric that allows alternate patch shape", () => {
    const prompt = buildOneShotJudgePrompt({
      row: {
        pr_number: 122,
        title: "Add sync version header",
        expected_files: ["src/sync/loop.ts"],
      },
      userGoal: "Add the required sync version header.",
      expectedDiffstat: "src/sync/loop.ts | 8 ++++++++",
      expectedPatch: {
        value: "diff --git a/src/sync/loop.ts",
        truncated: false,
      },
      arms: [
        {
          arm: "none",
          worktree: "/tmp/wt",
          worktree_exists: true,
          status: " M src/sync/post.ts",
          changed_files: ["src/sync/post.ts"],
          matched_expected_files: [],
          unexpected_files: ["src/sync/post.ts"],
          file_recall: 0,
          exact_file_set: false,
          diff_summary: "src/sync/post.ts | 9 +++++++++",
          diff_patch: "diff --git a/src/sync/post.ts",
          diff_patch_truncated: false,
          final_message_path: null,
          final_message_excerpt: "Implemented at the shared post boundary.",
          resource_usage: unavailableUsage("/tmp/wt"),
        },
      ],
    });

    expect(prompt).toContain(
      "Treat deterministic file-set diagnostics as evidence",
    );
    expect(prompt).toContain("Quality-vs-original rubric");
    expect(prompt).toContain("Do not mark an attempt partial solely");
    expect(prompt).toContain('"none":"accomplished|partial|failed"');
    expect(prompt).toContain('"quality_vs_original"');
  });
});

function unavailableUsage(worktree: string) {
  return {
    available: false,
    source: "panopticon_db",
    db_path: null,
    worktree,
    reason: "test",
  } as const;
}

function availableUsage(
  overrides: Partial<{
    elapsed_ms: number | null;
    turn_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    reasoning_tokens: number;
    context_tokens: number;
    total_tokens: number;
    estimated_cost_usd: number | null;
    tool_calls: number;
    tool_duration_ms: number | null;
  }> = {},
) {
  return {
    available: true,
    source: "panopticon_db",
    db_path: "/tmp/panopticon.db",
    matched_by: "session_cwds.cwd",
    worktree: "/tmp/wt",
    session_id: "session",
    model: "gpt-test",
    started_at_ms: 1000,
    ended_at_ms: 2000,
    elapsed_ms: 1000,
    turn_count: 1,
    message_count: 1,
    user_message_count: 1,
    input_tokens: 100,
    output_tokens: 100,
    cache_read_tokens: 800,
    cache_creation_tokens: 0,
    reasoning_tokens: 25,
    context_tokens: 900,
    total_tokens: 1000,
    estimated_cost_usd: 0.01,
    pricing: null,
    tool_calls: 1,
    tool_duration_ms: 10,
    ...overrides,
  } as const;
}
