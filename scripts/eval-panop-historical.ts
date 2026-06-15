#!/usr/bin/env node

// Deterministic historical-session eval for Panopticon context injection.
//
// This is deliberately not an agent-output replay. It measures whether the
// Panopticon treatment would have surfaced context the real historical agent
// had to discover before its first edit. The control arm is no injected local
// history: zero context tokens, zero surfaced files/sessions.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCodeReviewGraphProvider } from "../src/code_intelligence/index.js";
import { Database } from "../src/db/driver.js";
import { closeDb, getDb } from "../src/db/schema.js";
import {
  buildPreToolUseReadFileContext,
  buildSessionStartRecentHistoryContext,
  buildUserPromptSubmitLocalContext,
} from "../src/hooks/session-context.js";
import type { SessionSummaryPreview } from "../src/session_summaries/preview.js";
import {
  listRecentSessionSummaryPreviewsForCwd,
  listRelevantSessionSummaryPreviewsForPrompt,
} from "../src/session_summaries/query.js";

const DEFAULT_REPOSITORY = "fml-inc/panopticon";
const DEFAULT_REPO_ROOT = resolveDefaultRepoRoot();
const DEFAULT_LIMIT = 200;
const CHARS_PER_TOKEN = 4;
const RECENT_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const USER_PROMPT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const ORIGINAL_CRG_SEARCH_LIMIT = 5;
const OPTIMIZED_CRG_SEED_LIMIT = 5;
const OPTIMIZED_CRG_CANDIDATE_LIMIT_EMPTY_PANOP = 10;
const OPTIMIZED_CRG_CANDIDATE_LIMIT_WITH_PANOP = 8;
const OPTIMIZED_CRG_CANDIDATE_LIMIT_STRONG_PANOP = 6;
const OPTIMIZED_CRG_MIN_CANDIDATE_SCORE = 120;
const FIXTURE_REPLAY_WINDOW = {
  maxPrompts: 2,
  actionContextPrompts: 1,
};
const FIXTURE_ACTION_PROMPT_PATTERNS = [
  /\b(add|capture|change|clear|cover|fix|handle|implement|incorporate|preserve|refactor|remove|rename|replace|resolve|test|track|update|write)\b/i,
  /\blets?\s+(add|change|clear|cover|fix|handle|implement|incorporate|make|preserve|refactor|remove|rename|replace|resolve|test|track|update|write)\b/i,
  /\bneeds?\s+to\s+(add|change|clear|cover|fix|handle|implement|incorporate|preserve|refactor|remove|rename|replace|resolve|track|update|write)\b/i,
];

const ARM_NAMES = [
  "none",
  "panop",
  "panop+optimized-crg",
  "original-crg",
] as const;
type ArmName = (typeof ARM_NAMES)[number];
const DEFAULT_ARM_NAMES = [
  "none",
  "panop",
  "panop+optimized-crg",
] as const satisfies readonly ArmName[];
const PANOP_FEATURE_NAMES = [
  "sessionstart",
  "userpromptsubmit",
  "pretooluse",
] as const;
type PanopFeatureName = (typeof PANOP_FEATURE_NAMES)[number];
const RELIABLE_INJECTION_FEATURES = [
  "sessionstart",
  "userpromptsubmit",
] as const satisfies readonly PanopFeatureName[];
const DEFAULT_INJECTION_FEATURES =
  PANOP_FEATURE_NAMES satisfies readonly PanopFeatureName[];
const SELECTED_FEATURE_NAME = "selected";
const DEFAULT_HOOK_COVERAGE_CANDIDATE_LIMIT = 1000;
const MIN_TOKENS_PER_NON_EMPTY_READ = 10;

const SAMPLE_MODES = ["recent", "hook-coverage"] as const;
type SampleMode = (typeof SAMPLE_MODES)[number];

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const READ_SHELL_VERBS = new Set([
  "awk",
  "bat",
  "cat",
  "column",
  "diff",
  "echo",
  "fd",
  "file",
  "find",
  "grep",
  "head",
  "jq",
  "less",
  "ls",
  "more",
  "nl",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sed",
  "stat",
  "tail",
  "tree",
  "wc",
]);

function resolveDefaultRepoRoot(): string {
  let current = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(process.cwd());
    current = parent;
  }
}
const READ_GIT_SUBCMDS = new Set([
  "blame",
  "branch",
  "cat-file",
  "describe",
  "diff",
  "log",
  "ls-files",
  "ls-tree",
  "remote",
  "rev-parse",
  "show",
  "status",
]);
const OPTIMIZED_CRG_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "can",
  "code",
  "for",
  "from",
  "have",
  "into",
  "let",
  "lets",
  "look",
  "make",
  "new",
  "now",
  "only",
  "our",
  "out",
  "that",
  "the",
  "then",
  "this",
  "use",
  "using",
  "want",
  "what",
  "with",
]);
interface Args {
  repository: string | null;
  repoRoot: string;
  targets: string[];
  limit: number;
  minOracleFiles: number;
  arms: ArmName[];
  injectionFeatures: PanopFeatureName[];
  sampleMode: SampleMode;
  hookCoverageCandidateLimit: number;
  requireHookCoverage: boolean;
  outputJson: string | null;
  reportMarkdown: string | null;
  sinceDays: number | null;
  fixtureFile: string | null;
  sessionId: string | null;
  includeAutomated: boolean;
}

interface Scenario {
  session_id: string;
  target: string | null;
  pr_number?: number;
  title: string | null;
  started_at_ms: number;
  first_prompt: string;
  fixturePrompts?: string[];
  expected_diffstat?: string;
  cwd: string;
  repoRoot: string;
  repository: string | null;
  first_edit_tool_call_id: number | null;
  first_edit_ts_ms: number | null;
}

interface ToolCallRow {
  id: number;
  tool_name: string | null;
  category: string | null;
  input_json: string | null;
  result_content_length: number | null;
}

interface HookDiscoveryRow {
  id: number;
  tool_name: string | null;
  file_path: string | null;
  command: string | null;
  result_len: number | null;
}

interface PromptRow {
  user_prompt: string;
  timestamp_ms: number | null;
}

interface PreToolUseReadRow {
  file_path: string;
  timestamp_ms: number;
  cwd: string | null;
  repository: string | null;
}

interface HookCoverageCandidate<T> {
  item: T;
  features: readonly PanopFeatureName[];
}

interface HookCoverageSelection<T> {
  selected: T[];
  covered: PanopFeatureName[];
  missing: PanopFeatureName[];
}

interface Oracle {
  source: "pre_edit_discovery" | "expected_diffstat";
  files: string[];
  fileWeights: Record<string, number>;
  sessionIds: string[];
  discoveryReads: number;
  discoveryReadTokens: number;
}

interface TreatmentContext {
  files: string[];
  sessionIds: string[];
  contextTokens: number;
  contextBytes: number;
  injectionEvents: number;
  sessionStartTokens: number;
  sessionStartEvents: number;
  userPromptTokens: number;
  userPromptEvents: number;
  preToolUseTokens: number;
  preToolUseEvents: number;
  crgCandidateFiles: number;
  crgSeedCandidateFiles: number;
  crgRelatedCandidateFiles: number;
  crgPanopNearCandidateFiles: number;
}

interface CrgCandidate {
  file: string;
  score: number;
  sources: string[];
}

interface CrgSeed {
  file: string;
  score: number;
}

interface RawCrgNode {
  id: number;
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  language: string | null;
  params: string | null;
  return_type: string | null;
  signature?: string | null;
  score?: number;
}

interface RawCrgCount {
  c: number;
}

interface RawCrgName {
  name: string;
}

interface OriginalCrgSearchResult {
  name: string;
  kind: string;
  file_path: string;
  score: number;
}

const optimizedCrgNodeCache = new Map<string, RawCrgNode[] | null>();
const inferredRepoRootCache = new Map<string, string>();

interface ScenarioMeasurement {
  feature: string;
  arm: ArmName;
  session_id: string;
  pr_number?: number;
  title: string | null;
  oracleSource: Oracle["source"];
  oracleFiles: number;
  oracleSessions: number;
  discoveryReads: number;
  discoveryReadTokens: number;
  treatmentFiles: number;
  treatmentSessions: number;
  treatmentContextTokens: number;
  treatmentInjectionEvents: number;
  treatmentSessionStartEvents: number;
  treatmentUserPromptEvents: number;
  treatmentPreToolUseEvents: number;
  treatmentCrgCandidateFiles: number;
  treatmentCrgSeedCandidateFiles: number;
  treatmentCrgRelatedCandidateFiles: number;
  treatmentCrgPanopNearCandidateFiles: number;
  fileHits: number;
  fileCandidateHits: number;
  sessionHits: number;
  matchedDiscoveryTokens: number;
  netDiscoveryTokenDelta: number | null;
  fileRecall: number | null;
  filePrecision: number | null;
  sessionRecall: number | null;
}

type AggregateByArm = Record<ArmName, Aggregate>;
type AggregateByFeatureArm = Record<string, AggregateByArm>;

interface Aggregate {
  scenarioCount: number;
  oracleSourceCounts: Record<Oracle["source"], number>;
  oracleFiles: number;
  oracleSessions: number;
  discoveryReads: number;
  discoveryReadTokens: number;
  treatmentContextTokens: number;
  discoveryTreatmentContextTokens: number;
  treatmentInjectionEvents: number;
  treatmentSessionStartEvents: number;
  treatmentUserPromptEvents: number;
  treatmentPreToolUseEvents: number;
  treatmentCrgCandidateFiles: number;
  treatmentCrgSeedCandidateFiles: number;
  treatmentCrgRelatedCandidateFiles: number;
  treatmentCrgPanopNearCandidateFiles: number;
  treatmentFiles: number;
  treatmentSessions: number;
  fileHits: number;
  fileCandidateHits: number;
  sessionHits: number;
  matchedDiscoveryTokens: number;
  netDiscoveryTokenDelta: number;
  weightedFileRecall: number;
  weightedFilePrecision: number;
  weightedSessionRecall: number;
  matchedDiscoveryTokenRate: number | null;
  contextRoi: number | null;
  fileHitsPer1kContextTokens: number;
  macroFileRecall: number | null;
  macroSessionRecall: number | null;
  meanNetDiscoveryTokenDelta: number | null;
  ci: {
    weightedFileRecall: ConfidenceInterval;
    matchedDiscoveryTokenRate: ConfidenceInterval;
    meanNetDiscoveryTokenDelta: ConfidenceInterval;
  };
}

interface ConfidenceInterval {
  low: number | null;
  high: number | null;
}

if (isDirectRun()) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(entry).href : false;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = sampleScenarios(args);
  const measurements = scenarios
    .flatMap((scenario) => measureScenario(scenario, args))
    .filter((m) => m.oracleFiles >= args.minOracleFiles);
  const aggregateByFeatureArm = aggregateMeasurementsByFeatureArm(measurements);
  const aggregateByArm =
    aggregateByFeatureArm[SELECTED_FEATURE_NAME] ??
    aggregateMeasurementsByArm([]);
  const generatedAt = new Date().toISOString();

  console.log("Historical context eval: selected injection feature set");
  console.log(
    "Oracle = pre-edit discovery context or fixture expected diffstat.",
  );
  console.log(`Repository = ${args.repository ?? "all"}.`);
  if (args.targets.length > 0) {
    console.log(`Targets = ${args.targets.join(", ")}.`);
  }
  console.log(`Arms = ${args.arms.join(", ")}.`);
  console.log(
    "panop+optimized-crg = selected Panop context plus optimized CRG file candidates.",
  );
  console.log(
    `Injection features = ${formatInjectionFeatures(args.injectionFeatures)}.`,
  );
  console.log(`Sample mode = ${args.sampleMode}.`);
  if (args.injectionFeatures.includes("pretooluse")) {
    console.log(
      "PreToolUse(Read) remains diagnostic unless its fileOverview source is point-in-time for the evaluated scenario.",
    );
  }
  console.log("");
  printComparison(aggregateByArm, args.arms);
  console.log("");
  printHookCoverage(aggregateByArm, args);
  printCrgCandidateSummary(aggregateByArm, args);
  assertRequiredHookCoverage(aggregateByArm, args);
  console.log("");
  console.log("Top per-session measurements");
  const topArmWidth = Math.max(9, ...args.arms.map((arm) => arm.length));
  for (const m of [...measurements]
    .filter(
      (measurement) =>
        measurement.feature === SELECTED_FEATURE_NAME &&
        measurement.arm !== "none",
    )
    .sort(
      (a, b) =>
        b.matchedDiscoveryTokens - a.matchedDiscoveryTokens ||
        b.fileHits - a.fileHits ||
        b.oracleFiles - a.oracleFiles,
    )
    .slice(0, 12)) {
    const tokenText =
      m.oracleSource === "pre_edit_discovery"
        ? `matched_read=${Math.round(m.matchedDiscoveryTokens)}tok ` +
          `net=${Math.round(m.netDiscoveryTokenDelta ?? 0)}tok `
        : `oracle=${m.oracleSource} `;
    console.log(
      `  ${m.arm.padEnd(topArmWidth)} ${m.session_id.slice(0, 8)} ` +
        `files=${m.fileHits}/${m.oracleFiles} ` +
        `sessions=${m.sessionHits}/${m.oracleSessions} ` +
        `ctx=${m.treatmentContextTokens}tok ` +
        tokenText +
        `${compact(m.title ?? "", 80)}`,
    );
  }

  if (args.outputJson) {
    const payload = {
      generated_at: generatedAt,
      args,
      aggregateByArm,
      aggregateByFeatureArm,
      hookCoverage: summarizeHookCoverage(aggregateByArm, args),
      measurements,
    };
    fs.mkdirSync(path.dirname(args.outputJson), { recursive: true });
    fs.writeFileSync(args.outputJson, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nWrote result JSON: ${args.outputJson}`);
  }
  if (args.reportMarkdown) {
    fs.mkdirSync(path.dirname(args.reportMarkdown), { recursive: true });
    fs.writeFileSync(
      args.reportMarkdown,
      buildHistoricalMarkdownReport({
        generatedAt,
        args,
        aggregateByFeatureArm,
        measurements,
      }),
    );
    console.log(`Wrote markdown report: ${args.reportMarkdown}`);
  }
}

function sampleScenarios(args: Args): Scenario[] {
  const db = getDb();
  const sinceMs =
    args.sinceDays == null
      ? null
      : Date.now() - args.sinceDays * 24 * 60 * 60 * 1000;
  const requestedSessionIds = loadRequestedSessionIds(args);
  if (requestedSessionIds && requestedSessionIds.length === 0) return [];
  const repositoryCte = args.repository
    ? `SELECT session_id, MIN(repository) AS repository
       FROM session_repositories
       WHERE repository = ?
       GROUP BY session_id`
    : `SELECT session_id, MIN(repository) AS repository
       FROM session_repositories
       GROUP BY session_id`;
  const repositoryJoin = args.repository
    ? "JOIN repo_sessions rs ON rs.session_id = s.session_id"
    : "LEFT JOIN repo_sessions rs ON rs.session_id = s.session_id";
  const targetFilter =
    args.targets.length > 0
      ? `AND s.target IN (${args.targets.map(() => "?").join(", ")})`
      : "";
  const sessionFilter = requestedSessionIds
    ? `AND s.session_id IN (${requestedSessionIds.map(() => "?").join(", ")})`
    : "";
  const automatedFilter = args.includeAutomated
    ? ""
    : "AND COALESCE(s.is_automated, 0) != 1";
  const candidateLimit =
    args.sampleMode === "hook-coverage"
      ? Math.max(args.limit, args.hookCoverageCandidateLimit)
      : args.limit * 4;
  const params: unknown[] = [];
  if (args.repository) params.push(args.repository);
  params.push(args.repoRoot);
  params.push(...args.targets);
  params.push(sinceMs, sinceMs);
  if (requestedSessionIds) params.push(...requestedSessionIds);
  params.push(candidateLimit);
  const rows = db
    .prepare(
      `WITH repo_sessions AS (
         ${repositoryCte}
       )
       SELECT s.session_id,
              s.target,
              s.started_at_ms,
              s.first_prompt,
              COALESCE(ss.title, s.first_prompt) AS title,
              COALESCE(
                (SELECT sc.cwd
                 FROM session_cwds sc
                 WHERE sc.session_id = s.session_id
                 ORDER BY sc.first_seen_ms ASC
                 LIMIT 1),
                ?
              ) AS cwd,
              rs.repository,
              (SELECT MIN(tc.id)
               FROM tool_calls tc
               WHERE tc.session_id = s.session_id
                 AND (tc.category IN ('Edit', 'Write')
                      OR tc.tool_name IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'))) AS first_edit_tool_call_id,
              (SELECT MIN(h.timestamp_ms)
               FROM hook_events h
               WHERE h.session_id = s.session_id
                 AND h.event_type IN ('PreToolUse', 'PostToolUse', 'PermissionRequest')
                 AND h.tool_name IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch')) AS first_edit_ts_ms
       FROM sessions s
       ${repositoryJoin}
       LEFT JOIN session_summaries ss ON ss.session_id = s.session_id
       WHERE 1 = 1
         ${automatedFilter}
         ${targetFilter}
         AND s.started_at_ms IS NOT NULL
         AND (? IS NULL OR s.started_at_ms >= ?)
         ${sessionFilter}
         AND EXISTS (
           SELECT 1 FROM tool_calls tc
           WHERE tc.session_id = s.session_id
             AND (tc.category IN ('Edit', 'Write')
                  OR tc.tool_name IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'))
           UNION ALL
           SELECT 1 FROM hook_events h
           WHERE h.session_id = s.session_id
             AND h.event_type IN ('PreToolUse', 'PostToolUse', 'PermissionRequest')
             AND h.tool_name IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch')
         )
       ORDER BY s.started_at_ms DESC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    session_id: string;
    target: string | null;
    started_at_ms: number;
    first_prompt: string | null;
    title: string | null;
    cwd: string | null;
    repository: string | null;
    first_edit_tool_call_id: number | null;
    first_edit_ts_ms: number | null;
  }>;

  const scenarioRows = rows
    .map((row) => {
      const cwd = row.cwd ?? args.repoRoot;
      return {
        session_id: row.session_id,
        target: row.target,
        pr_number: undefined,
        title: compact(row.title ?? row.first_prompt ?? "", 120),
        started_at_ms: row.started_at_ms,
        first_prompt: row.first_prompt ?? row.title ?? "",
        cwd,
        repoRoot: inferScenarioRepoRoot(cwd, args.repoRoot),
        repository: row.repository,
        first_edit_tool_call_id: row.first_edit_tool_call_id,
        first_edit_ts_ms: row.first_edit_ts_ms,
      };
    })
    .filter((row) => row.first_prompt.length > 0);
  if (args.fixtureFile) {
    const metadataBySession = new Map(
      scenarioRows.map((row) => [row.session_id, row]),
    );
    const fixtures = loadFixtureScenarios(args)
      .filter(
        (fixture) =>
          args.sessionId == null || fixture.session_id === args.sessionId,
      )
      .map((fixture) =>
        mergeFixtureScenarioWithDbMetadata(
          fixture,
          metadataBySession.get(fixture.session_id) ?? null,
        ),
      );
    return fixtures.slice(0, args.limit);
  }
  if (requestedSessionIds) {
    const order = new Map(
      requestedSessionIds.map((sessionId, index) => [sessionId, index]),
    );
    scenarioRows.sort(
      (a, b) =>
        (order.get(a.session_id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.session_id) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  if (!requestedSessionIds && args.sampleMode === "hook-coverage") {
    return selectHookCoverageScenarios(scenarioRows, args);
  }
  return scenarioRows.slice(0, args.limit);
}

function selectHookCoverageScenarios(
  scenarios: Scenario[],
  args: Args,
): Scenario[] {
  const candidates: Array<HookCoverageCandidate<Scenario>> = [];
  for (const scenario of scenarios) {
    const oracle = buildOracle(scenario);
    if (oracle.files.length < args.minOracleFiles) continue;
    const features = instrumentedPanopFeaturesForScenario(scenario, args);
    candidates.push({ item: scenario, features });
  }

  const selection = selectHookCoverageCandidates(
    candidates,
    args.injectionFeatures,
    args.limit,
  );
  if (selection.missing.length > 0) {
    const message =
      `Hook coverage sample could not find real session coverage for: ` +
      selection.missing.join(", ");
    if (args.requireHookCoverage) throw new Error(message);
    console.warn(message);
  }
  return selection.selected;
}

function instrumentedPanopFeaturesForScenario(
  scenario: Scenario,
  args: Args,
): PanopFeatureName[] {
  const contexts = buildPanopFeatureContexts(scenario, args.injectionFeatures);
  return args.injectionFeatures.filter(
    (feature) => contexts[feature].injectionEvents > 0,
  );
}

export function selectHookCoverageCandidates<T>(
  candidates: Array<HookCoverageCandidate<T>>,
  requiredFeatures: readonly PanopFeatureName[],
  limit: number,
): HookCoverageSelection<T> {
  const selected: T[] = [];
  const selectedIndexes = new Set<number>();
  const covered = new Set<PanopFeatureName>();

  const addCandidate = (index: number) => {
    if (selectedIndexes.has(index) || selected.length >= limit) return;
    selectedIndexes.add(index);
    selected.push(candidates[index].item);
    for (const feature of candidates[index].features) covered.add(feature);
  };

  for (const feature of requiredFeatures) {
    if (covered.has(feature)) continue;
    const index = candidates.findIndex(
      (candidate, candidateIndex) =>
        !selectedIndexes.has(candidateIndex) &&
        candidate.features.includes(feature),
    );
    if (index >= 0) addCandidate(index);
  }

  for (let i = 0; i < candidates.length && selected.length < limit; i++) {
    addCandidate(i);
  }

  return {
    selected,
    covered: requiredFeatures.filter((feature) => covered.has(feature)),
    missing: requiredFeatures.filter((feature) => !covered.has(feature)),
  };
}

function mergeFixtureScenarioWithDbMetadata(
  fixture: Scenario,
  metadata: Scenario | null,
): Scenario {
  if (!metadata) return fixture;
  return {
    ...metadata,
    ...fixture,
    started_at_ms: metadata.started_at_ms,
    cwd: metadata.cwd,
    repoRoot: metadata.repoRoot,
    repository: metadata.repository,
    target: metadata.target,
    first_edit_tool_call_id: metadata.first_edit_tool_call_id,
    first_edit_ts_ms: metadata.first_edit_ts_ms,
    title: fixture.title ?? metadata.title,
    first_prompt: fixture.first_prompt || metadata.first_prompt,
  };
}

function loadFixtureScenarios(args: Args): Scenario[] {
  if (!args.fixtureFile) return [];
  return readFixtureRows(args.fixtureFile)
    .map((row): Scenario | null => {
      const sessionId =
        typeof row.session_id === "string" && row.session_id.length > 0
          ? row.session_id
          : null;
      if (!sessionId) return null;
      const prompts = extractFixturePrompts(row);
      const firstPrompt =
        typeof row.first_prompt === "string" && row.first_prompt.length > 0
          ? row.first_prompt
          : (prompts[0] ?? "");
      if (!firstPrompt) return null;
      return {
        session_id: sessionId,
        target:
          typeof row.target === "string" && row.target.length > 0
            ? row.target
            : null,
        pr_number:
          typeof row.pr_number === "number" ? row.pr_number : undefined,
        title: compact(firstPrompt, 120),
        started_at_ms:
          typeof row.started_at_ms === "number"
            ? row.started_at_ms
            : Date.now(),
        first_prompt: firstPrompt,
        fixturePrompts: prompts.length > 0 ? prompts : [firstPrompt],
        expected_diffstat:
          typeof row.expected_diffstat === "string"
            ? row.expected_diffstat
            : undefined,
        cwd: args.repoRoot,
        repoRoot: args.repoRoot,
        repository: args.repository,
        first_edit_tool_call_id: null,
        first_edit_ts_ms: null,
      };
    })
    .filter((scenario): scenario is Scenario => scenario !== null);
}

function loadRequestedSessionIds(args: Args): string[] | null {
  const ids = args.fixtureFile
    ? readFixtureRows(args.fixtureFile)
        .map((row) => row.session_id)
        .filter(
          (sessionId): sessionId is string =>
            typeof sessionId === "string" && sessionId.length > 0,
        )
    : null;
  if (args.sessionId) {
    return (ids ?? [args.sessionId]).filter(
      (sessionId) => sessionId === args.sessionId,
    );
  }
  return ids ? unique(ids) : null;
}

function readFixtureRows(filePath: string): Array<Record<string, unknown>> {
  return extractFixtureRows(
    JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown,
  );
}

export function extractFixtureRows(
  raw: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (!isRecord(raw)) return [];
  for (const key of ["scenarios", "results", "measurements"]) {
    const rows = raw[key];
    if (Array.isArray(rows)) return rows.filter(isRecord);
  }
  return [];
}

export function extractFixturePrompts(row: Record<string, unknown>): string[] {
  const promptWindow = row.promptWindow;
  if (isRecord(promptWindow) && Array.isArray(promptWindow.prompts)) {
    return promptWindow.prompts
      .map((prompt) =>
        isRecord(prompt) && typeof prompt.text === "string"
          ? prompt.text
          : null,
      )
      .filter(
        (prompt): prompt is string =>
          typeof prompt === "string" && prompt.trim().length > 0,
      );
  }
  const prompts = Array.isArray(row.prompts)
    ? row.prompts.filter(
        (prompt): prompt is string =>
          typeof prompt === "string" && prompt.trim().length > 0,
      )
    : [];
  if (prompts.length === 0) return [];
  if (
    typeof row.expected_diffstat !== "string" &&
    typeof row.pr_title !== "string"
  ) {
    return prompts;
  }
  return selectFixtureReplayPrompts(prompts, buildFixtureRelevanceTerms(row));
}

function buildFixtureRelevanceTerms(row: Record<string, unknown>): string[] {
  const diffFiles =
    typeof row.expected_diffstat === "string"
      ? parseDiffstatFiles(row.expected_diffstat).join(" ")
      : "";
  const title = typeof row.pr_title === "string" ? row.pr_title : "";
  return unique([
    ...tokenizeFixtureRelevanceText(title),
    ...tokenizeFixtureRelevanceText(diffFiles),
  ]);
}

function tokenizeFixtureRelevanceText(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
    .flatMap((term) => term.split(/[-_/.]/))
    .map((term) => term.replace(/^-+|-+$/g, ""))
    .filter((term) => term.length >= 3 && !OPTIMIZED_CRG_STOPWORDS.has(term));
}

function selectFixtureReplayPrompts(
  prompts: string[],
  relevanceTerms: string[],
): string[] {
  const terms = unique(relevanceTerms).filter((term) => term.length > 0);
  let best: { index: number; score: number } | null = null;
  for (let i = 1; i < prompts.length; i++) {
    if (!isLikelyFixtureActionPrompt(prompts[i])) continue;
    const score = scoreFixturePromptWindowRelevance(prompts, i, terms);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { index: i, score };
    }
  }
  if (!best) return prompts.slice(0, FIXTURE_REPLAY_WINDOW.maxPrompts);
  const start = Math.max(
    0,
    best.index - FIXTURE_REPLAY_WINDOW.actionContextPrompts,
  );
  return prompts.slice(start, best.index + 1);
}

function isLikelyFixtureActionPrompt(prompt: string): boolean {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return false;
  if (/^(continue|great|ok|yes|no|status\??)$/i.test(normalized)) {
    return false;
  }
  if (
    /^(and\s+)?(what|when|why|how|does|did|is|are|can|could|should|would|will|explain|describe|list|check|confirm|look)\b/i.test(
      normalized,
    ) ||
    /\?$/.test(normalized)
  ) {
    return false;
  }
  return FIXTURE_ACTION_PROMPT_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function scoreFixturePromptWindowRelevance(
  prompts: string[],
  actionIndex: number,
  terms: string[],
): number {
  const startIndex = Math.max(
    0,
    actionIndex - FIXTURE_REPLAY_WINDOW.actionContextPrompts,
  );
  return prompts
    .slice(startIndex, actionIndex + 1)
    .reduce(
      (sum, prompt) => sum + scoreFixturePromptRelevance(prompt, terms),
      0,
    );
}

function scoreFixturePromptRelevance(prompt: string, terms: string[]): number {
  const normalized = prompt.toLowerCase();
  let score = 0;
  for (const term of unique(terms)) {
    if (!normalized.includes(term)) continue;
    score += term.length <= 4 ? 1 : 4;
  }
  return score;
}

function measureScenario(
  scenario: Scenario,
  args: Args,
): ScenarioMeasurement[] {
  const oracle = buildOracle(scenario);
  const panopFeatures = buildPanopFeatureContexts(
    scenario,
    args.injectionFeatures,
  );
  const panop = isReliablePanopFeatureSet(args.injectionFeatures)
    ? buildReliablePanopHistoricalContext(panopFeatures)
    : mergePanopFeatureContexts(panopFeatures, args.injectionFeatures);
  let originalCrg: TreatmentContext | null = null;
  let optimizedCrg: TreatmentContext | null = null;

  return args.arms.map((arm) => {
    let context: TreatmentContext;
    if (arm === "none") {
      context = emptyContext();
    } else if (arm === "panop") {
      context = panop;
    } else if (arm === "original-crg") {
      originalCrg ??= buildCrgContext(scenario);
      context = originalCrg;
    } else {
      optimizedCrg ??= buildOptimizedCrgContext(scenario, panop);
      context = mergeContexts(panop, optimizedCrg);
    }
    return measureScenarioArm(
      scenario,
      oracle,
      SELECTED_FEATURE_NAME,
      arm,
      context,
    );
  });
}

function measureScenarioArm(
  scenario: Scenario,
  oracle: Oracle,
  feature: string,
  arm: ArmName,
  treatment: TreatmentContext,
): ScenarioMeasurement {
  const fileMatches = countMatches(treatment.files, oracle.files);
  const sessionMatches = countMatches(treatment.sessionIds, oracle.sessionIds);
  const matchedDiscoveryTokens = sumMatchedDiscoveryTokens(
    treatment.files,
    oracle,
  );
  const netDiscoveryTokenDelta =
    oracle.source === "pre_edit_discovery"
      ? matchedDiscoveryTokens - treatment.contextTokens
      : null;
  return {
    feature,
    arm,
    session_id: scenario.session_id,
    pr_number: scenario.pr_number,
    title: scenario.title,
    oracleSource: oracle.source,
    oracleFiles: oracle.files.length,
    oracleSessions: oracle.sessionIds.length,
    discoveryReads: oracle.discoveryReads,
    discoveryReadTokens: oracle.discoveryReadTokens,
    treatmentFiles: treatment.files.length,
    treatmentSessions: treatment.sessionIds.length,
    treatmentContextTokens: treatment.contextTokens,
    treatmentInjectionEvents: treatment.injectionEvents,
    treatmentSessionStartEvents: treatment.sessionStartEvents,
    treatmentUserPromptEvents: treatment.userPromptEvents,
    treatmentPreToolUseEvents: treatment.preToolUseEvents,
    treatmentCrgCandidateFiles: treatment.crgCandidateFiles,
    treatmentCrgSeedCandidateFiles: treatment.crgSeedCandidateFiles,
    treatmentCrgRelatedCandidateFiles: treatment.crgRelatedCandidateFiles,
    treatmentCrgPanopNearCandidateFiles: treatment.crgPanopNearCandidateFiles,
    fileHits: fileMatches.oracleHits,
    fileCandidateHits: fileMatches.candidateHits,
    sessionHits: sessionMatches.oracleHits,
    matchedDiscoveryTokens,
    netDiscoveryTokenDelta,
    fileRecall: ratio(fileMatches.oracleHits, oracle.files.length),
    filePrecision: ratio(fileMatches.candidateHits, treatment.files.length),
    sessionRecall: ratio(sessionMatches.oracleHits, oracle.sessionIds.length),
  };
}

function buildOracle(scenario: Scenario): Oracle {
  if (scenario.expected_diffstat) {
    const files = parseDiffstatFiles(scenario.expected_diffstat)
      .map((filePath) =>
        normalizePathKey(filePath, scenario.cwd, scenario.repoRoot),
      )
      .filter((value): value is string => value !== null);
    const fileWeights = Object.fromEntries(files.map((file) => [file, 0]));
    return {
      source: "expected_diffstat",
      files: unique(files).sort(),
      fileWeights,
      sessionIds: [],
      discoveryReads: 0,
      discoveryReadTokens: 0,
    };
  }
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tool_name, category, input_json, result_content_length
       FROM tool_calls
       WHERE session_id = ?
         ${scenario.first_edit_tool_call_id == null ? "" : "AND id < ?"}
       ORDER BY id ASC
       LIMIT 1000`,
    )
    .all(
      ...(scenario.first_edit_tool_call_id == null
        ? [scenario.session_id]
        : [scenario.session_id, scenario.first_edit_tool_call_id]),
    ) as ToolCallRow[];

  const files = new Set<string>();
  const sessionIds = new Set<string>();
  const fileWeights = new Map<string, number>();
  let discoveryReads = 0;
  let discoveryReadTokens = 0;

  for (const row of rows) {
    const input = parseInput(row.input_json);
    for (const id of extractSessionIds(input)) sessionIds.add(id);

    const paths = unique(
      extractReadPaths(row, input, scenario.cwd)
        .map((filePath) =>
          normalizePathKey(filePath, scenario.cwd, scenario.repoRoot),
        )
        .filter((value): value is string => value !== null),
    );
    if (paths.length === 0) continue;
    const tokens = estimateReadResultTokens(row.result_content_length);
    discoveryReads += 1;
    discoveryReadTokens += tokens;
    const perPathTokens = tokens / paths.length;
    for (const filePath of paths) {
      files.add(filePath);
      fileWeights.set(
        filePath,
        (fileWeights.get(filePath) ?? 0) + perPathTokens,
      );
    }
  }

  if (discoveryReads === 0 && scenario.first_edit_ts_ms != null) {
    return buildHookDiscoveryOracle(scenario);
  }

  return {
    source: "pre_edit_discovery",
    files: [...files].sort(),
    fileWeights: Object.fromEntries(fileWeights),
    sessionIds: [...sessionIds].sort(),
    discoveryReads,
    discoveryReadTokens,
  };
}

function buildHookDiscoveryOracle(scenario: Scenario): Oracle {
  if (scenario.first_edit_ts_ms == null) {
    return emptyOracle("pre_edit_discovery");
  }
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tool_name, file_path, command,
              LENGTH(tool_result) AS result_len
       FROM hook_events
       WHERE session_id = ?
         AND event_type = 'PostToolUse'
         AND timestamp_ms < ?
       ORDER BY timestamp_ms ASC, id ASC
       LIMIT 1000`,
    )
    .all(scenario.session_id, scenario.first_edit_ts_ms) as HookDiscoveryRow[];

  const files = new Set<string>();
  const fileWeights = new Map<string, number>();
  let discoveryReads = 0;
  let discoveryReadTokens = 0;

  for (const row of rows) {
    const paths = unique(
      extractHookReadPaths(row, scenario.cwd)
        .map((filePath) =>
          normalizePathKey(filePath, scenario.cwd, scenario.repoRoot),
        )
        .filter((value): value is string => value !== null),
    );
    if (paths.length === 0) continue;

    const tokens = estimateReadResultTokens(row.result_len);
    discoveryReads += 1;
    discoveryReadTokens += tokens;
    const perPathTokens = tokens / paths.length;
    for (const filePath of paths) {
      files.add(filePath);
      fileWeights.set(
        filePath,
        (fileWeights.get(filePath) ?? 0) + perPathTokens,
      );
    }
  }

  return {
    source: "pre_edit_discovery",
    files: [...files].sort(),
    fileWeights: Object.fromEntries(fileWeights),
    sessionIds: [],
    discoveryReads,
    discoveryReadTokens,
  };
}

export function estimateReadResultTokens(
  resultLength: number | null | undefined,
): number {
  const length = resultLength ?? 0;
  if (length <= 0) return 0;
  return Math.max(
    MIN_TOKENS_PER_NON_EMPTY_READ,
    Math.ceil(length / CHARS_PER_TOKEN),
  );
}

function emptyOracle(source: Oracle["source"]): Oracle {
  return {
    source,
    files: [],
    fileWeights: {},
    sessionIds: [],
    discoveryReads: 0,
    discoveryReadTokens: 0,
  };
}

function buildPanopFeatureContexts(
  scenario: Scenario,
  selectedFeatures: readonly PanopFeatureName[] = PANOP_FEATURE_NAMES,
): Record<PanopFeatureName, TreatmentContext> {
  const selected = new Set(selectedFeatures);
  return {
    sessionstart: selected.has("sessionstart")
      ? buildPanopSessionStartContext(scenario)
      : emptyContext(),
    userpromptsubmit: selected.has("userpromptsubmit")
      ? buildPanopUserPromptSubmitContext(scenario)
      : emptyContext(),
    pretooluse: selected.has("pretooluse")
      ? buildPanopPreToolUseReadContext(scenario)
      : emptyContext(),
  };
}

export function buildReliablePanopHistoricalContext(
  features: Record<PanopFeatureName, TreatmentContext>,
): TreatmentContext {
  // Keep the headline historical proxy aligned with replay execution:
  // PreToolUse uses current fileOverview data today, not a point-in-time view.
  return mergeContexts(features.sessionstart, features.userpromptsubmit);
}

function mergePanopFeatureContexts(
  features: Record<PanopFeatureName, TreatmentContext>,
  selectedFeatures: readonly PanopFeatureName[],
): TreatmentContext {
  return selectedFeatures.reduce(
    (acc, feature) => mergeContexts(acc, features[feature]),
    emptyContext(),
  );
}

function isReliablePanopFeatureSet(
  features: readonly PanopFeatureName[],
): boolean {
  const selected = new Set(features);
  return (
    selected.size === RELIABLE_INJECTION_FEATURES.length &&
    RELIABLE_INJECTION_FEATURES.every((feature) => selected.has(feature))
  );
}

function buildPanopSessionStartContext(scenario: Scenario): TreatmentContext {
  const untilMs = scenario.started_at_ms - 1;
  const excludeSessionIds = [scenario.session_id];
  const files = new Set<string>();
  const sessionIds = new Set<string>();
  let contextBytes = 0;
  let injectionEvents = 0;
  let sessionStartTokens = 0;

  const sessionStart = buildSessionStartRecentHistoryContext({
    session_id: scenario.session_id,
    cwd: scenario.cwd,
    repository: scenario.repository,
    now_ms: untilMs,
    exclude_session_ids: excludeSessionIds,
  });
  if (sessionStart) {
    injectionEvents += 1;
    contextBytes += Buffer.byteLength(sessionStart);
    sessionStartTokens = Math.ceil(
      Buffer.byteLength(sessionStart) / CHARS_PER_TOKEN,
    );
  }

  const recent = listRecentSessionSummaryPreviewsForCwd({
    cwdCandidates: [scenario.cwd],
    currentSessionId: scenario.session_id,
    excludeSessionIds,
    sinceMs: untilMs - RECENT_HISTORY_MAX_AGE_MS,
    untilMs,
    limit: 5,
  });
  addPreviewContext(recent, files, sessionIds, scenario.repoRoot);

  return {
    ...emptyContext(),
    files: [...files].sort(),
    sessionIds: [...sessionIds].sort(),
    contextTokens: Math.ceil(contextBytes / CHARS_PER_TOKEN),
    contextBytes,
    injectionEvents,
    sessionStartTokens,
    sessionStartEvents: injectionEvents,
  };
}

function buildPanopUserPromptSubmitContext(
  scenario: Scenario,
): TreatmentContext {
  const untilMs = scenario.started_at_ms - 1;
  const excludeSessionIds = [scenario.session_id];
  const files = new Set<string>();
  const sessionIds = new Set<string>();
  let contextBytes = 0;
  let injectionEvents = 0;
  let userPromptTokens = 0;
  let userPromptEvents = 0;

  const prompts = promptsBeforeFirstEdit(scenario).slice(1);
  for (const prompt of prompts) {
    const promptContext = buildUserPromptSubmitLocalContext({
      session_id: scenario.session_id,
      cwd: scenario.cwd,
      repository: scenario.repository,
      prompt: prompt.user_prompt,
      now_ms: untilMs,
      exclude_session_ids: excludeSessionIds,
    });
    if (promptContext) {
      injectionEvents += 1;
      userPromptEvents += 1;
      const bytes = Buffer.byteLength(promptContext);
      contextBytes += bytes;
      userPromptTokens += Math.ceil(bytes / CHARS_PER_TOKEN);
    }
    const relevant = listRelevantSessionSummaryPreviewsForPrompt({
      prompt: prompt.user_prompt,
      cwdCandidates: [scenario.cwd],
      repository: scenario.repository,
      currentSessionId: scenario.session_id,
      excludeSessionIds,
      sinceMs: untilMs - USER_PROMPT_MAX_AGE_MS,
      untilMs,
      limit: 2,
      minMatchCount: 3,
    });
    addPreviewContext(relevant, files, sessionIds, scenario.repoRoot);
  }

  return {
    ...emptyContext(),
    files: [...files].sort(),
    sessionIds: [...sessionIds].sort(),
    contextTokens: Math.ceil(contextBytes / CHARS_PER_TOKEN),
    contextBytes,
    injectionEvents,
    userPromptTokens,
    userPromptEvents,
  };
}

function buildPanopPreToolUseReadContext(scenario: Scenario): TreatmentContext {
  const rows = preToolUseReadRowsBeforeFirstEdit(scenario);
  const files = new Set<string>();
  let contextBytes = 0;
  let injectionEvents = 0;
  let preToolUseTokens = 0;
  const seenPaths = new Set<string>();

  for (const row of rows) {
    const key = normalizePathKey(
      row.file_path,
      row.cwd ?? scenario.cwd,
      scenario.repoRoot,
    );
    if (!key || seenPaths.has(key)) continue;
    const context = buildPreToolUseReadFileContext({
      session_id: scenario.session_id,
      cwd: row.cwd ?? scenario.cwd,
      repository: row.repository ?? scenario.repository,
      now_ms: row.timestamp_ms,
      tool_input: { file_path: row.file_path },
    });
    if (!context) continue;

    seenPaths.add(key);
    files.add(key);
    injectionEvents += 1;
    const bytes = Buffer.byteLength(context);
    contextBytes += bytes;
    preToolUseTokens += Math.ceil(bytes / CHARS_PER_TOKEN);
  }

  return {
    ...emptyContext(),
    files: [...files].sort(),
    contextTokens: Math.ceil(contextBytes / CHARS_PER_TOKEN),
    contextBytes,
    injectionEvents,
    preToolUseTokens,
    preToolUseEvents: injectionEvents,
  };
}

function buildCrgContext(scenario: Scenario): TreatmentContext {
  const graphDb = path.join(
    scenario.repoRoot,
    ".code-review-graph",
    "graph.db",
  );
  if (!fs.existsSync(graphDb)) return emptyContext();

  let db: Database;
  try {
    db = new Database(graphDb, { readonly: true, fileMustExist: true });
  } catch {
    return emptyContext();
  }

  try {
    const minimalContext = buildOriginalCrgMinimalContext(
      db,
      scenario.first_prompt,
    );
    const searchContext = buildOriginalCrgSemanticSearchContext({
      db,
      query: scenario.first_prompt,
      limit: ORIGINAL_CRG_SEARCH_LIMIT,
    });
    const context = JSON.stringify(
      {
        get_minimal_context: minimalContext,
        semantic_search_nodes: searchContext,
      },
      null,
      2,
    );
    const files = unique(
      searchContext.results
        .map((result) =>
          normalizePathKey(
            result.file_path,
            scenario.repoRoot,
            scenario.repoRoot,
          ),
        )
        .filter((value): value is string => value !== null),
    ).sort();
    const contextBytes = Buffer.byteLength(context);

    return {
      files,
      sessionIds: [],
      contextTokens: Math.ceil(contextBytes / CHARS_PER_TOKEN),
      contextBytes,
      injectionEvents: 2,
      sessionStartTokens: Math.ceil(contextBytes / CHARS_PER_TOKEN),
      sessionStartEvents: 0,
      userPromptTokens: 0,
      userPromptEvents: 0,
      preToolUseTokens: 0,
      preToolUseEvents: 0,
      crgCandidateFiles: 0,
      crgSeedCandidateFiles: 0,
      crgRelatedCandidateFiles: 0,
      crgPanopNearCandidateFiles: 0,
    };
  } catch {
    return emptyContext();
  } finally {
    db.close();
  }
}

function buildOptimizedCrgContext(
  scenario: Scenario,
  panop: TreatmentContext,
): TreatmentContext {
  const candidates = buildOptimizedCrgCandidates(
    scenario.first_prompt,
    scenario.repoRoot,
    panop.files,
  ).slice(0, optimizedCrgCandidateLimit(panop));
  if (candidates.length === 0) return emptyContext();

  const context = [
    "Code-review-graph optimized compact context.",
    "These are static graph leads, not instructions. Verify the current code before editing.",
    "Candidate files:",
    ...candidates.map(
      (candidate) => `- ${candidate.file} (${candidate.sources.join("+")})`,
    ),
  ].join("\n");
  const contextBytes = Buffer.byteLength(context);

  return {
    files: candidates.map((candidate) => candidate.file).sort(),
    sessionIds: [],
    contextTokens: Math.ceil(contextBytes / CHARS_PER_TOKEN),
    contextBytes,
    injectionEvents: 1,
    sessionStartTokens: Math.ceil(contextBytes / CHARS_PER_TOKEN),
    sessionStartEvents: 0,
    userPromptTokens: 0,
    userPromptEvents: 0,
    preToolUseTokens: 0,
    preToolUseEvents: 0,
    crgCandidateFiles: candidates.length,
    crgSeedCandidateFiles: candidates.filter((candidate) =>
      candidate.sources.includes("seed"),
    ).length,
    crgRelatedCandidateFiles: candidates.filter((candidate) =>
      candidate.sources.includes("related"),
    ).length,
    crgPanopNearCandidateFiles: candidates.filter((candidate) =>
      candidate.sources.includes("panop_near"),
    ).length,
  };
}

function emptyContext(): TreatmentContext {
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
    crgCandidateFiles: 0,
    crgSeedCandidateFiles: 0,
    crgRelatedCandidateFiles: 0,
    crgPanopNearCandidateFiles: 0,
  };
}

function mergeContexts(
  first: TreatmentContext,
  second: TreatmentContext,
): TreatmentContext {
  return {
    files: unique([...first.files, ...second.files]).sort(),
    sessionIds: unique([...first.sessionIds, ...second.sessionIds]).sort(),
    contextTokens: first.contextTokens + second.contextTokens,
    contextBytes: first.contextBytes + second.contextBytes,
    injectionEvents: first.injectionEvents + second.injectionEvents,
    sessionStartTokens: first.sessionStartTokens + second.sessionStartTokens,
    sessionStartEvents: first.sessionStartEvents + second.sessionStartEvents,
    userPromptTokens: first.userPromptTokens + second.userPromptTokens,
    userPromptEvents: first.userPromptEvents + second.userPromptEvents,
    preToolUseTokens: first.preToolUseTokens + second.preToolUseTokens,
    preToolUseEvents: first.preToolUseEvents + second.preToolUseEvents,
    crgCandidateFiles: first.crgCandidateFiles + second.crgCandidateFiles,
    crgSeedCandidateFiles:
      first.crgSeedCandidateFiles + second.crgSeedCandidateFiles,
    crgRelatedCandidateFiles:
      first.crgRelatedCandidateFiles + second.crgRelatedCandidateFiles,
    crgPanopNearCandidateFiles:
      first.crgPanopNearCandidateFiles + second.crgPanopNearCandidateFiles,
  };
}

function addPreviewContext(
  previews: SessionSummaryPreview[],
  files: Set<string>,
  sessionIds: Set<string>,
  repoRoot: string,
): void {
  for (const preview of previews) {
    sessionIds.add(preview.session_id);
    for (const file of preview.top_files) {
      const key = normalizePathKey(file.file_path, repoRoot, repoRoot);
      if (key) files.add(key);
    }
  }
}

function promptsBeforeFirstEdit(scenario: Scenario): PromptRow[] {
  if (scenario.fixturePrompts) {
    return scenario.fixturePrompts.map((userPrompt, index) => ({
      user_prompt: userPrompt,
      timestamp_ms: scenario.started_at_ms + index,
    }));
  }
  const db = getDb();
  return db
    .prepare(
      `SELECT user_prompt, timestamp_ms
       FROM hook_events
       WHERE session_id = ?
         AND event_type = 'UserPromptSubmit'
         AND user_prompt IS NOT NULL
         AND TRIM(user_prompt) != ''
         ${scenario.first_edit_ts_ms == null ? "" : "AND timestamp_ms < ?"}
       ORDER BY timestamp_ms ASC, id ASC
       LIMIT 50`,
    )
    .all(
      ...(scenario.first_edit_ts_ms == null
        ? [scenario.session_id]
        : [scenario.session_id, scenario.first_edit_ts_ms]),
    ) as PromptRow[];
}

function preToolUseReadRowsBeforeFirstEdit(
  scenario: Scenario,
): PreToolUseReadRow[] {
  if (scenario.first_edit_ts_ms == null) return [];
  const db = getDb();
  return db
    .prepare(
      `SELECT file_path, timestamp_ms, cwd, repository
       FROM hook_events
       WHERE session_id = ?
         AND event_type = 'PreToolUse'
         AND tool_name = 'Read'
         AND file_path IS NOT NULL
         AND TRIM(file_path) != ''
         AND timestamp_ms < ?
       ORDER BY timestamp_ms ASC, id ASC
       LIMIT 1000`,
    )
    .all(scenario.session_id, scenario.first_edit_ts_ms) as PreToolUseReadRow[];
}

export function parseDiffstatFiles(diffstat: string): string[] {
  return unique(
    diffstat
      .split("\n")
      .map((line) => line.match(/^\s*(.+?)\s+\|/)?.[1]?.trim() ?? null)
      .filter((filePath): filePath is string => filePath != null)
      .filter((filePath) => !/^\d+ files? changed/.test(filePath))
      .map(normalizeDiffstatFilePath),
  ).sort();
}

function normalizeDiffstatFilePath(filePath: string): string {
  const braceExpanded = filePath.replace(
    /\{([^{}]*?)\s*=>\s*([^{}]*?)\}/g,
    "$2",
  );
  if (!braceExpanded.includes("=>")) return braceExpanded;
  return braceExpanded.split("=>").at(-1)?.trim() ?? braceExpanded;
}

function extractReadPaths(
  row: ToolCallRow,
  input: Record<string, unknown> | null,
  cwd: string,
): string[] {
  const tool = row.tool_name ?? "";
  if (READ_TOOLS.has(tool)) {
    return extractPathValues(input);
  }
  if (tool === "Bash" || tool === "exec_command") {
    const cmd = typeof input?.cmd === "string" ? input.cmd : null;
    if (!isReadOnlyCommand(cmd)) return [];
    return extractCommandPaths(cmd ?? "", cwd);
  }
  return [];
}

function extractHookReadPaths(row: HookDiscoveryRow, cwd: string): string[] {
  const tool = row.tool_name ?? "";
  if (READ_TOOLS.has(tool)) {
    return row.file_path ? [row.file_path] : [];
  }
  if (tool === "Bash" || tool === "exec_command") {
    if (!isReadOnlyCommand(row.command)) return [];
    return extractCommandPaths(row.command ?? "", cwd);
  }
  return [];
}

function extractPathValues(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return looksLikeFile(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(extractPathValues);
  if (typeof value !== "object") return [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (/path|file/i.test(key)) out.push(...extractPathValues(child));
  }
  return out;
}

function extractSessionIds(input: Record<string, unknown> | null): string[] {
  if (!input) return [];
  const values = [input.session_id, input.sessionId]
    .filter((value): value is string => typeof value === "string")
    .filter((value) => /^[0-9a-f-]{20,}$/i.test(value));
  return unique(values);
}

function isReadOnlyCommand(command: string | null): boolean {
  if (!command) return false;
  const cmd = command.trim();
  if (cmd.length === 0) return false;
  if (/[^>]>>?[^>]|\btee\b|\bsponge\b/.test(cmd)) return false;
  const segments = cmd.split(/\||&&|\|\||;/).map((segment) => segment.trim());
  for (const segment of segments) {
    if (segment.length === 0) continue;
    const tokens = segment
      .split(/\s+/)
      .filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    const head = tokens[0];
    if (!head) return false;
    if (head === "sudo" || head === "xargs" || head === "env") return false;
    if (head === "git") {
      const sub = tokens.find(
        (token, index) => index > 0 && !token.startsWith("-"),
      );
      if (!sub || !READ_GIT_SUBCMDS.has(sub)) return false;
      continue;
    }
    if (!READ_SHELL_VERBS.has(head)) return false;
  }
  return true;
}

function extractCommandPaths(command: string, cwd: string): string[] {
  const out: string[] = [];
  const normalized = command.replace(/[:,]$/g, "");
  for (const raw of normalized.split(/\s+/)) {
    const token = raw.replace(/^['"]|['"]$/g, "").replace(/[:,]$/g, "");
    if (!looksLikeFile(token)) continue;
    out.push(path.isAbsolute(token) ? token : path.resolve(cwd, token));
  }
  return out;
}

function buildOptimizedCrgCandidates(
  prompt: string,
  repoRoot: string,
  panopFiles: readonly string[],
): CrgCandidate[] {
  const terms = tokenizeOptimizedCrgPrompt(prompt);
  if (!hasUsefulCrgPromptSignal(prompt, terms)) return [];

  const seeds = searchOptimizedCrgSeedFiles(repoRoot, terms).slice(
    0,
    OPTIMIZED_CRG_SEED_LIMIT,
  );
  if (seeds.length === 0) return [];

  const provider = createCodeReviewGraphProvider();
  const candidates = new Map<string, CrgCandidate>();

  for (const seed of seeds) {
    addCrgCandidate(candidates, seed.file, 450 + seed.score * 40, "seed");
    try {
      const overview = provider.fileOverview({
        repoRoot,
        filePath: seed.file,
      });
      for (const [index, relatedFile] of (
        overview.related_files ?? []
      ).entries()) {
        const key = normalizePathKey(relatedFile, repoRoot, repoRoot);
        if (key) {
          addCrgCandidate(
            candidates,
            key,
            Math.max(60, 260 - index * 15),
            "related",
          );
        }
      }
    } catch {
      // Keep the combined arm measurable even if one stale graph seed fails.
    }
  }

  return rankOptimizedCrgCandidatesForPanop(
    [...candidates.values()],
    panopFiles,
  );
}

export function rankOptimizedCrgCandidatesForPanop(
  candidates: CrgCandidate[],
  panopFiles: readonly string[],
): CrgCandidate[] {
  const hasPanopFiles = panopFiles.length > 0;
  return candidates
    .map((candidate) => ({ ...candidate, sources: [...candidate.sources] }))
    .filter((candidate) => !isPanopDuplicateFile(candidate.file, panopFiles))
    .map((candidate) => {
      const affinity = panopAffinityScore(candidate.file, panopFiles);
      if (affinity > 0) {
        candidate.score += affinity;
        if (!candidate.sources.includes("panop_near")) {
          candidate.sources.push("panop_near");
        }
      }
      return candidate;
    })
    .filter((candidate) =>
      shouldKeepOptimizedCrgCandidate(candidate, hasPanopFiles),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.sources.length - a.sources.length ||
        a.file.localeCompare(b.file),
    );
}

function optimizedCrgCandidateLimit(panop: TreatmentContext): number {
  if (panop.files.length >= 8)
    return OPTIMIZED_CRG_CANDIDATE_LIMIT_STRONG_PANOP;
  if (panop.files.length > 0) return OPTIMIZED_CRG_CANDIDATE_LIMIT_WITH_PANOP;
  return OPTIMIZED_CRG_CANDIDATE_LIMIT_EMPTY_PANOP;
}

function shouldKeepOptimizedCrgCandidate(
  candidate: CrgCandidate,
  hasPanopFiles: boolean,
): boolean {
  if (candidate.score < OPTIMIZED_CRG_MIN_CANDIDATE_SCORE) return false;
  if (!hasPanopFiles) return true;
  if (candidate.sources.includes("panop_near")) return true;
  if (candidate.sources.includes("seed") && candidate.score >= 250) {
    return true;
  }
  return candidate.sources.includes("related") && candidate.score >= 240;
}

function isPanopDuplicateFile(
  candidateFile: string,
  panopFiles: readonly string[],
): boolean {
  return panopFiles.some((panopFile) => pathMatches(candidateFile, panopFile));
}

function panopAffinityScore(
  candidateFile: string,
  panopFiles: readonly string[],
): number {
  let best = 0;
  for (const panopFile of panopFiles) {
    if (pathMatches(candidateFile, panopFile)) return 0;
    let score = 0;
    if (path.dirname(candidateFile) === path.dirname(panopFile)) score += 260;
    if (sourceTestStem(candidateFile) === sourceTestStem(panopFile)) {
      score += 240;
    }
    if (topLevelDir(candidateFile) === topLevelDir(panopFile)) score += 80;
    best = Math.max(best, score);
  }
  return best;
}

function sourceTestStem(filePath: string): string {
  const parsed = path.parse(filePath);
  return path
    .join(parsed.dir, parsed.name)
    .replace(/(?:^|[./_-])(?:spec|test)$/i, "")
    .replace(/(?:^|[./_-])(?:tests?|__tests__)$/i, "");
}

function topLevelDir(filePath: string): string {
  return filePath.split("/")[0] ?? "";
}

function hasUsefulCrgPromptSignal(
  prompt: string,
  terms: readonly string[],
): boolean {
  if (terms.length >= 2) return true;
  if (
    /\b[\w./-]+\.(?:cjs|css|html|js|json|jsx|md|mjs|sql|sh|ts|tsx|yaml|yml)\b/i.test(
      prompt,
    )
  ) {
    return true;
  }
  return /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b|[a-z0-9]+_[a-z0-9_]+|--[a-z0-9-]+/i.test(
    prompt,
  );
}

function addCrgCandidate(
  candidates: Map<string, CrgCandidate>,
  file: string,
  score: number,
  source: string,
): void {
  const existing = candidates.get(file);
  if (!existing) {
    candidates.set(file, { file, score, sources: [source] });
    return;
  }
  existing.score += score;
  if (!existing.sources.includes(source)) existing.sources.push(source);
}

function searchOptimizedCrgSeedFiles(
  repoRoot: string,
  terms: readonly string[],
): CrgSeed[] {
  if (terms.length === 0) return [];

  const rows = loadOptimizedCrgSearchNodes(repoRoot);
  if (!rows) return [];

  const scored = rows
    .map((row) => {
      const haystack =
        `${row.name} ${row.qualified_name} ${row.file_path}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += term.includes("_") ? 5 : 1;
      }
      if (row.kind === "File") score += 0.5;
      return { row, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.row.file_path.localeCompare(b.row.file_path) ||
        a.row.name.localeCompare(b.row.name),
    );

  const byFile = new Map<string, number>();
  for (const item of scored) {
    const file = normalizePathKey(item.row.file_path, repoRoot, repoRoot);
    if (!file) continue;
    byFile.set(file, Math.max(byFile.get(file) ?? 0, item.score));
  }
  return [...byFile.entries()]
    .map(([file, score]) => ({ file, score }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, OPTIMIZED_CRG_SEED_LIMIT);
}

function loadOptimizedCrgSearchNodes(repoRoot: string): RawCrgNode[] | null {
  const graphDb = path.join(repoRoot, ".code-review-graph", "graph.db");
  if (optimizedCrgNodeCache.has(graphDb)) {
    return optimizedCrgNodeCache.get(graphDb) ?? null;
  }
  if (!fs.existsSync(graphDb)) {
    optimizedCrgNodeCache.set(graphDb, null);
    return null;
  }

  let db: Database;
  try {
    db = new Database(graphDb, { readonly: true, fileMustExist: true });
  } catch {
    optimizedCrgNodeCache.set(graphDb, null);
    return null;
  }

  try {
    const rows = db
      .prepare(
        `SELECT id, name, qualified_name, kind, file_path, line_start, line_end,
                language, params, return_type, signature
         FROM nodes
         WHERE kind IN ('File', 'Class', 'Function', 'Test')
         ORDER BY id`,
      )
      .all() as RawCrgNode[];
    optimizedCrgNodeCache.set(graphDb, rows);
    return rows;
  } catch {
    optimizedCrgNodeCache.set(graphDb, null);
    return null;
  } finally {
    db.close();
  }
}

function tokenizeOptimizedCrgPrompt(prompt: string): string[] {
  const terms = prompt.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  return unique(
    terms
      .map((term) => term.replace(/^-+|-+$/g, ""))
      .filter((term) => term.length >= 3 && !OPTIMIZED_CRG_STOPWORDS.has(term)),
  ).slice(0, 12);
}

function buildOriginalCrgMinimalContext(
  db: Database,
  task: string,
): Record<string, unknown> {
  const nodeCount = (
    db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as RawCrgCount
  ).c;
  const edgeCount = (
    db.prepare("SELECT COUNT(*) AS c FROM edges").get() as RawCrgCount
  ).c;
  const fileCount = (
    db
      .prepare("SELECT COUNT(DISTINCT file_path) AS c FROM nodes")
      .get() as RawCrgCount
  ).c;
  const communities = (
    db
      .prepare("SELECT name FROM communities ORDER BY size DESC LIMIT 3")
      .all() as RawCrgName[]
  ).map((row) => row.name);
  const flows = (
    db
      .prepare("SELECT name FROM flows ORDER BY criticality DESC LIMIT 3")
      .all() as RawCrgName[]
  ).map((row) => row.name);

  return compactCrgResponse({
    summary: `${nodeCount} nodes, ${edgeCount} edges across ${fileCount} files.`,
    communities,
    flows_affected: flows,
    next_tool_suggestions: originalCrgToolSuggestions(task),
  });
}

function compactCrgResponse(input: {
  summary: string;
  key_entities?: string[];
  risk?: string;
  communities?: string[];
  flows_affected?: string[];
  next_tool_suggestions?: string[];
}): Record<string, unknown> {
  const response: Record<string, unknown> = {
    status: "ok",
    summary: input.summary,
  };
  if (input.key_entities && input.key_entities.length > 0) {
    response.key_entities = input.key_entities.slice(0, 10);
  }
  if (input.risk && input.risk !== "unknown") response.risk = input.risk;
  if (input.communities && input.communities.length > 0) {
    response.communities = input.communities.slice(0, 5);
  }
  if (input.flows_affected && input.flows_affected.length > 0) {
    response.flows_affected = input.flows_affected.slice(0, 5);
  }
  if (input.next_tool_suggestions && input.next_tool_suggestions.length > 0) {
    response.next_tool_suggestions = input.next_tool_suggestions.slice(0, 3);
  }
  return response;
}

function originalCrgToolSuggestions(task: string): string[] {
  const taskLower = task.toLowerCase();
  if (/\b(review|pr|merge|diff)\b/.test(taskLower)) {
    return ["detect_changes", "get_affected_flows", "get_review_context"];
  }
  if (/\b(debug|bug|error|fix)\b/.test(taskLower)) {
    return ["semantic_search_nodes", "query_graph", "get_flow"];
  }
  if (/\b(refactor|rename|dead|clean)\b/.test(taskLower)) {
    return ["refactor", "find_large_functions", "get_architecture_overview"];
  }
  if (/\b(onboard|understand|explore|arch)\b/.test(taskLower)) {
    return ["get_architecture_overview", "list_communities", "list_flows"];
  }
  return [
    "detect_changes",
    "semantic_search_nodes",
    "get_architecture_overview",
  ];
}

function buildOriginalCrgSemanticSearchContext(input: {
  db: Database;
  query: string;
  limit: number;
}): {
  status: "ok";
  query: string;
  search_mode: "hybrid" | "keyword";
  summary: string;
  results: OriginalCrgSearchResult[];
} {
  const results = originalCrgHybridSearch(input.db, input.query, input.limit);
  return {
    status: "ok",
    query: input.query,
    search_mode: results.searchMode,
    summary: `Found ${results.rows.length} node(s) matching '${input.query}'`,
    results: results.rows.slice(0, 5).map((row) => ({
      name: sanitizeCrgName(row.name),
      kind: row.kind,
      file_path: row.file_path,
      score: Number((row.score ?? 0).toFixed(6)),
    })),
  };
}

function originalCrgHybridSearch(
  db: Database,
  query: string,
  limit: number,
): { searchMode: "hybrid" | "keyword"; rows: RawCrgNode[] } {
  if (!query.trim()) return { searchMode: "keyword", rows: [] };
  const fetchLimit = limit * 3;
  const ftsResults = originalCrgFtsSearch(db, query, fetchLimit);
  const merged =
    ftsResults.length > 0
      ? rrfMerge(ftsResults)
      : originalCrgKeywordSearch(db, query, fetchLimit);
  if (merged.length === 0) return { searchMode: "keyword", rows: [] };

  const rowsById = loadCrgRowsById(
    db,
    merged.map(([nodeId]) => nodeId),
  );
  const boosts = detectOriginalCrgQueryKindBoost(query);
  const boosted = merged
    .map(([nodeId, score]) => {
      const row = rowsById.get(nodeId);
      if (!row) return null;
      let boost = 1;
      if (row.kind === "Class" && boosts.classOrType) boost *= 1.5;
      if (row.kind === "Type" && boosts.classOrType) boost *= 1.5;
      if (row.kind === "Function" && boosts.function) boost *= 1.5;
      if (
        boosts.qualified &&
        query.includes(".") &&
        row.qualified_name.toLowerCase().includes(query.toLowerCase())
      ) {
        boost *= 2;
      }
      return { ...row, score: score * boost };
    })
    .filter((row): row is RawCrgNode => row !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return {
    searchMode: ftsResults.length > 0 ? "hybrid" : "keyword",
    rows: boosted.slice(0, limit),
  };
}

function originalCrgFtsSearch(
  db: Database,
  query: string,
  limit: number,
): Array<[number, number]> {
  const safeQuery = `"${query.replaceAll('"', '""')}"`;
  try {
    return (
      db
        .prepare(
          `SELECT rowid, rank
           FROM nodes_fts
           WHERE nodes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(safeQuery, limit) as Array<{ rowid: number; rank: number }>
    ).map((row) => [row.rowid, -row.rank]);
  } catch {
    return [];
  }
}

function originalCrgKeywordSearch(
  db: Database,
  query: string,
  limit: number,
): Array<[number, number]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const word of words) {
    conditions.push("(LOWER(name) LIKE ? OR LOWER(qualified_name) LIKE ?)");
    params.push(`%${word}%`, `%${word}%`);
  }
  params.push(limit);
  try {
    const rows = db
      .prepare(
        `SELECT id, name, qualified_name
         FROM nodes
         WHERE ${conditions.join(" AND ")}
         LIMIT ?`,
      )
      .all(...params) as Array<{
      id: number;
      name: string;
      qualified_name: string;
    }>;
    const queryLower = query.toLowerCase();
    return rows
      .map((row): [number, number] => {
        const nameLower = row.name.toLowerCase();
        if (nameLower === queryLower) return [row.id, 3];
        if (nameLower.startsWith(queryLower)) return [row.id, 2];
        return [row.id, 1];
      })
      .sort((a, b) => b[1] - a[1]);
  } catch {
    return [];
  }
}

function rrfMerge(
  resultList: Array<[number, number]>,
  k = 60,
): Array<[number, number]> {
  const scores = new Map<number, number>();
  for (const [rank, [itemId]] of resultList.entries()) {
    scores.set(itemId, (scores.get(itemId) ?? 0) + 1 / (k + rank + 1));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

function loadCrgRowsById(
  db: Database,
  nodeIds: number[],
): Map<number, RawCrgNode> {
  const rowsById = new Map<number, RawCrgNode>();
  for (let i = 0; i < nodeIds.length; i += 450) {
    const batch = nodeIds.slice(i, i + 450);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, name, qualified_name, kind, file_path, line_start, line_end,
                language, params, return_type, signature
         FROM nodes
         WHERE id IN (${placeholders})`,
      )
      .all(...batch) as RawCrgNode[];
    for (const row of rows) rowsById.set(row.id, row);
  }
  return rowsById;
}

function detectOriginalCrgQueryKindBoost(query: string): {
  classOrType: boolean;
  function: boolean;
  qualified: boolean;
} {
  const q = query.trim();
  return {
    classOrType: /^[A-Z][a-z]/.test(q) && q !== q.toUpperCase(),
    function: q.includes("_") && /[a-zA-Z]/.test(q),
    qualified: q.includes("."),
  };
}

function sanitizeCrgName(value: string): string {
  return value.split(String.fromCharCode(0)).join("");
}

function aggregateMeasurementsByArm(
  measurements: ScenarioMeasurement[],
): AggregateByArm {
  return Object.fromEntries(
    ARM_NAMES.map((arm) => [
      arm,
      aggregateMeasurements(
        measurements.filter((measurement) => measurement.arm === arm),
      ),
    ]),
  ) as AggregateByArm;
}

function aggregateMeasurementsByFeatureArm(
  measurements: ScenarioMeasurement[],
): AggregateByFeatureArm {
  const features = unique([
    SELECTED_FEATURE_NAME,
    ...measurements.map((measurement) => measurement.feature),
  ]);
  return Object.fromEntries(
    features.map((feature) => [
      feature,
      aggregateMeasurementsByArm(
        measurements.filter((measurement) => measurement.feature === feature),
      ),
    ]),
  ) as AggregateByFeatureArm;
}

export function aggregateMeasurements(
  measurements: ScenarioMeasurement[],
): Aggregate {
  const discoveryMeasurements = measurements.filter(
    (measurement) => measurement.oracleSource === "pre_edit_discovery",
  );
  const oracleFiles = sum(measurements, (m) => m.oracleFiles);
  const oracleSessions = sum(measurements, (m) => m.oracleSessions);
  const discoveryReadTokens = sum(
    discoveryMeasurements,
    (m) => m.discoveryReadTokens,
  );
  const treatmentContextTokens = sum(
    measurements,
    (m) => m.treatmentContextTokens,
  );
  const matchedDiscoveryTokens = sum(
    discoveryMeasurements,
    (m) => m.matchedDiscoveryTokens,
  );
  const netDiscoveryTokenDelta = sum(
    discoveryMeasurements,
    (m) => m.netDiscoveryTokenDelta ?? 0,
  );
  const discoveryTreatmentContextTokens = sum(
    discoveryMeasurements,
    (m) => m.treatmentContextTokens,
  );
  return {
    scenarioCount: measurements.length,
    oracleSourceCounts: {
      pre_edit_discovery: measurements.filter(
        (measurement) => measurement.oracleSource === "pre_edit_discovery",
      ).length,
      expected_diffstat: measurements.filter(
        (measurement) => measurement.oracleSource === "expected_diffstat",
      ).length,
    },
    oracleFiles,
    oracleSessions,
    discoveryReads: sum(discoveryMeasurements, (m) => m.discoveryReads),
    discoveryReadTokens,
    treatmentContextTokens,
    discoveryTreatmentContextTokens,
    treatmentInjectionEvents: sum(
      measurements,
      (m) => m.treatmentInjectionEvents,
    ),
    treatmentSessionStartEvents: sum(
      measurements,
      (m) => m.treatmentSessionStartEvents ?? 0,
    ),
    treatmentUserPromptEvents: sum(
      measurements,
      (m) => m.treatmentUserPromptEvents ?? 0,
    ),
    treatmentPreToolUseEvents: sum(
      measurements,
      (m) => m.treatmentPreToolUseEvents ?? 0,
    ),
    treatmentCrgCandidateFiles: sum(
      measurements,
      (m) => m.treatmentCrgCandidateFiles ?? 0,
    ),
    treatmentCrgSeedCandidateFiles: sum(
      measurements,
      (m) => m.treatmentCrgSeedCandidateFiles ?? 0,
    ),
    treatmentCrgRelatedCandidateFiles: sum(
      measurements,
      (m) => m.treatmentCrgRelatedCandidateFiles ?? 0,
    ),
    treatmentCrgPanopNearCandidateFiles: sum(
      measurements,
      (m) => m.treatmentCrgPanopNearCandidateFiles ?? 0,
    ),
    treatmentFiles: sum(measurements, (m) => m.treatmentFiles),
    treatmentSessions: sum(measurements, (m) => m.treatmentSessions),
    fileHits: sum(measurements, (m) => m.fileHits),
    fileCandidateHits: sum(measurements, (m) => m.fileCandidateHits),
    sessionHits: sum(measurements, (m) => m.sessionHits),
    matchedDiscoveryTokens,
    netDiscoveryTokenDelta,
    weightedFileRecall: div(
      sum(measurements, (m) => m.fileHits),
      oracleFiles,
    ),
    weightedFilePrecision: div(
      sum(measurements, (m) => m.fileCandidateHits),
      sum(measurements, (m) => m.treatmentFiles),
    ),
    weightedSessionRecall: div(
      sum(measurements, (m) => m.sessionHits),
      oracleSessions,
    ),
    matchedDiscoveryTokenRate: ratio(
      matchedDiscoveryTokens,
      discoveryReadTokens,
    ),
    contextRoi:
      discoveryMeasurements.length > 0
        ? ratio(matchedDiscoveryTokens, discoveryTreatmentContextTokens)
        : null,
    fileHitsPer1kContextTokens: div(
      sum(measurements, (m) => m.fileHits),
      treatmentContextTokens / 1000,
    ),
    macroFileRecall: meanNonNull(measurements.map((m) => m.fileRecall)),
    macroSessionRecall: meanNonNull(measurements.map((m) => m.sessionRecall)),
    meanNetDiscoveryTokenDelta: meanNonNull(
      discoveryMeasurements.map((m) => m.netDiscoveryTokenDelta),
    ),
    ci: bootstrap(measurements),
  };
}

function bootstrap(measurements: ScenarioMeasurement[]): Aggregate["ci"] {
  if (measurements.length === 0) {
    return {
      weightedFileRecall: { low: null, high: null },
      matchedDiscoveryTokenRate: { low: null, high: null },
      meanNetDiscoveryTokenDelta: { low: null, high: null },
    };
  }
  const rng = seededRandom(0x5eed);
  const fileRecall: number[] = [];
  const tokenRate: number[] = [];
  const netDelta: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const sample: ScenarioMeasurement[] = [];
    for (let j = 0; j < measurements.length; j++) {
      sample.push(measurements[Math.floor(rng() * measurements.length)]);
    }
    fileRecall.push(
      div(
        sum(sample, (m) => m.fileHits),
        sum(sample, (m) => m.oracleFiles),
      ),
    );
  }

  const discoveryMeasurements = measurements.filter(
    (measurement) => measurement.oracleSource === "pre_edit_discovery",
  );
  if (discoveryMeasurements.length > 0) {
    for (let i = 0; i < 1000; i++) {
      const sample: ScenarioMeasurement[] = [];
      for (let j = 0; j < discoveryMeasurements.length; j++) {
        sample.push(
          discoveryMeasurements[
            Math.floor(rng() * discoveryMeasurements.length)
          ],
        );
      }
      tokenRate.push(
        div(
          sum(sample, (m) => m.matchedDiscoveryTokens),
          sum(sample, (m) => m.discoveryReadTokens),
        ),
      );
      netDelta.push(
        div(
          sum(sample, (m) => m.netDiscoveryTokenDelta ?? 0),
          sample.length,
        ),
      );
    }
  }
  return {
    weightedFileRecall: percentileInterval(fileRecall),
    matchedDiscoveryTokenRate: percentileInterval(tokenRate),
    meanNetDiscoveryTokenDelta: percentileInterval(netDelta),
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentileInterval(values: number[]): ConfidenceInterval {
  if (values.length === 0) return { low: null, high: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    low: sorted[Math.floor(0.025 * (sorted.length - 1))],
    high: sorted[Math.floor(0.975 * (sorted.length - 1))],
  };
}

function sumMatchedDiscoveryTokens(
  candidateFiles: string[],
  oracle: Oracle,
): number {
  let total = 0;
  const matched = new Set<string>();
  for (const oracleFile of oracle.files) {
    if (matched.has(oracleFile)) continue;
    if (
      candidateFiles.some((candidate) => pathMatches(candidate, oracleFile))
    ) {
      total += oracle.fileWeights[oracleFile] ?? 0;
      matched.add(oracleFile);
    }
  }
  return total;
}

function countMatches(
  candidates: string[],
  oracle: string[],
): { candidateHits: number; oracleHits: number } {
  const matchedCandidates = new Set<number>();
  const matchedOracle = new Set<number>();
  for (const [oracleIndex, value] of oracle.entries()) {
    for (const [candidateIndex, candidate] of candidates.entries()) {
      if (pathMatches(candidate, value)) {
        matchedCandidates.add(candidateIndex);
        matchedOracle.add(oracleIndex);
        break;
      }
    }
  }
  return {
    candidateHits: matchedCandidates.size,
    oracleHits: matchedOracle.size,
  };
}

export function pathMatches(candidate: string, value: string): boolean {
  const left = normalizePathForMatch(candidate);
  const right = normalizePathForMatch(value);
  if (!left || !right) return false;
  return (
    left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
  );
}

function normalizePathForMatch(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

export function netDiscoveryTokenSavingsRate(aggregate: Aggregate): number {
  if (aggregate.discoveryReadTokens <= 0) return 0;
  return (
    (aggregate.matchedDiscoveryTokens -
      aggregate.discoveryTreatmentContextTokens) /
    aggregate.discoveryReadTokens
  );
}

function printComparison(
  aggregateByArm: AggregateByArm,
  arms: readonly ArmName[],
): void {
  const reference = aggregateByArm.none;
  const armWidth = Math.max(9, ...arms.map((arm) => arm.length));
  console.log(`  sessions=${reference.scenarioCount}`);
  console.log(
    "  oracle_source: " +
      `pre_edit_discovery=${reference.oracleSourceCounts.pre_edit_discovery} ` +
      `expected_diffstat=${reference.oracleSourceCounts.expected_diffstat}`,
  );
  console.log(
    `  historical_discovery: ${Math.round(reference.discoveryReadTokens)}tok ` +
      `across ${reference.discoveryReads} read(s)`,
  );
  console.log("");
  console.log(
    `  ${"arm".padEnd(armWidth)} recall precision session_recall context matched cover net_save mean_delta roi hits/1k`,
  );
  for (const arm of arms) {
    const aggregate = aggregateByArm[arm];
    const sessionRecall =
      aggregate.oracleSessions > 0
        ? pct(aggregate.weightedSessionRecall)
        : "n/a";
    const matchedRate =
      aggregate.matchedDiscoveryTokenRate == null
        ? "n/a"
        : pct(aggregate.matchedDiscoveryTokenRate);
    const netDelta =
      aggregate.meanNetDiscoveryTokenDelta == null
        ? "n/a"
        : `${Math.round(aggregate.meanNetDiscoveryTokenDelta)}tok`;
    const roi =
      aggregate.contextRoi == null
        ? "n/a"
        : `${aggregate.contextRoi.toFixed(2)}x`;
    const netSave = pct(netDiscoveryTokenSavingsRate(aggregate));
    console.log(
      `  ${arm.padEnd(armWidth)} ` +
        `${pct(aggregate.weightedFileRecall).padEnd(6)} ` +
        `${pct(aggregate.weightedFilePrecision).padEnd(9)} ` +
        `${sessionRecall.padEnd(14)} ` +
        `${`${Math.round(aggregate.treatmentContextTokens)}tok`.padEnd(7)} ` +
        `${`${Math.round(aggregate.matchedDiscoveryTokens)}tok`.padEnd(8)} ` +
        `${matchedRate.padEnd(4)} ` +
        `${netSave.padEnd(8)} ` +
        `${netDelta.padEnd(9)} ` +
        `${roi.padEnd(5)} ` +
        `${aggregate.fileHitsPer1kContextTokens.toFixed(2)}`,
    );
  }

  console.log("");
  console.log(
    `  file_recall_ci: ${arms
      .filter((arm) => arm !== "none")
      .map(
        (arm) =>
          `${arm}=${ciText(aggregateByArm[arm].ci.weightedFileRecall, pct)}`,
      )
      .join(" ")}`,
  );
  console.log(
    `  matched_discovery_rate_ci: ${arms
      .filter((arm) => arm !== "none")
      .map(
        (arm) =>
          `${arm}=${ciText(
            aggregateByArm[arm].ci.matchedDiscoveryTokenRate,
            pct,
          )}`,
      )
      .join(" ")}`,
  );
}

interface HookCoverageSummary {
  arm: ArmName | null;
  features: Record<PanopFeatureName, number>;
  missing: PanopFeatureName[];
}

function summarizeHookCoverage(
  aggregateByArm: AggregateByArm,
  args: Args,
): HookCoverageSummary {
  const arm = hookCoverageArm(args);
  const features = Object.fromEntries(
    PANOP_FEATURE_NAMES.map((feature) => [
      feature,
      arm ? hookFeatureEventCount(aggregateByArm[arm], feature) : 0,
    ]),
  ) as Record<PanopFeatureName, number>;
  return {
    arm,
    features,
    missing: args.injectionFeatures.filter((feature) => features[feature] <= 0),
  };
}

function hookCoverageArm(args: Args): ArmName | null {
  if (args.arms.includes("panop")) return "panop";
  if (args.arms.includes("panop+optimized-crg")) return "panop+optimized-crg";
  return null;
}

function hookFeatureEventCount(
  aggregate: Aggregate,
  feature: PanopFeatureName,
): number {
  if (feature === "sessionstart") return aggregate.treatmentSessionStartEvents;
  if (feature === "userpromptsubmit") {
    return aggregate.treatmentUserPromptEvents;
  }
  return aggregate.treatmentPreToolUseEvents;
}

function printHookCoverage(aggregateByArm: AggregateByArm, args: Args): void {
  const coverage = summarizeHookCoverage(aggregateByArm, args);
  if (!coverage.arm) {
    console.log(
      "  hook_coverage: unavailable; include panop or panop+optimized-crg arm",
    );
    return;
  }
  console.log(
    `  hook_coverage(${coverage.arm}): ` +
      `sessionstart=${coverage.features.sessionstart} ` +
      `userpromptsubmit=${coverage.features.userpromptsubmit} ` +
      `pretooluse=${coverage.features.pretooluse}` +
      (coverage.missing.length > 0
        ? ` missing=${coverage.missing.join(",")}`
        : " all_selected_present"),
  );
}

function printCrgCandidateSummary(
  aggregateByArm: AggregateByArm,
  args: Args,
): void {
  const arms = args.arms.filter(
    (arm) => aggregateByArm[arm].treatmentCrgCandidateFiles > 0,
  );
  if (arms.length === 0) return;
  for (const arm of arms) {
    const aggregate = aggregateByArm[arm];
    console.log(
      `  crg_candidates(${arm}): ` +
        `files=${aggregate.treatmentCrgCandidateFiles} ` +
        `seed=${aggregate.treatmentCrgSeedCandidateFiles} ` +
        `related=${aggregate.treatmentCrgRelatedCandidateFiles} ` +
        `panop_near=${aggregate.treatmentCrgPanopNearCandidateFiles}`,
    );
  }
}

function assertRequiredHookCoverage(
  aggregateByArm: AggregateByArm,
  args: Args,
): void {
  if (!args.requireHookCoverage) return;
  const coverage = summarizeHookCoverage(aggregateByArm, args);
  if (!coverage.arm) {
    throw new Error(
      "--require-hook-coverage requires panop or panop+optimized-crg arm",
    );
  }
  if (coverage.missing.length > 0) {
    throw new Error(
      `Required hook coverage missing for ${coverage.missing.join(", ")}`,
    );
  }
}

interface HistoricalMarkdownInput {
  generatedAt: string;
  args: Args;
  aggregateByFeatureArm: AggregateByFeatureArm;
  measurements: ScenarioMeasurement[];
}

export function buildHistoricalMarkdownReport(
  input: HistoricalMarkdownInput,
): string {
  const headline =
    input.aggregateByFeatureArm[SELECTED_FEATURE_NAME] ??
    aggregateMeasurementsByArm([]);
  const reference = headline.none;
  const topMeasurements = [...input.measurements]
    .filter(
      (measurement) =>
        measurement.feature === SELECTED_FEATURE_NAME &&
        measurement.arm !== "none",
    )
    .sort(
      (a, b) =>
        b.fileHits - a.fileHits ||
        b.matchedDiscoveryTokens - a.matchedDiscoveryTokens ||
        b.oracleFiles - a.oracleFiles,
    )
    .slice(0, 12);
  const lines = [
    "# Panopticon Historical Context Proxy Report",
    "",
    `Generated: ${input.generatedAt}`,
    `Repository: ${input.args.repository ?? "all"}`,
    input.args.targets.length > 0
      ? `Targets: ${input.args.targets.join(", ")}`
      : "",
    input.args.fixtureFile ? `Fixture: ${input.args.fixtureFile}` : "",
    `Arms: ${input.args.arms.join(", ")}`,
    `Injection features: ${formatInjectionFeatures(input.args.injectionFeatures)}`,
    `Sample mode: ${input.args.sampleMode}`,
    "",
    "## Method",
    "",
    "- Deterministic proxy over historical sessions; no agent output is replayed.",
    "- Control is no injected local history and no CRG context.",
    "- Panop uses only the selected injection feature set for this run.",
    "- panop+optimized-crg adds compact CRG file candidates to the selected Panop context.",
    input.args.injectionFeatures.includes("pretooluse")
      ? "- PreToolUse(Read) remains diagnostic unless its fileOverview source is point-in-time for the evaluated scenario."
      : "",
    "- Raw PR replay fixtures are measured against the same relevant two-turn action window used by replay.",
    "",
    "## Oracle Summary",
    "",
    `Scenarios: ${reference.scenarioCount}`,
    `Oracle files: ${reference.oracleFiles}`,
    `Oracle source counts: pre_edit_discovery=${reference.oracleSourceCounts.pre_edit_discovery}, expected_diffstat=${reference.oracleSourceCounts.expected_diffstat}`,
    `Historical discovery reads: ${reference.discoveryReads} (${Math.round(reference.discoveryReadTokens)} tokens)`,
    "",
    "## Headline File Recall",
    "",
    "| Arm | Recall | 95% CI | Precision | Context | Hits | Hits / 1k ctx | Events |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...input.args.arms
      .map((arm) => {
        const aggregate = headline[arm];
        return [
          arm,
          pct(aggregate.weightedFileRecall),
          ciText(aggregate.ci.weightedFileRecall, pct).replace("95% CI ", ""),
          pct(aggregate.weightedFilePrecision),
          `${Math.round(aggregate.treatmentContextTokens)} tok`,
          `${aggregate.fileHits}/${aggregate.oracleFiles}`,
          aggregate.fileHitsPer1kContextTokens.toFixed(2),
          `SS:${aggregate.treatmentSessionStartEvents} UPS:${aggregate.treatmentUserPromptEvents} PTU:${aggregate.treatmentPreToolUseEvents}`,
        ].join(" | ");
      })
      .map((row) => `| ${row} |`),
    "",
    "## Discovery Token Proxy",
    "",
    reference.oracleSourceCounts.pre_edit_discovery === 0
      ? "Not reported for this sample: every oracle is expected_diffstat, so discovery-token savings and ROI are not defined."
      : discoveryProxyMarkdownTable(headline, input.args.arms),
    "",
    "## Hook Coverage",
    "",
    hookCoverageMarkdown(headline, input.args),
    "",
    "## CRG Candidate Sources",
    "",
    crgCandidateSourceMarkdown(headline, input.args),
    "",
    "## Top Measurements",
    "",
    "| Arm | Session | Files | Context | Oracle | Title |",
    "| --- | --- | ---: | ---: | --- | --- |",
    ...topMeasurements.map(
      (measurement) =>
        `| ${measurement.arm} | ${measurement.session_id.slice(0, 8)} | ` +
        `${measurement.fileHits}/${measurement.oracleFiles} | ` +
        `${measurement.treatmentContextTokens} tok | ` +
        `${measurement.oracleSource} | ${escapeMarkdownCell(
          compact(measurement.title ?? "", 90),
        )} |`,
    ),
    "",
  ].filter((line) => line.length > 0 || line === "");
  return `${lines.join("\n")}\n`;
}

function discoveryProxyMarkdownTable(
  aggregateByArm: AggregateByArm,
  arms: readonly ArmName[],
): string {
  return [
    "| Arm | Matched Read Tokens | Coverage | Net Savings | Mean Net Delta | ROI |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...arms.map((arm) => {
      const aggregate = aggregateByArm[arm];
      return (
        `| ${arm} | ${Math.round(aggregate.matchedDiscoveryTokens)} tok | ` +
        `${aggregate.matchedDiscoveryTokenRate == null ? "n/a" : pct(aggregate.matchedDiscoveryTokenRate)} | ` +
        `${pct(netDiscoveryTokenSavingsRate(aggregate))} | ` +
        `${aggregate.meanNetDiscoveryTokenDelta == null ? "n/a" : `${Math.round(aggregate.meanNetDiscoveryTokenDelta)} tok`} | ` +
        `${aggregate.contextRoi == null ? "n/a" : `${aggregate.contextRoi.toFixed(2)}x`} |`
      );
    }),
  ].join("\n");
}

function hookCoverageMarkdown(
  aggregateByArm: AggregateByArm,
  args: Args,
): string {
  const coverage = summarizeHookCoverage(aggregateByArm, args);
  if (!coverage.arm) {
    return "Not reported: include `panop` or `panop+optimized-crg` to count injected hook surfaces.";
  }
  return [
    `Coverage arm: \`${coverage.arm}\``,
    "",
    "| Feature | Events | Selected |",
    "| --- | ---: | --- |",
    ...PANOP_FEATURE_NAMES.map(
      (feature) =>
        `| ${feature} | ${coverage.features[feature]} | ${
          args.injectionFeatures.includes(feature) ? "yes" : "no"
        } |`,
    ),
    "",
    coverage.missing.length > 0
      ? `Missing selected features: ${coverage.missing.join(", ")}`
      : "All selected injection features had at least one event.",
  ].join("\n");
}

function crgCandidateSourceMarkdown(
  aggregateByArm: AggregateByArm,
  args: Args,
): string {
  const rows = args.arms.filter(
    (arm) => aggregateByArm[arm].treatmentCrgCandidateFiles > 0,
  );
  if (rows.length === 0) {
    return "No optimized CRG candidate files were added in this run.";
  }
  return [
    "| Arm | Candidate Files | Seed | Related | Panop-Near |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows.map((arm) => {
      const aggregate = aggregateByArm[arm];
      return (
        `| ${arm} | ${aggregate.treatmentCrgCandidateFiles} | ` +
        `${aggregate.treatmentCrgSeedCandidateFiles} | ` +
        `${aggregate.treatmentCrgRelatedCandidateFiles} | ` +
        `${aggregate.treatmentCrgPanopNearCandidateFiles} |`
      );
    }),
  ].join("\n");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function ciText(
  ci: ConfidenceInterval,
  format: (value: number) => string,
): string {
  return ci.low == null || ci.high == null
    ? "(95% CI n/a)"
    : `(95% CI ${format(ci.low)}..${format(ci.high)})`;
}

function parseInput(input: string | null): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizePathKey(
  filePath: string | null | undefined,
  cwd: string,
  repoRoot: string,
): string | null {
  if (!filePath) return null;
  let value = filePath
    .replace(/^['"]|['"]$/g, "")
    .replace(/:\d+(?::\d+)?$/g, "")
    .replace(/[:,]$/g, "");
  if (value.length === 0 || !looksLikeFile(value)) return null;
  if (!path.isAbsolute(value)) value = path.resolve(cwd, value);
  let rel = path.relative(repoRoot, value);
  if (rel.startsWith("..")) {
    const marker = "/panopticon/";
    const index = value.indexOf(marker);
    if (index >= 0) rel = value.slice(index + marker.length);
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(value);
  return path.normalize(rel).replaceAll("\\", "/");
}

function inferScenarioRepoRoot(cwd: string, fallbackRepoRoot: string): string {
  const cacheKey = `${cwd}\0${fallbackRepoRoot}`;
  const cached = inferredRepoRootCache.get(cacheKey);
  if (cached) return cached;

  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      inferredRepoRootCache.set(cacheKey, current);
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const fallback = fs.existsSync(path.resolve(cwd))
    ? path.resolve(cwd)
    : path.resolve(fallbackRepoRoot);
  inferredRepoRootCache.set(cacheKey, fallback);
  return fallback;
}

function looksLikeFile(value: string): boolean {
  if (value.length === 0 || value === "." || value === "..") return false;
  if (/[*?{}()|^$]/.test(value)) return false;
  return /\.(cjs|css|html|js|json|jsx|md|mjs|sql|sh|toml|ts|tsx|txt|yaml|yml)$/i.test(
    value,
  );
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function div(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}

function meanNonNull(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? null
    : sum(present, (value) => value) / present.length;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max
    ? `${normalized.slice(0, max - 3)}...`
    : normalized;
}

export function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    repository: DEFAULT_REPOSITORY,
    repoRoot: DEFAULT_REPO_ROOT,
    targets: [],
    limit: DEFAULT_LIMIT,
    minOracleFiles: 1,
    arms: [...DEFAULT_ARM_NAMES],
    injectionFeatures: [...DEFAULT_INJECTION_FEATURES],
    sampleMode: "recent",
    hookCoverageCandidateLimit: DEFAULT_HOOK_COVERAGE_CANDIDATE_LIMIT,
    requireHookCoverage: false,
    outputJson: null,
    reportMarkdown: null,
    sinceDays: null,
    fixtureFile: null,
    sessionId: null,
    includeAutomated: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repository") {
      parsed.repository = parseRepositoryFilter(readArgValue(argv, ++i, arg));
    } else if (arg === "--all-repositories") {
      parsed.repository = null;
    } else if (arg === "--repo-root") {
      parsed.repoRoot = readArgValue(argv, ++i, arg);
    } else if (arg === "--target" || arg === "--targets") {
      parsed.targets = parseTargetList(readArgValue(argv, ++i, arg));
    } else if (arg === "--limit") {
      parsed.limit = Number(readArgValue(argv, ++i, arg));
    } else if (arg === "--min-oracle-files") {
      parsed.minOracleFiles = Number(readArgValue(argv, ++i, arg));
    } else if (arg === "--arms") {
      parsed.arms = parseArmList(readArgValue(argv, ++i, arg));
    } else if (arg === "--include-original-crg") {
      parsed.arms = unique([...parsed.arms, "original-crg"]);
    } else if (arg === "--injection-features") {
      parsed.injectionFeatures = parseInjectionFeatureList(
        readArgValue(argv, ++i, arg),
      );
    } else if (arg === "--sample-mode") {
      parsed.sampleMode = parseSampleMode(readArgValue(argv, ++i, arg));
    } else if (arg === "--hook-coverage") {
      parsed.sampleMode = "hook-coverage";
    } else if (arg === "--hook-coverage-candidate-limit") {
      parsed.hookCoverageCandidateLimit = Number(readArgValue(argv, ++i, arg));
    } else if (arg === "--require-hook-coverage") {
      parsed.requireHookCoverage = true;
      parsed.sampleMode = "hook-coverage";
    } else if (arg === "--output-json") {
      parsed.outputJson = readArgValue(argv, ++i, arg);
    } else if (arg === "--report-markdown") {
      parsed.reportMarkdown = readArgValue(argv, ++i, arg);
    } else if (arg === "--since-days") {
      parsed.sinceDays = Number(readArgValue(argv, ++i, arg));
    } else if (arg === "--fixture-file") {
      parsed.fixtureFile = readArgValue(argv, ++i, arg);
    } else if (arg === "--session-id") {
      parsed.sessionId = readArgValue(argv, ++i, arg);
    } else if (arg === "--include-automated") {
      parsed.includeAutomated = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg !== "--") {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(parsed.limit) || parsed.limit <= 0) {
    throw new Error("--limit expects a positive integer");
  }
  if (!Number.isInteger(parsed.minOracleFiles) || parsed.minOracleFiles < 0) {
    throw new Error("--min-oracle-files expects a non-negative integer");
  }
  if (parsed.arms.length === 0) {
    throw new Error("--arms must include at least one arm");
  }
  if (parsed.injectionFeatures.length === 0) {
    throw new Error("--injection-features must include at least one feature");
  }
  if (
    !Number.isInteger(parsed.hookCoverageCandidateLimit) ||
    parsed.hookCoverageCandidateLimit <= 0
  ) {
    throw new Error(
      "--hook-coverage-candidate-limit expects a positive integer",
    );
  }
  if (
    parsed.sinceDays != null &&
    (!Number.isInteger(parsed.sinceDays) || parsed.sinceDays <= 0)
  ) {
    throw new Error("--since-days expects a positive integer");
  }
  return parsed;
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} expects a value`);
  return value;
}

function parseArmList(value: string): ArmName[] {
  const aliases: Record<string, ArmName> = {
    crg: "original-crg",
    "original-crg": "original-crg",
    none: "none",
    panop: "panop",
    "panop+crg": "panop+optimized-crg",
    "panop+optimized-crg": "panop+optimized-crg",
  };
  return unique(
    value.split(",").map((raw) => {
      const key = raw.trim().toLowerCase();
      const arm = aliases[key];
      if (!arm) {
        throw new Error(
          `Unknown arm: ${raw}. Expected one of ${ARM_NAMES.join(", ")}`,
        );
      }
      return arm;
    }),
  );
}

function parseRepositoryFilter(value: string): string | null {
  const normalized = value.trim();
  if (normalized.length === 0 || /^(all|any|none|null|\*)$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function parseTargetList(value: string): string[] {
  return unique(
    value
      .split(",")
      .map((target) => target.trim().toLowerCase())
      .filter((target) => target.length > 0),
  );
}

function parseInjectionFeatureList(value: string): PanopFeatureName[] {
  const aliases: Record<string, readonly PanopFeatureName[]> = {
    all: PANOP_FEATURE_NAMES,
    default: DEFAULT_INJECTION_FEATURES,
    reliable: RELIABLE_INJECTION_FEATURES,
    sessionstart: ["sessionstart"],
    "session-start": ["sessionstart"],
    userpromptsubmit: ["userpromptsubmit"],
    "user-prompt-submit": ["userpromptsubmit"],
    userprompt: ["userpromptsubmit"],
    pretooluse: ["pretooluse"],
    "pretooluse-read": ["pretooluse"],
    "pre-tool-use-read": ["pretooluse"],
  };
  return unique(
    value.split(/[,+]/).flatMap((raw) => {
      const key = raw.trim().toLowerCase();
      const features = aliases[key];
      if (!features) {
        throw new Error(
          `Unknown injection feature: ${raw}. Expected one of ${PANOP_FEATURE_NAMES.join(", ")}, reliable, default, or all`,
        );
      }
      return [...features];
    }),
  );
}

function parseSampleMode(value: string): SampleMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "hook_coverage") return "hook-coverage";
  if ((SAMPLE_MODES as readonly string[]).includes(normalized)) {
    return normalized as SampleMode;
  }
  throw new Error(
    `Unknown sample mode: ${value}. Expected one of ${SAMPLE_MODES.join(", ")}`,
  );
}

function formatInjectionFeatures(
  features: readonly PanopFeatureName[],
): string {
  return features.join("+");
}

function printHelp(): void {
  console.log(`Usage: pnpm exec tsup scripts/eval-panop-historical.ts --format esm --platform node --target node24 --out-dir .tmp/eval-build --silent --no-dts
node .tmp/eval-build/eval-panop-historical.js [options]

Compares selected deterministic context arms over the same historical scenarios:
  none       No Panopticon context and no CRG context
  panop      Panopticon context for the selected injection feature set
  panop+optimized-crg
             Selected Panopticon context plus optimized CRG file candidates
  original-crg
             Original code-review-graph get_minimal_context + semantic_search_nodes output

By default this runs one focused matrix:
  --arms none,panop,panop+optimized-crg
  --injection-features all

Options:
  --repository SLUG      Repository filter, or "all" for every repository
                         (default: ${DEFAULT_REPOSITORY})
  --all-repositories     Alias for --repository all
  --repo-root PATH       Fallback repo root for path normalization
  --targets LIST         Comma-separated target filter, e.g. codex,claude
  --limit N              Max historical sessions sampled (default: ${DEFAULT_LIMIT})
  --min-oracle-files N   Drop sessions with fewer oracle files (default: 1)
  --arms LIST            Comma-separated arms (default: ${DEFAULT_ARM_NAMES.join(",")})
  --include-original-crg Add original-crg to the selected arms
  --injection-features LIST
                         Comma-separated features or preset: all, reliable,
                         sessionstart, userpromptsubmit, pretooluse
  --sample-mode MODE      recent or hook-coverage (default: recent)
  --hook-coverage         Alias for --sample-mode hook-coverage
  --hook-coverage-candidate-limit N
                         Real session candidates scanned in hook-coverage mode
                         (default: ${DEFAULT_HOOK_COVERAGE_CANDIDATE_LIMIT})
  --require-hook-coverage Fail unless every selected injection feature emits at
                         least one event; implies --hook-coverage
  --since-days N         Only sessions started in the last N days
  --fixture-file PATH    Restrict to session_id values from a replay fixture
  --session-id ID        Restrict to one session id
  --include-automated    Include automated/replay sessions
  --output-json PATH     Write raw measurements and aggregate JSON
  --report-markdown PATH Write a markdown proxy report
  --help, -h             Show this help`);
}
