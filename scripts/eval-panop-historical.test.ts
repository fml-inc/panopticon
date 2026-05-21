import { describe, expect, it } from "vitest";
import {
  aggregateMeasurements,
  buildHistoricalMarkdownReport,
  buildReliablePanopHistoricalContext,
  estimateReadResultTokens,
  extractFixturePrompts,
  extractFixtureRows,
  netDiscoveryTokenSavingsRate,
  parseArgs,
  parseDiffstatFiles,
  pathMatches,
  rankOptimizedCrgCandidatesForPanop,
  selectHookCoverageCandidates,
} from "./eval-panop-historical.js";

function measurement(overrides: Record<string, unknown>) {
  return {
    session_id: "session",
    title: "test session",
    oracleSource: "pre_edit_discovery",
    oracleFiles: 0,
    oracleSessions: 0,
    discoveryReads: 0,
    discoveryReadTokens: 0,
    treatmentFiles: 0,
    treatmentSessions: 0,
    treatmentContextTokens: 0,
    treatmentInjectionEvents: 0,
    treatmentUserPromptEvents: 0,
    fileHits: 0,
    fileCandidateHits: 0,
    sessionHits: 0,
    matchedDiscoveryTokens: 0,
    netDiscoveryTokenDelta: null,
    fileRecall: null,
    filePrecision: null,
    sessionRecall: null,
    ...overrides,
  };
}

function treatment(overrides: Record<string, unknown>) {
  return {
    files: [],
    sessionIds: [],
    contextTokens: 0,
    contextBytes: 0,
    injectionEvents: 0,
    sessionStartTokens: 0,
    sessionStartEvents: 0,
    userPromptTokens: 0,
    userPromptEvents: 0,
    preToolUseTokens: 0,
    preToolUseEvents: 0,
    ...overrides,
  };
}

describe("historical proxy metrics", () => {
  it("parses fixture diffstat file lines without including summary rows", () => {
    expect(
      parseDiffstatFiles(`src/api/routes.ts |  6 +++++-
 src/cli.ts        | 41 +++++++++++------------------------------
 2 files changed, 16 insertions(+), 31 deletions(-)`),
    ).toEqual(["src/api/routes.ts", "src/cli.ts"]);
  });

  it("normalizes rename paths from fixture diffstat file lines", () => {
    expect(
      parseDiffstatFiles(`src/{old-name.ts => new-name.ts} | 8 ++++----
 old/path.ts => src/new/path.ts          | 2 +-
 2 files changed, 5 insertions(+), 5 deletions(-)`),
    ).toEqual(["src/new-name.ts", "src/new/path.ts"]);
  });

  it("matches path suffixes only at path segment boundaries", () => {
    expect(pathMatches("src/barclient.ts", "client.ts")).toBe(false);
    expect(pathMatches("x/schema.ts", "schema.ts")).toBe(true);
    expect(pathMatches("schema.ts", "x/schema.ts")).toBe(true);
    expect(pathMatches("src/foo/client.ts", "client.ts")).toBe(true);
  });

  it("does not assign token weight to empty read results", () => {
    expect(estimateReadResultTokens(null)).toBe(0);
    expect(estimateReadResultTokens(0)).toBe(0);
    expect(estimateReadResultTokens(1)).toBe(10);
    expect(estimateReadResultTokens(80)).toBe(20);
  });

  it("builds reliable Panop context without non-point-in-time PreToolUse context", () => {
    const reliable = buildReliablePanopHistoricalContext({
      sessionstart: treatment({
        files: ["src/session.ts"],
        sessionIds: ["session-a"],
        contextTokens: 10,
        injectionEvents: 1,
        sessionStartTokens: 10,
        sessionStartEvents: 1,
      }),
      userpromptsubmit: treatment({
        files: ["src/prompt.ts"],
        sessionIds: ["session-b"],
        contextTokens: 20,
        injectionEvents: 1,
        userPromptTokens: 20,
        userPromptEvents: 1,
      }),
      pretooluse: treatment({
        files: ["src/future-file-overview.ts"],
        sessionIds: ["future-session"],
        contextTokens: 999,
        injectionEvents: 1,
        preToolUseTokens: 999,
        preToolUseEvents: 1,
      }),
    } as never);

    expect(reliable.files).toEqual(["src/prompt.ts", "src/session.ts"]);
    expect(reliable.sessionIds).toEqual(["session-a", "session-b"]);
    expect(reliable.contextTokens).toBe(30);
    expect(reliable.preToolUseEvents).toBe(0);
  });

  it("defaults headline injection features to the replay-safe set", () => {
    expect(parseArgs([]).injectionFeatures).toEqual([
      "sessionstart",
      "userpromptsubmit",
    ]);
    expect(
      parseArgs(["--injection-features", "all"]).injectionFeatures,
    ).toEqual(["sessionstart", "userpromptsubmit", "pretooluse"]);
    expect(() => parseArgs(["--fixture-file"])).toThrow(
      "--fixture-file expects a value",
    );
  });

  it("accepts raw scenario arrays and wrapped result files as fixture sources", () => {
    expect(extractFixtureRows([{ session_id: "raw" }])).toEqual([
      { session_id: "raw" },
    ]);
    expect(
      extractFixtureRows({
        results: [{ session_id: "result" }],
      }),
    ).toEqual([{ session_id: "result" }]);
    expect(
      extractFixtureRows({
        measurements: [{ session_id: "measurement" }],
      }),
    ).toEqual([{ session_id: "measurement" }]);
  });

  it("uses replay prompt windows when wrapped result fixtures include them", () => {
    expect(
      extractFixturePrompts({
        prompts: ["full first", "full second"],
        promptWindow: {
          prompts: [{ text: "selected setup" }, { text: "selected action" }],
        },
      }),
    ).toEqual(["selected setup", "selected action"]);
  });

  it("selects the relevant action pair from raw PR replay fixtures", () => {
    expect(
      extractFixturePrompts({
        pr_title:
          "Add panopticon update, install --force reinstall, fix --version",
        expected_diffstat: "src/cli.ts | 57 +++++++++++++++++\n 1 file changed",
        prompts: [
          "earlier unrelated setup",
          "how can we fix fml --version?",
          "lets add fml update and fml install --force",
          "later followup",
        ],
      }),
    ).toEqual([
      "how can we fix fml --version?",
      "lets add fml update and fml install --force",
    ]);
  });

  it("selects deterministic real-session candidates to cover requested hook features", () => {
    const selection = selectHookCoverageCandidates(
      [
        { item: "recent-ss", features: ["sessionstart"] },
        { item: "recent-none", features: [] },
        { item: "older-ups", features: ["userpromptsubmit"] },
        { item: "older-ptu", features: ["pretooluse"] },
        { item: "fill", features: ["sessionstart", "pretooluse"] },
      ],
      ["sessionstart", "userpromptsubmit", "pretooluse"],
      4,
    );

    expect(selection.selected).toEqual([
      "recent-ss",
      "older-ups",
      "older-ptu",
      "recent-none",
    ]);
    expect(selection.covered).toEqual([
      "sessionstart",
      "userpromptsubmit",
      "pretooluse",
    ]);
    expect(selection.missing).toEqual([]);
  });

  it("reports missing hook feature coverage when candidates do not exercise it", () => {
    const selection = selectHookCoverageCandidates(
      [{ item: "recent-ss", features: ["sessionstart"] }],
      ["sessionstart", "userpromptsubmit"],
      10,
    );

    expect(selection.selected).toEqual(["recent-ss"]);
    expect(selection.covered).toEqual(["sessionstart"]);
    expect(selection.missing).toEqual(["userpromptsubmit"]);
  });

  it("uses Panop files to suppress duplicate CRG leads and keep nearby graph leads", () => {
    const ranked = rankOptimizedCrgCandidatesForPanop(
      [
        { file: "src/hooks/ingest.ts", score: 500, sources: ["seed"] },
        { file: "src/hooks/handler.ts", score: 180, sources: ["related"] },
        { file: "docs/notes.md", score: 180, sources: ["related"] },
        { file: "src/hooks/ingest.test.ts", score: 150, sources: ["related"] },
      ],
      ["src/hooks/ingest.ts"],
    );

    expect(ranked.map((candidate) => candidate.file)).toEqual([
      "src/hooks/ingest.test.ts",
      "src/hooks/handler.ts",
    ]);
    expect(ranked[0].sources).toContain("panop_near");
    expect(ranked.some((candidate) => candidate.file === "docs/notes.md")).toBe(
      false,
    );
  });

  it("keeps read-token metrics unavailable for expected-diffstat oracles", () => {
    const aggregate = aggregateMeasurements([
      measurement({
        oracleSource: "expected_diffstat",
        oracleFiles: 2,
        treatmentFiles: 4,
        treatmentContextTokens: 100,
        treatmentInjectionEvents: 2,
        treatmentUserPromptEvents: 1,
        fileHits: 1,
        fileCandidateHits: 1,
        fileRecall: 0.5,
        filePrecision: 0.25,
      }),
    ] as never);

    expect(aggregate.oracleSourceCounts).toEqual({
      pre_edit_discovery: 0,
      expected_diffstat: 1,
    });
    expect(aggregate.weightedFileRecall).toBe(0.5);
    expect(aggregate.weightedFilePrecision).toBe(0.25);
    expect(aggregate.discoveryReadTokens).toBe(0);
    expect(aggregate.matchedDiscoveryTokenRate).toBeNull();
    expect(aggregate.contextRoi).toBeNull();
    expect(aggregate.meanNetDiscoveryTokenDelta).toBeNull();
    expect(aggregate.ci.matchedDiscoveryTokenRate).toEqual({
      low: null,
      high: null,
    });
  });

  it("writes markdown that separates expected-diffstat recall from discovery token proxy", () => {
    const rows = [
      measurement({
        feature: "selected",
        arm: "none",
        oracleSource: "expected_diffstat",
        oracleFiles: 1,
      }),
      measurement({
        feature: "selected",
        arm: "panop",
        oracleSource: "expected_diffstat",
        oracleFiles: 1,
        treatmentFiles: 1,
        treatmentContextTokens: 100,
        treatmentSessionStartEvents: 1,
        fileHits: 1,
        fileCandidateHits: 1,
      }),
    ] as never;
    const none = aggregateMeasurements([rows[0]] as never);
    const panop = aggregateMeasurements([rows[1]] as never);
    const empty = aggregateMeasurements([] as never);
    const aggregateByArm = {
      none,
      panop,
      "panop+optimized-crg": empty,
      "original-crg": empty,
    };
    const report = buildHistoricalMarkdownReport({
      generatedAt: "2026-05-20T00:00:00.000Z",
      args: {
        repository: "fml-inc/panopticon",
        targets: [],
        fixtureFile: "fixture.json",
        arms: ["none", "panop", "panop+optimized-crg"],
        injectionFeatures: ["sessionstart", "userpromptsubmit"],
        sampleMode: "recent",
      },
      aggregateByFeatureArm: {
        selected: aggregateByArm,
      },
      measurements: rows,
    } as never);

    expect(report).toContain("## Headline File Recall");
    expect(report).toContain("Not reported for this sample");
    expect(report).toContain("| panop | 100% |");
  });

  it("computes read-token savings only for pre-edit discovery oracles", () => {
    const aggregate = aggregateMeasurements([
      measurement({
        oracleSource: "pre_edit_discovery",
        oracleFiles: 2,
        oracleSessions: 1,
        discoveryReads: 3,
        discoveryReadTokens: 100,
        treatmentFiles: 4,
        treatmentSessions: 2,
        treatmentContextTokens: 20,
        fileHits: 1,
        fileCandidateHits: 1,
        sessionHits: 1,
        matchedDiscoveryTokens: 50,
        netDiscoveryTokenDelta: 30,
        fileRecall: 0.5,
        filePrecision: 0.25,
        sessionRecall: 1,
      }),
    ] as never);

    expect(aggregate.discoveryReadTokens).toBe(100);
    expect(aggregate.matchedDiscoveryTokens).toBe(50);
    expect(aggregate.netDiscoveryTokenDelta).toBe(30);
    expect(aggregate.matchedDiscoveryTokenRate).toBe(0.5);
    expect(aggregate.contextRoi).toBe(2.5);
    expect(aggregate.meanNetDiscoveryTokenDelta).toBe(30);
  });

  it("charges net discovery savings only for discovery-oracle context cost", () => {
    const aggregate = aggregateMeasurements([
      measurement({
        oracleSource: "pre_edit_discovery",
        discoveryReadTokens: 100,
        treatmentContextTokens: 20,
        matchedDiscoveryTokens: 50,
        netDiscoveryTokenDelta: 30,
      }),
      measurement({
        oracleSource: "expected_diffstat",
        oracleFiles: 1,
        treatmentContextTokens: 1000,
        fileHits: 1,
        fileCandidateHits: 1,
      }),
    ] as never);

    expect(aggregate.treatmentContextTokens).toBe(1020);
    expect(aggregate.discoveryTreatmentContextTokens).toBe(20);
    expect(aggregate.contextRoi).toBe(2.5);
    expect(netDiscoveryTokenSavingsRate(aggregate)).toBe(0.3);
  });
});
