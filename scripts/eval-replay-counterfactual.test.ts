import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessReplayCandidate,
  assessScenarioWindow,
  buildJudgePrompt,
  buildMarkdownReport,
  buildPromptWindowTrace,
  buildReplayAppendSystemPrompt,
  buildReplayExcludeSessionIds,
  candidateFilterReasons,
  computeAggregate,
  dedupeRecomputedResults,
  dedupeReplayCandidateWindows,
  expandRecomputeInputFiles,
  extractFixtureRows,
  hasRequiredInjectionSurface,
  isSqliteBusyError,
  parseArgs,
  priorOutcomeKeyForScenario,
  selectPreWindowContext,
  selectPromptWindow,
  sortReplayCandidates,
  summarizePriorReplayOutcomes,
  summarizeReasonCounts,
  withSqliteBusyRetry,
} from "./eval-replay-counterfactual.js";

function hook(overrides: Record<string, unknown> = {}) {
  return {
    windowStartMs: 1,
    windowEndMs: 2,
    sessionIds: ["replay-session"],
    eventCounts: {},
    sessionStartCount: 1,
    userPromptSubmitCount: 2,
    userPromptSubmitInjectionOpportunities: 2,
    matchedUserPromptSubmitInjectionOpportunities: 2,
    missingUserPromptSubmitReplayPrompts: [],
    userPromptSubmitPrompts: ["turn 1", "turn 2"],
    payloadOnlyMentionCount: 0,
    payloadOnlyMentionSessionIds: [],
    ...overrides,
  };
}

function arm(
  armName: "none" | "panop" | "crg" | "panop+crg",
  overrides: Record<string, unknown> = {},
) {
  const promptCount =
    typeof overrides.promptCount === "number" ? overrides.promptCount : 3;
  return {
    arm: armName,
    durationMs: 1000,
    totalTokens: 1000,
    exitOk: true,
    diffSummary: "",
    diffPatch: "",
    diffPatchTruncated: false,
    outcomeDiagnostics: null,
    hostRepoStatusChanged: false,
    hostRepoStatusBefore: "",
    hostRepoStatusAfter: "",
    crgContextTokens: 0,
    turnsCompleted: promptCount,
    promptCount,
    userPromptInjectionOpportunities: Math.max(0, promptCount - 1),
    replaySessionIds: ["replay-session"],
    hookDiagnostics: hook(),
    turnResults: [],
    ...overrides,
  };
}

function outcome(fileRecall: number, unexpectedFiles: string[] = []) {
  return {
    expectedFiles: ["src/a.ts"],
    changedFiles: fileRecall === 1 ? ["src/a.ts", ...unexpectedFiles] : [],
    matchedExpectedFiles: fileRecall === 1 ? ["src/a.ts"] : [],
    unexpectedFiles,
    fileRecall,
    exactFileSet: fileRecall === 1 && unexpectedFiles.length === 0,
  };
}

function scenario(prompts: string[]) {
  return {
    session_id: "scenario",
    head_sha: "abc123",
    anchor: "exact",
    started_at_ms: 1_700_000_000_000,
    first_prompt: prompts[0] ?? "",
    prompts,
  };
}

describe("replay aggregate reliability gates", () => {
  it("adds isolation rules to the first-turn system prompt for every arm", () => {
    const prompt = buildReplayAppendSystemPrompt(
      "/tmp/pano-replay-demo",
      "/Users/gus/workspace/panopticon",
      "extra context",
    );

    expect(prompt).toContain(
      "Do not edit, write, install into, tag, push from, or create PRs",
    );
    expect(prompt).toContain("Make the smallest code change necessary");
    expect(prompt).toContain("extra context");
  });

  it("retries transient SQLite busy failures during replay diagnostics", () => {
    let attempts = 0;
    expect(
      withSqliteBusyRetry("test busy retry", () => {
        attempts += 1;
        if (attempts < 3) throw new Error("database is locked");
        return "ok";
      }),
    ).toBe("ok");
    expect(attempts).toBe(3);
    expect(isSqliteBusyError(new Error("SQLITE_BUSY"))).toBe(true);
    expect(isSqliteBusyError(new Error("no such table"))).toBe(false);
  });

  it("adds neutral pre-window prompt context without making it executable history", () => {
    const prompt = buildReplayAppendSystemPrompt(
      "/tmp/pano-replay-demo",
      "/Users/gus/workspace/panopticon",
      "extra context",
      ["first analyze the issue", "now we know the scanner path is involved"],
      4,
    );

    expect(prompt).toContain(
      "Historical prompts before this replay window (neutral context only)",
    );
    expect(prompt).toContain(
      "Do not execute tasks requested only in this history",
    );
    expect(prompt).toContain("Historical turn 5: first analyze the issue");
    expect(prompt).toContain(
      "Historical turn 6: now we know the scanner path is involved",
    );
    expect(prompt.indexOf("Historical prompts")).toBeLessThan(
      prompt.indexOf("extra context"),
    );
    expect(
      buildReplayAppendSystemPrompt(
        "/tmp/pano-replay-demo",
        "/Users/gus/workspace/panopticon",
        "extra context",
      ),
    ).not.toContain("Historical prompts");
  });

  it("excludes historical, prior-arm, and current-arm replay sessions from injection", () => {
    expect(
      buildReplayExcludeSessionIds(
        "historical",
        ["baseline-1", "baseline-2", "baseline-1"],
        "panop-1",
        "",
        "panop-1",
      ),
    ).toEqual(["historical", "baseline-1", "baseline-2", "panop-1"]);
  });

  it("selects an around-action prompt window with a measurable pre-action prompt", () => {
    expect(
      selectPromptWindow(
        [
          "call the list_user_configs MCP tool",
          "list repo configs",
          "why do we care about the git identity?",
          "still lets fix it on the scanner path to make it complete",
          "continue",
        ],
        {
          mode: "around-action",
          maxPrompts: 3,
          actionContextPrompts: 1,
          actionFollowupPrompts: 1,
        },
      ),
    ).toEqual({
      startIndex: 2,
      prompts: [
        "why do we care about the git identity?",
        "still lets fix it on the scanner path to make it complete",
        "continue",
      ],
    });
  });

  it("selects bounded neutral context immediately before the replay window", () => {
    expect(
      selectPreWindowContext(
        ["turn 1", "turn 2", "turn 3", "turn 4", "turn 5"],
        4,
        2,
      ),
    ).toEqual({
      startIndex: 2,
      prompts: ["turn 3", "turn 4"],
    });
    expect(selectPreWindowContext(["turn 1", "turn 2"], 0, 4)).toEqual({
      startIndex: 0,
      prompts: [],
    });
  });

  it("records selected prompt windows with historical turn numbers", () => {
    const trace = buildPromptWindowTrace(
      {
        ...scenario(["selected setup", "selected action"]),
        original_prompt_offset: 4,
        pre_window_prompts: ["earlier finding", "immediate prior prompt"],
        pre_window_prompt_offset: 2,
      } as never,
      { windowMode: "around-relevant-action" } as never,
    );

    expect(trace).toMatchObject({
      mode: "around-relevant-action",
      promptStartTurn: 5,
      promptEndTurn: 6,
      promptCount: 2,
      prompts: [
        { turn: 5, charCount: 14, text: "selected setup" },
        { turn: 6, charCount: 15, text: "selected action" },
      ],
      preWindowContext: {
        promptStartTurn: 3,
        promptEndTurn: 4,
        promptCount: 2,
        prompts: [
          { turn: 3, text: "earlier finding" },
          { turn: 4, text: "immediate prior prompt" },
        ],
      },
    });
  });

  it("scores replay candidates before spending on live arms", () => {
    const strong = assessReplayCandidate({
      ...scenario([
        "we need to update sync target auth files",
        "lets rename env.json to target auth files",
      ]),
      pr_number: 127,
      pr_title: "Rename sync target auth files",
      expected_diffstat:
        "src/sync/targets.ts | 8 ++++++++\n 1 file changed, 8 insertions(+)",
    } as never);

    expect(strong).toMatchObject({
      label: "strong",
      expectedFileCount: 1,
    });
    expect(strong.score).toBeGreaterThanOrEqual(70);
    expect(strong.reasons).toContain("single-file PR oracle");

    const broad = assessReplayCandidate({
      ...scenario([
        "we need to update sync target auth files",
        "lets rename env.json to target auth files",
      ]),
      pr_number: 127,
      pr_title: "Rename sync target auth files",
      expected_diffstat: [
        "src/sync/targets.ts | 8 ++++++++",
        "src/sync/target-auth.ts | 8 ++++++++",
        "src/sync/index.ts | 8 ++++++++",
        "src/sync/types.ts | 8 ++++++++",
        "src/cli.ts | 8 ++++++++",
        "src/db/store.ts | 8 ++++++++",
        "src/db/query.ts | 8 ++++++++",
        " 7 files changed, 56 insertions(+)",
      ].join("\n"),
    } as never);

    expect(broad.label).toBe("medium");
    expect(broad.score).toBeLessThan(80);
    expect(broad.risks).toContain("7-file PR oracle is broad");

    const irrelevant = assessReplayCandidate({
      ...scenario(["ok describe the changes again", "ok lets update it now"]),
      pr_number: 135,
      pr_title: "Propagate release value",
      expected_diffstat:
        "src/release.ts | 8 ++++++++\nsrc/config.ts | 2 ++\n 2 files changed, 10 insertions(+)",
    } as never);

    expect(irrelevant.score).toBeLessThan(70);
    expect(irrelevant.label).toBe("medium");
    expect(irrelevant.risks).toContain(
      "selected prompts do not match PR title or diffstat terms",
    );

    const moderateRelevance = assessReplayCandidate({
      ...scenario([
        "we should clean up install docs",
        "remove pnpm exec from the docs",
      ]),
      pr_number: 37,
      pr_title: "Remove npm/yarn engine guards",
      expected_diffstat: "package.json | 2 --\n 1 file changed, 2 deletions(-)",
    } as never);

    expect(moderateRelevance.score).toBeGreaterThanOrEqual(80);
    expect(moderateRelevance.relevanceScore).toBeGreaterThanOrEqual(4);
    expect(moderateRelevance.relevanceScore).toBeLessThan(8);
    expect(moderateRelevance.label).toBe("medium");
    expect(moderateRelevance.risks).toContain(
      "selected prompts match PR terms but not strongly enough for strict replay",
    );

    const genericInstallerOverlap = assessReplayCandidate({
      ...scenario([
        "the user might have other hooks installed we can't upset that",
        "as long as the stale paths are cleaned up in the uninstall file you wrote we do not need to handle them on install",
      ]),
      pr_number: 40,
      pr_title: "Support npx install for panopticon",
      expected_diffstat:
        "src/cli.ts | 91 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++----\n 1 file changed, 86 insertions(+), 5 deletions(-)",
    } as never);

    expect(genericInstallerOverlap.relevanceScore).toBeLessThan(4);
    expect(genericInstallerOverlap.label).toBe("medium");
    expect(genericInstallerOverlap.risks).toContain(
      "selected prompts weakly match PR terms",
    );

    const weak = assessReplayCandidate({
      ...scenario([
        "explain the prior work",
        "explain the prior work in more detail",
      ]),
      anchor: "approx",
    } as never);

    expect(weak.label).toBe("weak");
    expect(weak.risks).toContain("approximate commit anchor");
    expect(weak.risks).toContain("no merged-PR oracle");
    expect(weak.risks).toContain("selected replay prompts are near-duplicates");

    const nonMeasurableRelevant = assessReplayCandidate({
      ...scenario([
        "the schema migration system treated pre-migration databases as fresh",
        "all of the panopticon tables we care about are panopticon_v2",
      ]),
      pr_number: 135,
      pr_title: "Fix migration system treating pre-migration DBs as fresh",
      expected_diffstat:
        "src/db/migrations.ts | 8 ++++++++\nsrc/db/store.ts | 2 ++\n 2 files changed, 10 insertions(+)",
    } as never);

    expect(nonMeasurableRelevant.label).toBe("weak");
    expect(nonMeasurableRelevant.score).toBeLessThan(50);
    expect(nonMeasurableRelevant.risks).toContain(
      "bounded window has no likely mid-session action prompt; PR-diff outcome judging may be uninformative",
    );

    const setupOnly = assessReplayCandidate({
      ...scenario([
        "if we wanted proper docker integration tests, how might we do it?",
        "lets make a new worktree so we don't mess up the main repo",
      ]),
      pr_number: 63,
      pr_title: "Add Docker-based integration tests",
      expected_diffstat:
        ".github/workflows/ci.yml | 3 +++\nsrc/server.integration.test.ts | 695 +++\n 2 files changed, 698 insertions(+)",
    } as never);

    expect(setupOnly.label).toBe("weak");
    expect(setupOnly.risks).toContain(
      "selected action prompt is setup-only, not the PR change",
    );

    const multiIssue = assessReplayCandidate({
      ...scenario([
        "lets leave it and go back to tip of main",
        [
          "here are a few bugs detected by claude:",
          "1. bug_001 normal src/scanner/reparse.ts",
          "2. bug_004 normal src/hooks/ingest.ts",
          "3. bug_006 nit src/cli.ts",
        ].join("\n"),
      ]),
      anchor: "exact",
      pr_number: 189,
      pr_title: "CLI: add friendly labels for claims_rebuild scanner phases",
      expected_diffstat: "src/cli.ts | 10 ++++++++++\n 1 file changed",
    } as never);

    expect(multiIssue.label).not.toBe("strong");
    expect(multiIssue.risks).toContain(
      "selected action prompt lists 3 issues for a 1-file PR oracle",
    );
  });

  it("ranks stronger PR/window matches before applying expensive replay limits", () => {
    const prompts = [
      "how can we fix fml --version?",
      "lets add fml update and fml install --force",
    ];
    const weakOracle = {
      ...scenario(prompts),
      pr_number: 44,
      pr_title: "Fix CD version parsing for pre-release suffixes",
      expected_diffstat: ".github/workflows/cd.yml | 2 ++",
    };
    const strongOracle = {
      ...scenario(prompts),
      pr_number: 45,
      pr_title:
        "Add panopticon update, install --force reinstall, fix --version",
      expected_diffstat:
        "src/cli.ts | 57 +++++++++++++++++++++++++++++++++++++++++++++++++++++++--",
    };

    const ranked = sortReplayCandidates([weakOracle, strongOracle] as never);
    expect(ranked).toEqual([strongOracle, weakOracle]);
    expect(
      dedupeReplayCandidateWindows(
        ranked as never,
        parseArgs(["--action-pair"]),
      ),
    ).toEqual([strongOracle]);
    expect(
      priorOutcomeKeyForScenario(
        strongOracle as never,
        parseArgs(["--action-pair"]),
      ),
    ).toBe("scenario|45|around-relevant-action|1|2|0");
  });

  it("summarizes prior replay outcomes for dry-run candidate overlays", () => {
    const prior = summarizePriorReplayOutcomes([
      {
        source: "prior.json",
        args: parseArgs(["--action-pair"]),
        results: [
          {
            session_id: "prior-ready",
            pr_number: 1,
            arms: {
              none: arm("none", { outcomeDiagnostics: outcome(1) }),
              panop: arm("panop", { outcomeDiagnostics: outcome(1) }),
            },
            verdicts: { none: "accomplished", panop: "accomplished" },
          },
          {
            session_id: "prior-blocked",
            pr_number: 2,
            arms: {
              none: arm("none", {
                outcomeDiagnostics: outcome(1, ["src/extra.ts"]),
              }),
              panop: arm("panop", { outcomeDiagnostics: outcome(1) }),
            },
            verdicts: { none: "accomplished", panop: "accomplished" },
          },
        ] as never,
      },
    ]);

    expect(
      prior.get("prior-ready|1|legacy|unknown-start|unknown-count|0"),
    ).toMatchObject({
      attempts: 1,
      strictReady: 1,
      blockers: {},
      armExactFileSet: { none: 1, panop: 1 },
      exactFileSetWins: {},
      sources: ["prior.json"],
    });
    expect(
      prior.get("prior-blocked|2|legacy|unknown-start|unknown-count|0"),
    ).toMatchObject({
      attempts: 1,
      totalAttempts: 1,
      incompatibleAttempts: 0,
      strictReady: 0,
      blockers: { missing_exact_pr_scope: 1 },
      armExactFileSet: { panop: 1 },
      exactFileSetWins: { panop: 1 },
    });
  });

  it("deduplicates prior replay overlays and separates incompatible prompt shapes", () => {
    const compatibleResult = {
      session_id: "prior-ready",
      pr_number: 1,
      promptCount: 2,
      promptWindow: {
        mode: "around-relevant-action",
        promptCount: 2,
        prompts: [
          { turn: 4, charCount: 8, text: "context" },
          { turn: 5, charCount: 6, text: "action" },
        ],
        preWindowContext: { promptCount: 0, prompts: [] },
      },
      arms: {
        none: arm("none", {
          replaySessionIds: ["none-compatible"],
          outcomeDiagnostics: outcome(1),
          promptCount: 2,
        }),
        panop: arm("panop", {
          replaySessionIds: ["panop-compatible"],
          outcomeDiagnostics: outcome(1),
          promptCount: 2,
        }),
      },
      verdicts: { none: "accomplished", panop: "accomplished" },
    };
    const incompatibleResult = {
      ...compatibleResult,
      promptCount: 3,
      promptWindow: {
        ...compatibleResult.promptWindow,
        promptCount: 3,
        prompts: [
          ...compatibleResult.promptWindow.prompts,
          { turn: 6, charCount: 6, text: "follow" },
        ],
      },
      arms: {
        none: arm("none", {
          replaySessionIds: ["none-incompatible"],
          outcomeDiagnostics: outcome(1),
          promptCount: 3,
        }),
        panop: arm("panop", {
          replaySessionIds: ["panop-incompatible"],
          outcomeDiagnostics: outcome(1),
          promptCount: 3,
        }),
      },
    };

    const prior = summarizePriorReplayOutcomes(
      [
        {
          source: "compatible.json",
          args: parseArgs(["--action-pair"]),
          results: [compatibleResult] as never,
        },
        {
          source: "compatible-copy.json",
          args: parseArgs(["--action-pair"]),
          results: [compatibleResult] as never,
        },
        {
          source: "older-shape.json",
          args: parseArgs(["--max-prompts", "3"]),
          results: [incompatibleResult] as never,
        },
      ],
      parseArgs(["--action-pair"]),
    );

    expect(
      prior.get("prior-ready|1|around-relevant-action|4|2|0"),
    ).toMatchObject({
      attempts: 1,
      totalAttempts: 1,
      incompatibleAttempts: 0,
      strictReady: 1,
      armExactFileSet: { none: 1, panop: 1 },
      sources: ["compatible.json"],
    });
    expect(
      prior.get("prior-ready|1|around-relevant-action|4|3|0"),
    ).toMatchObject({
      attempts: 0,
      totalAttempts: 1,
      incompatibleAttempts: 1,
      strictReady: 0,
      sources: ["older-shape.json"],
    });
  });

  it("provides an action-pair preset for the reliable PR-scope replay shape", () => {
    expect(parseArgs(["--action-pair"])).toMatchObject({
      windowMode: "around-relevant-action",
      actionContextPrompts: 1,
      actionFollowupPrompts: 0,
      maxPrompts: 2,
    });
    expect(parseArgs(["--action-pair", "--max-prompts", "3"])).toMatchObject({
      windowMode: "around-relevant-action",
      actionContextPrompts: 1,
      actionFollowupPrompts: 0,
      maxPrompts: 3,
    });
    expect(parseArgs(["--report-markdown", "report.md"])).toMatchObject({
      reportMarkdown: "report.md",
    });
    expect(parseArgs(["--pr-number", "41"])).toMatchObject({
      prNumber: 41,
    });
    expect(parseArgs(["--prior-result-json", "prior.json"])).toMatchObject({
      priorResultJson: ["prior.json"],
    });
    expect(parseArgs(["--rejudge"])).toMatchObject({
      rejudge: true,
    });
    expect(parseArgs(["--judge-runner", "codex"])).toMatchObject({
      judgeRunner: "codex",
    });
    expect(
      parseArgs([
        "--candidate-label",
        "strong",
        "--min-candidate-score",
        "90",
        "--min-relevance-score",
        "4",
        "--max-expected-files",
        "3",
        "--skip-prior-attempted",
        "--skip-prior-strict-ready",
      ]),
    ).toMatchObject({
      minCandidateLabel: "strong",
      minCandidateScore: 90,
      minRelevanceScore: 4,
      maxExpectedFiles: 3,
      skipPriorAttempted: true,
      skipPriorStrictReady: true,
    });
  });

  it("filters candidates before spending on expensive replay arms", () => {
    const args = parseArgs([
      "--candidate-label",
      "strong",
      "--min-candidate-score",
      "90",
      "--min-relevance-score",
      "4",
      "--max-expected-files",
      "3",
      "--skip-prior-attempted",
    ]);
    const strongUntested = {
      ...scenario([
        "we need to update sync target auth files",
        "lets rename env.json to target auth files",
      ]),
      pr_number: 127,
      pr_title: "Rename sync target auth files",
      expected_diffstat:
        "src/sync/targets.ts | 8 ++++++++\n 1 file changed, 8 insertions(+)",
    } as never;
    const broad = {
      ...strongUntested,
      expected_diffstat: [
        "src/sync/targets.ts | 8 ++++++++",
        "src/sync/target-auth.ts | 8 ++++++++",
        "src/sync/index.ts | 8 ++++++++",
        "src/sync/types.ts | 8 ++++++++",
        "src/cli.ts | 8 ++++++++",
        "src/db/store.ts | 8 ++++++++",
        "src/db/query.ts | 8 ++++++++",
        " 7 files changed, 56 insertions(+)",
      ].join("\n"),
    } as never;

    expect(candidateFilterReasons(strongUntested, args)).toEqual([]);
    expect(
      candidateFilterReasons(strongUntested, args, {
        attempts: 1,
        totalAttempts: 1,
        incompatibleAttempts: 0,
        strictReady: 0,
        blockers: {},
        armExactFileSet: {},
        exactFileSetWins: {},
        sources: [],
      }),
    ).toContain("prior_current_shape_attempted");
    expect(
      candidateFilterReasons(
        strongUntested,
        parseArgs(["--skip-prior-strict-ready"]),
        {
          attempts: 1,
          totalAttempts: 1,
          incompatibleAttempts: 0,
          strictReady: 0,
          blockers: { missing_injection_surface: 1 },
          armExactFileSet: {},
          exactFileSetWins: {},
          sources: [],
        },
      ),
    ).toEqual([]);
    expect(
      candidateFilterReasons(
        strongUntested,
        parseArgs(["--skip-prior-strict-ready"]),
        {
          attempts: 1,
          totalAttempts: 1,
          incompatibleAttempts: 0,
          strictReady: 1,
          blockers: {},
          armExactFileSet: {},
          exactFileSetWins: {},
          sources: [],
        },
      ),
    ).toContain("prior_current_shape_strict_ready");
    expect(candidateFilterReasons(broad, args)).toEqual(
      expect.arrayContaining([
        "candidate_label_below_strong",
        "candidate_score_below_90",
        "expected_files_above_3",
      ]),
    );
    expect(
      candidateFilterReasons(
        {
          ...strongUntested,
          prompts: ["describe the release", "lets update it now"],
          pr_title: "Rename sync target auth files",
        } as never,
        args,
      ),
    ).toContain("relevance_score_below_4");
    expect(
      summarizeReasonCounts([
        ["candidate_score_below_90", "expected_files_above_3"],
        ["expected_files_above_3"],
      ]),
    ).toEqual({
      candidate_score_below_90: 1,
      expected_files_above_3: 2,
    });
  });

  it("dedupes recomputed attempts by scenario window and keeps the strongest evidence", () => {
    const args = parseArgs(["--action-pair", "--execute"]);
    const staleBlocked = {
      session_id: "duplicate",
      pr_number: 122,
      promptCount: 2,
      originalPromptCount: 10,
      promptStartTurn: 30,
      candidate: { score: 100, label: "strong", reasons: [], risks: [] },
      priorOutcome: null,
      promptWindow: {
        mode: "around-relevant-action",
        promptStartTurn: 30,
        promptEndTurn: 31,
        promptCount: 2,
        prompts: [],
        preWindowContext: {
          promptStartTurn: null,
          promptEndTurn: null,
          promptCount: 0,
          prompts: [],
        },
      },
      window: {
        userPromptInjectionOpportunities: 1,
        likelyActionPromptTurn: 2,
        measurable: true,
        warnings: [],
      },
      arms: {
        none: arm("none", { promptCount: 2, outcomeDiagnostics: outcome(1) }),
        panop: arm("panop", {
          promptCount: 2,
          hookDiagnostics: hook({
            matchedUserPromptSubmitInjectionOpportunities: undefined,
          }),
          outcomeDiagnostics: outcome(1),
        }),
      },
      verdicts: { none: "accomplished", panop: "accomplished" },
      judgeNotes: "stale blocked artifact",
    } as never;
    const freshScopeReady = {
      ...staleBlocked,
      arms: {
        none: arm("none", { promptCount: 2, outcomeDiagnostics: outcome(1) }),
        panop: arm("panop", {
          promptCount: 2,
          outcomeDiagnostics: outcome(1),
        }),
      },
      verdicts: { none: "partial", panop: "partial" },
      judgeNotes: "fresh prompt-matched artifact",
    } as never;

    expect(
      dedupeRecomputedResults([staleBlocked, freshScopeReady], args),
    ).toEqual([freshScopeReady]);
    expect(
      dedupeRecomputedResults([freshScopeReady, staleBlocked], args),
    ).toEqual([freshScopeReady]);
  });

  it("expands nested recompute sources when rejudge needs leaf fixture args", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-recompute-"));
    const leafA = path.join(dir, "leaf-a.json");
    const leafB = path.join(dir, "leaf-b.json");
    const nested = path.join(dir, "nested.json");
    const top = path.join(dir, "top.json");

    fs.writeFileSync(leafA, JSON.stringify({ args: {}, results: [] }));
    fs.writeFileSync(leafB, JSON.stringify({ args: {}, results: [] }));
    fs.writeFileSync(
      nested,
      JSON.stringify({ sources: [leafA], args: {}, results: [] }),
    );
    fs.writeFileSync(
      top,
      JSON.stringify({ sources: [nested, leafB], args: {}, results: [] }),
    );

    expect(expandRecomputeInputFiles([top], { expandSources: false })).toEqual([
      top,
    ]);
    expect(expandRecomputeInputFiles([top], { expandSources: true })).toEqual([
      leafA,
      leafB,
    ]);
  });

  it("accepts candidate fixture wrappers as replay fixture rows", () => {
    expect(
      extractFixtureRows({
        candidates: [
          {
            session_id: "session",
            pr_number: 122,
            merge_commit: "abc123",
          },
        ],
      }),
    ).toEqual([
      {
        session_id: "session",
        pr_number: 122,
        merge_commit: "abc123",
      },
    ]);
  });

  it("reports fixture hydration and candidate filtering in dry-run markdown", () => {
    const markdown = buildMarkdownReport({
      generatedAt: "2026-05-20T00:00:00.000Z",
      sources: ["dry-run.json"],
      args: parseArgs([]),
      fixtureLoadSummary: {
        source: "candidates.all-pr-pairs.json",
        rawRowCount: 79,
        loadedScenarioCount: 8,
        droppedRowCount: 71,
        droppedReasonCounts: { missing_local_prompts: 71 },
      },
      selectionSummary: {
        rawScenarioCount: 8,
        nonMeasurableSkippedCount: 1,
        candidateSkippedCount: 7,
        candidateSkippedReasonCounts: {
          candidate_label_below_strong: 6,
          prior_current_shape_attempted: 1,
        },
        duplicateWindowSkippedCount: 0,
        candidatePassedCount: 0,
        limit: 20,
        limitedOutCount: 0,
        selectedCount: 0,
      },
      aggregate: null,
      results: [],
    });

    expect(markdown).toContain("## Corpus Selection");
    expect(markdown).toContain("- Fixture rows: 79");
    expect(markdown).toContain("- Hydrated scenarios: 8");
    expect(markdown).toContain("- Dropped fixture rows: 71");
    expect(markdown).toContain(
      "- Fixture drop reasons: missing_local_prompts=71",
    );
    expect(markdown).toContain("- Candidate input scenarios: 8");
    expect(markdown).toContain("- Selected scenarios: 0");
    expect(markdown).toContain(
      "- Candidate filter reasons: candidate_label_below_strong=6, prior_current_shape_attempted=1",
    );
  });

  it("instructs the judge not to treat harmless implementation differences as partial", () => {
    const prompt = buildJudgePrompt("Ground truth", [
      arm("none", {
        promptCount: 2,
        diffPatch: "diff --git a/src/sync/loop.ts b/src/sync/loop.ts",
        outcomeDiagnostics: outcome(1),
      }),
    ] as never);

    expect(prompt).toContain(
      "externally relevant behavior/change, even if code organization",
    );
    expect(prompt).toContain(
      "Do not mark an attempt partial solely because it is not a literal patch match",
    );
  });

  it("can prefer an action prompt relevant to the PR oracle over an earlier generic action", () => {
    expect(
      selectPromptWindow(
        [
          "we just added sync ids; incorporate the changes",
          "fix it either way",
          "ok lets start the dev server",
          "lets add a version filter controlled by posthog",
          "no lets add the header",
          "for now enforce the prefix version number",
        ],
        {
          mode: "around-relevant-action",
          maxPrompts: 3,
          actionContextPrompts: 1,
          actionFollowupPrompts: 1,
          relevanceTerms: ["header", "version", "sync"],
        },
      ),
    ).toEqual({
      startIndex: 3,
      prompts: [
        "lets add a version filter controlled by posthog",
        "no lets add the header",
        "for now enforce the prefix version number",
      ],
    });
  });

  it("does not fall back to an irrelevant action prompt when PR relevance terms exist", () => {
    expect(
      selectPromptWindow(
        [
          "the schema migration system treated pre-migration databases as fresh",
          "all of the panopticon tables we care about are panopticon_v2",
          "continue",
          "lets open a pano pr first",
          "why did the pano integration tests pass before we made this change",
          "ok describe the fml changes again",
          "ok merged lets update the v number",
        ],
        {
          mode: "around-relevant-action",
          maxPrompts: 2,
          actionContextPrompts: 1,
          actionFollowupPrompts: 0,
          relevanceTerms: ["migration", "fresh", "database", "migrations"],
        },
      ),
    ).toEqual({
      startIndex: 0,
      prompts: [
        "the schema migration system treated pre-migration databases as fresh",
        "all of the panopticon tables we care about are panopticon_v2",
      ],
    });
  });

  it("does not select question-only prompts before a relevant needs-to action", () => {
    expect(
      selectPromptWindow(
        [
          "check the status",
          "is sync succeeding now",
          "let me know when it's caught up",
          "does the sync reset still clear the watermarks or did we not update that?",
          "ok run it",
          "the reset also needs to clear the confirmed repo table",
          "just stop the server and run it manually on the db",
        ],
        {
          mode: "around-relevant-action",
          maxPrompts: 2,
          actionContextPrompts: 1,
          actionFollowupPrompts: 0,
          relevanceTerms: ["reset", "watermark", "sync"],
        },
      ),
    ).toEqual({
      startIndex: 4,
      prompts: [
        "ok run it",
        "the reset also needs to clear the confirmed repo table",
      ],
    });
  });

  it("does not treat question-only prompts as the action window target", () => {
    expect(
      selectPromptWindow(
        [
          "is fml/panopticon syncing correctly",
          "explain the bug in more detail",
          "when did this bug get introduced",
          "and what is the fix",
          "yes",
          "lets fix it now",
        ],
        {
          mode: "around-action",
          maxPrompts: 3,
          actionContextPrompts: 1,
          actionFollowupPrompts: 1,
        },
      ),
    ).toEqual({
      startIndex: 4,
      prompts: ["yes", "lets fix it now"],
    });
  });

  it("aggregates only completed, instrumented, exact-scope outcome-equivalent pairs", () => {
    const args = { arms: ["none", "panop"] };
    const comparable = {
      session_id: "comparable",
      pr_number: 1,
      arms: {
        none: arm("none", {
          durationMs: 1000,
          totalTokens: 1000,
          outcomeDiagnostics: outcome(1),
        }),
        panop: arm("panop", {
          durationMs: 800,
          totalTokens: 700,
          outcomeDiagnostics: outcome(1),
        }),
      },
      verdicts: { none: "accomplished", panop: "accomplished" },
    };
    const incomplete = {
      session_id: "incomplete",
      pr_number: 1,
      arms: {
        none: arm("none"),
        panop: arm("panop", { turnsCompleted: 2 }),
      },
      verdicts: { none: "accomplished", panop: "accomplished" },
    };
    const missingInstrumentation = {
      session_id: "missing-instrumentation",
      pr_number: 1,
      arms: {
        none: arm("none"),
        panop: arm("panop", {
          hookDiagnostics: hook({
            userPromptSubmitInjectionOpportunities: 1,
          }),
        }),
      },
      verdicts: { none: "accomplished", panop: "accomplished" },
    };
    const wrongOutcome = {
      session_id: "wrong-outcome",
      pr_number: 1,
      arms: {
        none: arm("none", {
          outcomeDiagnostics: outcome(1),
        }),
        panop: arm("panop", {
          outcomeDiagnostics: outcome(1),
        }),
      },
      verdicts: { none: "accomplished", panop: "partial" },
    };
    const wrongScope = {
      session_id: "wrong-scope",
      pr_number: 1,
      arms: {
        none: arm("none", {
          outcomeDiagnostics: outcome(1, ["src/unexpected.ts"]),
        }),
        panop: arm("panop", {
          outcomeDiagnostics: outcome(1),
        }),
      },
      verdicts: { none: "accomplished", panop: "accomplished" },
    };

    const aggregate = computeAggregate(
      [
        comparable,
        incomplete,
        missingInstrumentation,
        wrongOutcome,
        wrongScope,
      ] as never,
      args as never,
    );

    expect(aggregate.completedCount).toBe(4);
    expect(aggregate.instrumentedCount).toBe(3);
    expect(aggregate.prFileCoveredCount).toBe(3);
    expect(aggregate.prExactFileSetCount).toBe(2);
    expect(aggregate.comparableCount).toBe(1);
    expect(aggregate.metricReadiness).toMatchObject({
      reductionReady: false,
      pairedReductionCount: 1,
      recommendedMinimumPairs: 3,
      meetsRecommendedSampleSize: false,
      gates: {
        totalScenarios: 5,
        completePairCount: 4,
        instrumentedPairCount: 3,
        prScopeDiagnosticsPairCount: 3,
        exactScopePairCount: 2,
        judgedPairCount: 2,
        accomplishedPairCount: 1,
      },
      blockerCounts: {
        incomplete_pair: 1,
        missing_exact_pr_scope: 1,
        missing_injection_surface: 1,
        not_accomplished: 1,
      },
    });
    expect(aggregate.scopeMetricReadiness).toMatchObject({
      scopeReady: true,
      pairedScopeCount: 3,
      recommendedMinimumPairs: 3,
      meetsRecommendedSampleSize: true,
      gates: {
        totalScenarios: 5,
        completePairCount: 4,
        instrumentedPairCount: 3,
        prScopeDiagnosticsPairCount: 3,
      },
      blockerCounts: {
        incomplete_pair: 1,
        missing_injection_surface: 1,
      },
    });
    expect(aggregate.scopeMetricReadiness.scenarios).toContainEqual(
      expect.objectContaining({
        session_id: "wrong-scope",
        status: "ready",
        blockers: [],
      }),
    );
    expect(aggregate.metricReadiness.scenarios).toContainEqual(
      expect.objectContaining({
        session_id: "wrong-scope",
        status: "blocked",
        blockers: ["missing_exact_pr_scope"],
        armBlockers: { none: ["unexpected_pr_files"] },
      }),
    );
    expect(aggregate.armScopeMetrics).toMatchObject([
      {
        arm: "none",
        prScopeEligibleCount: 3,
        prFileCoveredCount: 3,
        prFileCoveredRate: 1,
        prExactFileSetCount: 2,
        exactFileSetRate: 2 / 3,
        totalAttemptTokens: 3000,
        meanAttemptTokens: 1000,
        tokensPerExactFileSet: 1500,
        meanExactTokens: 1000,
        medianExactDurationMs: 1000,
        meanUnexpectedFileCount: 1 / 3,
      },
      {
        arm: "panop",
        prScopeEligibleCount: 3,
        prFileCoveredCount: 3,
        prFileCoveredRate: 1,
        prExactFileSetCount: 3,
        exactFileSetRate: 1,
        totalAttemptTokens: 2700,
        meanAttemptTokens: 900,
        tokensPerExactFileSet: 900,
        meanExactTokens: 900,
        medianExactTokens: 1000,
        meanUnexpectedFileCount: 0,
      },
    ]);
    const noneScope = aggregate.armScopeMetrics.find(
      (scope) => scope.arm === "none",
    );
    const panopScope = aggregate.armScopeMetrics.find(
      (scope) => scope.arm === "panop",
    );
    expect(noneScope?.exactFileSetRateWilson95?.lower).toBeCloseTo(0.21);
    expect(noneScope?.exactFileSetRateWilson95?.upper).toBeCloseTo(0.94);
    expect(panopScope?.exactFileSetRateWilson95?.lower).toBeCloseTo(0.44);
    expect(panopScope?.exactFileSetRateWilson95?.upper).toBeCloseTo(1);
    expect(aggregate.scopeDeltas).toMatchObject([
      {
        arm: "panop",
        pairedCount: 3,
        exactFileSetWins: 1,
        exactFileSetTies: 2,
        exactFileSetLosses: 0,
        baselineExactFileSetRate: 2 / 3,
        armExactFileSetRate: 1,
        exactFileSetRateDelta: 1 / 3,
        exactFileSetWinRate: 1 / 3,
        exactFileSetLossRate: 0,
        baselinePrFileCoveredRate: 1,
        armPrFileCoveredRate: 1,
        prFileCoveredRateDelta: 0,
        meanUnexpectedFilesDelta: -1 / 3,
      },
    ]);
    expect(
      aggregate.scopeDeltas[0].exactFileSetWinRateWilson95?.lower,
    ).toBeCloseTo(0.06);
    expect(
      aggregate.scopeDeltas[0].exactFileSetWinRateWilson95?.upper,
    ).toBeCloseTo(0.79);
    expect(aggregate.armDeltas).toHaveLength(1);
    expect(aggregate.armDeltas[0].pairedCount).toBe(1);
    expect(aggregate.armDeltas[0].meanTokenDeltaPct).toBeCloseTo(-30);
    expect(aggregate.armDeltas[0].medianDurationDeltaPct).toBeCloseTo(-20);

    const markdown = buildMarkdownReport({
      generatedAt: "2026-05-20T00:00:00.000Z",
      sources: ["a.json", "b.json"],
      args: parseArgs(["--action-pair", "--execute"]),
      aggregate,
      results: [
        comparable,
        incomplete,
        missingInstrumentation,
        wrongOutcome,
        wrongScope,
      ] as never,
    });
    expect(markdown).toContain("Panopticon Injection Replay A/B Report");
    expect(markdown).toContain(
      "Prompt window: combined/recomputed; see scenario gate rows",
    );
    expect(markdown).toContain("Strict Token/Time Reduction");
    expect(markdown).toContain("Metric Conclusions");
    expect(markdown).toContain(
      "Reliable PR-scope A/B metric: reported with 3/5 paired scope sample(s).",
    );
    expect(markdown).toContain(
      "Reliable strict token/time A/B metric: not reported; only 1/5 strict pair(s) passed exact-scope and outcome gates.",
    );
    expect(markdown).toContain("PR Scope Quality");
    expect(markdown).toContain("Scope Efficiency");
    expect(markdown).toContain("Paired scope metric pairs: 3/5");
    expect(markdown).toContain("Scope metric sample size: ok");
    expect(markdown).toContain("Strict token/time sample size: low");
    expect(markdown).toContain("Not reported as reliable. Only 1 strict pair");
    expect(markdown).toContain(
      "This remains valid even when strict token/time reduction is blocked.",
    );
    expect(markdown).toContain(
      "This is not a strict token/time reduction metric unless the strict gates pass.",
    );
    expect(markdown).toContain(
      "| Arm | Eligible | Covered | Exact | Exact Rate | 95% CI | Unexpected Mean |",
    );
    expect(markdown).toContain(
      "| Arm | n | Covered Rate | Covered Baseline | Covered Δ | Covered W/T/L | Exact Rate |",
    );
    expect(markdown).toContain(
      "| Arm | Attempt Tokens | Mean Exact Tokens | Tokens / Exact | Attempt Time | Mean Exact Time | Time / Exact |",
    );
    expect(markdown).toContain("Scope Status");
    expect(markdown).toContain("Strict Status");
    expect(markdown).toContain(
      "| wrong-scope | 1 | undefined |  |  | ready | none | blocked | missing_exact_pr_scope |",
    );
    expect(markdown).toContain("panop");
    expect(markdown).toContain("95% CI");
  });

  it("reports the actual traced prompt window for single-source recomputes", () => {
    const aggregate = computeAggregate(
      [
        {
          session_id: "wrong-scope",
          pr_number: 1,
          promptCount: 2,
          promptStartTurn: 8,
          promptWindow: {
            mode: "around-relevant-action",
            promptStartTurn: 8,
            promptEndTurn: 9,
            promptCount: 2,
            prompts: [
              { turn: 8, charCount: 7, text: "context" },
              { turn: 9, charCount: 6, text: "action" },
            ],
            preWindowContext: {
              promptStartTurn: null,
              promptEndTurn: null,
              promptCount: 0,
              prompts: [],
            },
          },
          arms: {
            none: arm("none", {
              outcomeDiagnostics: outcome(1, ["src/unexpected.ts"]),
              promptCount: 2,
            }),
            panop: arm("panop", {
              outcomeDiagnostics: outcome(1),
              promptCount: 2,
            }),
          },
          verdicts: { none: "accomplished", panop: "accomplished" },
        },
      ] as never,
      parseArgs(["--execute"]) as never,
    );

    const markdown = buildMarkdownReport({
      generatedAt: "2026-05-20T00:00:00.000Z",
      sources: ["single-source.recomputed.json"],
      args: parseArgs(["--execute"]),
      aggregate,
      results: aggregate.metricReadiness.scenarios.map(() => ({
        session_id: "wrong-scope",
        promptWindow: {
          mode: "around-relevant-action",
          promptStartTurn: 8,
          promptEndTurn: 9,
          promptCount: 2,
          prompts: [
            { turn: 8, charCount: 7, text: "context" },
            { turn: 9, charCount: 6, text: "action" },
          ],
          preWindowContext: {
            promptStartTurn: null,
            promptEndTurn: null,
            promptCount: 0,
            prompts: [],
          },
        },
      })) as never,
    });

    expect(markdown).toContain(
      "Prompt window: around-relevant-action window; 2 replay prompts per scenario; see scenario gate rows",
    );
    expect(markdown).not.toContain("Prompt window: first 3");
  });

  it("formats unavailable scope deltas without appending percentage-point units", () => {
    const aggregate = computeAggregate(
      [
        {
          session_id: "missing-diagnostics",
          pr_number: 1,
          promptCount: 2,
          promptStartTurn: 1,
          arms: {
            none: arm("none", { outcomeDiagnostics: null, promptCount: 2 }),
            panop: arm("panop", { outcomeDiagnostics: null, promptCount: 2 }),
          },
          verdicts: { none: "accomplished", panop: "accomplished" },
        },
      ] as never,
      parseArgs(["--execute"]) as never,
    );

    const markdown = buildMarkdownReport({
      generatedAt: "2026-05-20T00:00:00.000Z",
      sources: ["missing-diagnostics.json"],
      args: parseArgs(["--execute"]),
      aggregate,
      results: [] as never,
    });

    expect(markdown).toContain(
      "| panop vs none | 0 | n/a | n/a | n/a | 0/0/0 | n/a |",
    );
    expect(markdown).not.toContain("n/app");
  });

  it("requires panop arms to have SessionStart and all expected UserPromptSubmit opportunities", () => {
    expect(hasRequiredInjectionSurface(arm("none") as never)).toBe(true);
    expect(hasRequiredInjectionSurface(arm("panop") as never)).toBe(true);
    expect(
      hasRequiredInjectionSurface(
        arm("panop", {
          hookDiagnostics: undefined,
        }) as never,
      ),
    ).toBe(false);
    expect(
      hasRequiredInjectionSurface(
        arm("panop", {
          hookDiagnostics: hook({ sessionStartCount: 0 }),
        }) as never,
      ),
    ).toBe(false);
    expect(
      hasRequiredInjectionSurface(
        arm("panop", {
          hookDiagnostics: hook({
            userPromptSubmitInjectionOpportunities: 1,
          }),
        }) as never,
      ),
    ).toBe(false);
    expect(
      hasRequiredInjectionSurface(
        arm("panop", {
          hookDiagnostics: hook({
            matchedUserPromptSubmitInjectionOpportunities: 1,
            missingUserPromptSubmitReplayPrompts: ["turn 3"],
          }),
        }) as never,
      ),
    ).toBe(false);
    expect(
      hasRequiredInjectionSurface(
        arm("panop", {
          hookDiagnostics: hook({
            matchedUserPromptSubmitInjectionOpportunities: undefined,
          }),
        }) as never,
      ),
    ).toBe(false);
  });

  it("marks bounded windows measurable only when turn 2+ can exercise UserPromptSubmit on an action prompt", () => {
    expect(
      assessScenarioWindow(scenario(["please inspect this"]) as never),
    ).toMatchObject({
      userPromptInjectionOpportunities: 0,
      likelyActionPromptTurn: null,
      measurable: false,
    });
    expect(
      assessScenarioWindow(
        scenario([
          "please inspect this",
          "please fix the failing test",
        ]) as never,
      ),
    ).toMatchObject({
      userPromptInjectionOpportunities: 1,
      likelyActionPromptTurn: 2,
      measurable: true,
    });
    expect(
      assessScenarioWindow(
        scenario(["/clear", "please fix the failing test"]) as never,
      ),
    ).toMatchObject({
      userPromptInjectionOpportunities: 1,
      likelyActionPromptTurn: 2,
      measurable: false,
    });
  });
});
