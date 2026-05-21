#!/usr/bin/env node

// Phase B: counterfactual session replay (ground-truth reduction A/B).
//
// For a historical session it reconstructs the repo at the commit the
// session started from (session_repositories.head_sha — the replay anchor
// added for exactly this), then replays the session's user prompts through
// a headless agent in isolated git worktrees:
//
//   none       — Panopticon injection disabled, no CRG prompt context
//   panop      — Panopticon SessionStart + UserPromptSubmit injection enabled
//   crg        — Panopticon injection disabled, compact CRG prompt context
//   panop+crg  — Panopticon SessionStart + UserPromptSubmit injection enabled,
//                compact CRG prompt context
//
// It captures wall-clock and token usage per arm, and an LLM judge decides
// whether each arm accomplished the same goal as the historical session
// (the outcome oracle — token/time deltas are meaningless without it).
// Aggregates reduction metrics only over completed, outcome-equivalent
// paired runs.
//
// COST: each scenario spawns one agent run per requested arm. This is a manual
// benchmark, NOT CI. Default is --dry-run: it selects the corpus,
// resolves anchors, creates/cleans worktrees, and prints the exact arm
// commands + judge plan WITHOUT spawning agents, so the mechanics are
// verifiable for free. Pass --execute to actually run.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  graphDbPath,
  openGraphDb,
} from "../src/code_intelligence/code-review-graph.js";
import { createCodeReviewGraphProvider } from "../src/code_intelligence/index.js";
import { closeDb, getDb } from "../src/db/schema.js";
import { invokeLlmAsync } from "../src/summary/llm.js";

const DEFAULT_LIMIT = 4;
const DEFAULT_REPO_ROOT = resolveDefaultRepoRoot();
const DEFAULT_REPOSITORY = resolveDefaultRepository(DEFAULT_REPO_ROOT);
const DEFAULT_FIXTURE_DIR = path.join(".tmp", "evals", "replay-counterfactual");
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
const CHARS_PER_TOKEN = 4;
const DEFAULT_ARMS: ArmName[] = ["none", "panop"];
const DEFAULT_MAX_PROMPTS = 3;
const RESULT_DIFF_PATCH_MAX_CHARS = 50_000;
const JUDGE_DIFF_PATCH_MAX_CHARS = 24_000;
const HISTORICAL_CONTEXT_PROMPT_MAX_CHARS = 900;

// Arm B keeps replay-safe Panopticon injection on. Arm A turns every
// injection surface off. PreToolUse file context is disabled for every arm
// at execution time because fileOverview is not point-in-time yet.
const INJECTION_OFF_ENV = {
  PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION: "0",
  PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION: "0",
  PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION: "0",
  PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION: "0",
};

const INJECTION_ON_ENV = {
  PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION: "1",
  PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION: "1",
  // No point-in-time path exists for fileOverview/read overview yet, so keep
  // PreToolUse context off in every replay arm. SessionStart/UserPromptSubmit
  // are the only Panopticon surfaces being tested here.
  PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION: "0",
  PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION: "0",
};

const STOPWORDS = new Set([
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

const ACTION_PROMPT_PATTERNS = [
  /\b(add|capture|change|clear|cover|fix|handle|implement|incorporate|preserve|refactor|remove|rename|replace|resolve|test|track|update|write)\b/i,
  /\blets?\s+(add|change|clear|cover|fix|handle|implement|incorporate|make|preserve|refactor|remove|rename|replace|resolve|test|track|update|write)\b/i,
  /\bneeds?\s+to\s+(add|change|clear|cover|fix|handle|implement|incorporate|preserve|refactor|remove|rename|replace|resolve|track|update|write)\b/i,
];

type ArmName = "none" | "panop" | "crg" | "panop+crg";
type Verdict = "accomplished" | "partial" | "failed" | "unknown";
type PromptWindowMode = "prefix" | "around-action" | "around-relevant-action";
type JudgeRunner = "claude" | "codex";

const ARM_CONFIGS: Record<
  ArmName,
  { panopticon: boolean; crgContext: boolean; label: string }
> = {
  none: {
    panopticon: false,
    crgContext: false,
    label: "no Panopticon injection, no CRG context",
  },
  panop: {
    panopticon: true,
    crgContext: false,
    label: "Panopticon SessionStart + UserPromptSubmit injection only",
  },
  crg: {
    panopticon: false,
    crgContext: true,
    label: "compact CRG context only",
  },
  "panop+crg": {
    panopticon: true,
    crgContext: true,
    label:
      "Panopticon SessionStart + UserPromptSubmit injection plus compact CRG context",
  },
};

interface Args {
  limit: number;
  repository: string;
  repoRoot: string;
  fixtureDir: string;
  fixtureFile: string | null;
  sessionId: string | null;
  prNumber: number | null;
  maxPrompts: number | null;
  windowMode: PromptWindowMode;
  actionContextPrompts: number;
  actionFollowupPrompts: number;
  preWindowContextPrompts: number;
  onlyMeasurable: boolean;
  resultJson: string | null;
  reportMarkdown: string | null;
  recomputeResultJson: string[];
  priorResultJson: string[];
  minCandidateLabel: CandidateAssessment["label"] | null;
  minCandidateScore: number | null;
  minRelevanceScore: number | null;
  maxExpectedFiles: number | null;
  skipPriorAttempted: boolean;
  skipPriorStrictReady: boolean;
  rejudge: boolean;
  execute: boolean;
  skipJudge: boolean;
  continueAfterFailure: boolean;
  judgeModel: string | null;
  judgeRunner: JudgeRunner;
  agentTimeoutMs: number;
  arms: ArmName[];
}

interface SelectionSummary {
  rawScenarioCount: number;
  nonMeasurableSkippedCount: number;
  candidateSkippedCount: number;
  candidateSkippedReasonCounts: Record<string, number>;
  duplicateWindowSkippedCount: number;
  candidatePassedCount: number;
  limit: number;
  limitedOutCount: number;
  selectedCount: number;
}

interface FixtureLoadSummary {
  source: string | null;
  rawRowCount: number;
  loadedScenarioCount: number;
  droppedRowCount: number;
  droppedReasonCounts: Record<string, number>;
}

interface FixtureLoadResult {
  scenarios: Scenario[];
  fixtureLoadSummary: FixtureLoadSummary | null;
}

interface Scenario {
  session_id: string;
  head_sha: string;
  // "exact": captured at SessionStart. "approx": derived from the recorded
  // branch's last commit at/before session start (head_sha capture is new,
  // so historical sessions have no exact anchor — state is approximate and
  // a session that started mid-dirty-tree is not perfectly reproducible).
  anchor: "exact" | "approx";
  started_at_ms: number;
  first_prompt: string;
  prompts: string[];
  original_prompt_count?: number;
  original_prompt_offset?: number;
  pre_window_prompts?: string[];
  pre_window_prompt_offset?: number;
  // Set when the scenario is anchored to a merged PR (the strong oracle):
  // the judge scores each arm's diff against the PR's actual change.
  pr_number?: number;
  merge_commit?: string;
  branch?: string;
  pr_title?: string;
  expected_diffstat?: string;
}

interface ScenarioWindowAssessment {
  userPromptInjectionOpportunities: number;
  likelyActionPromptTurn: number | null;
  measurable: boolean;
  warnings: string[];
}

interface CandidateAssessment {
  score: number;
  label: "strong" | "medium" | "weak";
  expectedFileCount: number | null;
  relevanceScore: number;
  reasons: string[];
  risks: string[];
}

interface PriorReplayOutcome {
  attempts: number;
  totalAttempts: number;
  incompatibleAttempts: number;
  strictReady: number;
  blockers: Record<string, number>;
  armExactFileSet: Partial<Record<ArmName, number>>;
  exactFileSetWins: Partial<Record<ArmName, number>>;
  sources: string[];
}

interface PromptWindowPrompt {
  turn: number;
  charCount: number;
  text: string;
}

interface PromptWindowTrace {
  mode: PromptWindowMode;
  promptStartTurn: number;
  promptEndTurn: number;
  promptCount: number;
  prompts: PromptWindowPrompt[];
  preWindowContext: {
    promptStartTurn: number | null;
    promptEndTurn: number | null;
    promptCount: number;
    prompts: PromptWindowPrompt[];
  };
}

interface HookDiagnostics {
  windowStartMs: number;
  windowEndMs: number;
  sessionIds: string[];
  eventCounts: Record<string, number>;
  sessionStartCount: number;
  userPromptSubmitCount: number;
  userPromptSubmitInjectionOpportunities: number;
  matchedUserPromptSubmitInjectionOpportunities: number;
  missingUserPromptSubmitReplayPrompts: string[];
  userPromptSubmitPrompts: string[];
  payloadOnlyMentionCount: number;
  payloadOnlyMentionSessionIds: string[];
}

interface TurnResult {
  turn: number;
  durationMs: number;
  totalTokens: number | null;
  exitOk: boolean;
  // The session id reported by this claude -p invocation, when the JSON output
  // includes one. Resumed headless turns can surface as a different session id
  // in hooks/scans, so keep this distinct from the id used for --resume.
  sessionId: string | null;
  resumeSessionId: string | null;
  promptPreview: string;
}

interface ArmResult {
  arm: ArmName;
  durationMs: number;
  totalTokens: number | null;
  exitOk: boolean;
  diffSummary: string;
  diffPatch: string;
  diffPatchTruncated: boolean;
  outcomeDiagnostics: OutcomeDiagnostics | null;
  hostRepoStatusChanged: boolean;
  hostRepoStatusBefore: string;
  hostRepoStatusAfter: string;
  crgContextTokens: number;
  turnsCompleted: number;
  promptCount: number;
  userPromptInjectionOpportunities: number;
  replaySessionIds: string[];
  hookDiagnostics: HookDiagnostics;
  turnResults: TurnResult[];
}

interface OutcomeDiagnostics {
  expectedFiles: string[];
  changedFiles: string[];
  matchedExpectedFiles: string[];
  unexpectedFiles: string[];
  fileRecall: number | null;
  exactFileSet: boolean;
}

interface ScenarioResult {
  session_id: string;
  pr_number?: number;
  promptCount: number;
  originalPromptCount: number;
  promptStartTurn: number;
  candidate: CandidateAssessment;
  priorOutcome: PriorReplayOutcome | null;
  promptWindow: PromptWindowTrace;
  window: ScenarioWindowAssessment;
  arms: Partial<Record<ArmName, ArmResult>>;
  verdicts: Partial<Record<ArmName, Verdict>>;
  judgeNotes: string;
}

interface ProcessGroupResult {
  stdout: string;
  stderr: string;
  exitOk: boolean;
  timedOut: boolean;
  errorMessage: string | null;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function gitOutput(args: string[], cwd = process.cwd()): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveDefaultRepoRoot(): string {
  return gitOutput(["rev-parse", "--show-toplevel"]) ?? process.cwd();
}

function resolveDefaultRepository(repoRoot: string): string {
  const remote = gitOutput(["remote", "get-url", "origin"], repoRoot);
  const slug = remote ? repositorySlugFromRemote(remote) : null;
  return slug ?? path.basename(repoRoot);
}

function repositorySlugFromRemote(remote: string): string | null {
  const normalized = remote.trim().replace(/\.git$/, "");
  const githubMatch = normalized.match(
    /(?:github\.com[:/])([^/\s]+\/[^/\s]+)$/,
  );
  return githubMatch?.[1] ?? null;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(entry).href : false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.recomputeResultJson.length > 0) {
    await recomputeResultJson(args);
    return;
  }
  const fixtureLoad = loadOrCreateFixture(args);
  let scenarios = fixtureLoad.scenarios;
  if (args.sessionId) {
    scenarios = scenarios.filter((s) => s.session_id === args.sessionId);
  }
  if (args.prNumber != null) {
    scenarios = scenarios.filter((s) => s.pr_number === args.prNumber);
  }
  const priorOutcomes = loadPriorReplayOutcomes(args);
  scenarios = scenarios
    .map((scenario) => applyPromptLimit(scenario, args))
    .filter((scenario) => scenario.prompts.length > 0);
  const rawScenarioCount = scenarios.length;
  const skipped = args.onlyMeasurable
    ? scenarios.filter((scenario) => !assessScenarioWindow(scenario).measurable)
    : [];
  if (args.onlyMeasurable) {
    scenarios = scenarios.filter(
      (scenario) => assessScenarioWindow(scenario).measurable,
    );
  }
  const candidateSkipped = scenarios.flatMap((scenario) => {
    const reasons = candidateFilterReasons(
      scenario,
      args,
      priorOutcomes.get(priorOutcomeKeyForScenario(scenario, args)) ?? null,
    );
    return reasons.length > 0 ? [{ scenario, reasons }] : [];
  });
  scenarios = scenarios.filter(
    (scenario) =>
      candidateFilterReasons(
        scenario,
        args,
        priorOutcomes.get(priorOutcomeKeyForScenario(scenario, args)) ?? null,
      ).length === 0,
  );
  const sortedScenarios = sortReplayCandidates(scenarios);
  scenarios = dedupeReplayCandidateWindows(sortedScenarios, args);
  const duplicateWindowSkippedCount = sortedScenarios.length - scenarios.length;
  const candidatePassedCount = scenarios.length;
  scenarios = scenarios.slice(0, args.limit);
  const selectionSummary: SelectionSummary = {
    rawScenarioCount,
    nonMeasurableSkippedCount: skipped.length,
    candidateSkippedCount: candidateSkipped.length,
    candidateSkippedReasonCounts: summarizeReasonCounts(
      candidateSkipped.map((item) => item.reasons),
    ),
    duplicateWindowSkippedCount,
    candidatePassedCount,
    limit: args.limit,
    limitedOutCount: Math.max(0, candidatePassedCount - scenarios.length),
    selectedCount: scenarios.length,
  };

  if (scenarios.length === 0) {
    if (candidateSkipped.length > 0 || skipped.length > 0) {
      console.log(
        "No replayable scenarios after filters. Relax candidate filters, " +
          "--only-measurable, or --limit; raw fixture rows were available.",
      );
    } else {
      console.log(
        "No replayable scenarios: need sessions with a captured " +
          "session_repositories.head_sha, user prompts, and edits. " +
          "(head_sha capture is recent — older sessions are excluded.)",
      );
    }
    writeResultJson([], args, selectionSummary, fixtureLoad.fixtureLoadSummary);
    return;
  }
  if (skipped.length > 0) {
    console.log(
      `Skipped ${skipped.length} non-measurable bounded window(s); ` +
        "use --max-prompts all or omit --only-measurable to inspect them.",
    );
  }
  if (candidateSkipped.length > 0) {
    console.log(
      `Skipped ${candidateSkipped.length} candidate(s) by filter: ` +
        formatCandidateSkipCounts(candidateSkipped.map((item) => item.reasons)),
    );
  }
  if (duplicateWindowSkippedCount > 0) {
    console.log(
      `Skipped ${duplicateWindowSkippedCount} lower-ranked duplicate ` +
        "replay window(s) before applying --limit.",
    );
  }

  console.log(
    `Phase B counterfactual: ${scenarios.length} scenario(s) ` +
      `[${args.execute ? "EXECUTE" : "DRY-RUN"}] ` +
      `arms=${args.arms.join(",")} ` +
      `prompts=${promptLimitLabel(args)} ` +
      `${candidateFilterLabel(args) ? `${candidateFilterLabel(args)} ` : ""}` +
      `${args.onlyMeasurable ? "only-measurable" : "include-all"}\n`,
  );

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    const window = assessScenarioWindow(s);
    const candidate = assessReplayCandidate(s);
    console.log(
      `=== ${s.session_id} @ ${s.head_sha.slice(0, 12)} ` +
        `[${s.anchor}${s.pr_number ? ` PR#${s.pr_number}` : ""}] ` +
        `(${s.prompts.length}/${s.original_prompt_count ?? s.prompts.length} prompt(s), ` +
        `starts_at_turn=${(s.original_prompt_offset ?? 0) + 1}, ` +
        `${window.userPromptInjectionOpportunities} UserPromptSubmit injection opportunity(s), ` +
        `action_turn=${window.likelyActionPromptTurn ?? "none"}) ===`,
    );
    console.log(`  goal: ${oneLine(s.first_prompt, 140)}`);
    console.log(
      `  candidate: ${candidate.label} score=${candidate.score}/100 ` +
        `expected_files=${candidate.expectedFileCount ?? "unknown"} ` +
        `relevance=${candidate.relevanceScore}`,
    );
    if (candidate.risks.length > 0) {
      console.log(`  candidate risks: ${candidate.risks.join("; ")}`);
    }
    const priorOutcome =
      priorOutcomes.get(priorOutcomeKeyForScenario(s, args)) ?? null;
    if (priorOutcome) {
      console.log(`  prior replay: ${formatPriorReplayOutcome(priorOutcome)}`);
    }
    const promptWindow = buildPromptWindowTrace(s, args);
    for (const prompt of promptWindow.prompts) {
      console.log(`  replay turn ${prompt.turn}: ${oneLine(prompt.text, 140)}`);
    }
    if (promptWindow.preWindowContext.promptCount > 0) {
      console.log(
        `  neutral pre-window turns ` +
          `${promptWindow.preWindowContext.promptStartTurn}-` +
          `${promptWindow.preWindowContext.promptEndTurn}: ` +
          `${promptWindow.preWindowContext.promptCount} prompt(s)`,
      );
    }
    for (const warning of window.warnings) {
      console.log(`  warning: ${warning}`);
    }
    results.push(await runScenario(s, args, priorOutcome));
  }

  report(results, args);
  writeResultJson(
    results,
    args,
    selectionSummary,
    fixtureLoad.fixtureLoadSummary,
  );
}

async function runScenario(
  s: Scenario,
  args: Args,
  priorOutcome: PriorReplayOutcome | null = null,
): Promise<ScenarioResult> {
  const window = assessScenarioWindow(s);
  const result: ScenarioResult = {
    session_id: s.session_id,
    pr_number: s.pr_number,
    promptCount: s.prompts.length,
    originalPromptCount: s.original_prompt_count ?? s.prompts.length,
    promptStartTurn: (s.original_prompt_offset ?? 0) + 1,
    candidate: assessReplayCandidate(s),
    priorOutcome,
    promptWindow: buildPromptWindowTrace(s, args),
    window,
    arms: {},
    verdicts: {},
    judgeNotes: "",
  };
  const crgContext = args.arms.some((arm) => ARM_CONFIGS[arm].crgContext)
    ? buildCrgSystemPrompt(s, args)
    : null;
  const scenarioReplaySessionIds = new Set<string>();

  for (const arm of orderedArms(args)) {
    const config = ARM_CONFIGS[arm];
    const env = config.panopticon ? INJECTION_ON_ENV : INJECTION_OFF_ENV;
    const appendSystemPrompt = config.crgContext ? crgContext : null;
    const worktree = path.join(
      os.tmpdir(),
      `pano-replay-${s.session_id.slice(0, 8)}-${arm}`,
    );
    if (!args.execute) {
      console.log(`  [dry-run] ${arm}: worktree ${worktree}`);
      console.log(`    ${config.label}`);
      console.log(
        `    env: ${Object.keys(env).length ? JSON.stringify(env) : "(panopticon defaults)"} ` +
          `+ replay-now=${s.started_at_ms - 1} ` +
          `exclude=${s.session_id} + prior/own replay session ids`,
      );
      if (appendSystemPrompt) {
        console.log(
          `    crg: ${Math.ceil(appendSystemPrompt.length / CHARS_PER_TOKEN)}tok ` +
            `${oneLine(appendSystemPrompt, 180)}`,
        );
      }
      if ((s.pre_window_prompts?.length ?? 0) > 0) {
        console.log(
          `    neutral history context: ${s.pre_window_prompts?.length ?? 0} prior prompt(s), ` +
            `turns ${(s.pre_window_prompt_offset ?? 0) + 1}-` +
            `${(s.pre_window_prompt_offset ?? 0) + (s.pre_window_prompts?.length ?? 0)}`,
        );
      }
      console.log(
        `    ${s.prompts.length} turns via claude -p (first) + --resume <session> (rest)`,
      );
      console.log(
        "    injection surface: SessionStart on turn 1; " +
          `${window.userPromptInjectionOpportunities} UserPromptSubmit opportunity(s) on turn 2+; ` +
          `likely mid-session action turn=${window.likelyActionPromptTurn ?? "none"}; ` +
          "PreToolUse file context disabled for point-in-time fairness",
      );
      continue;
    }

    result.arms[arm] = await executeArm(
      s,
      args,
      env,
      worktree,
      arm,
      appendSystemPrompt,
      [...scenarioReplaySessionIds],
    );
    for (const sessionId of result.arms[arm]?.replaySessionIds ?? []) {
      scenarioReplaySessionIds.add(sessionId);
    }
    for (const sessionId of result.arms[arm]?.hookDiagnostics.sessionIds ??
      []) {
      scenarioReplaySessionIds.add(sessionId);
    }
    if (
      args.execute &&
      !args.continueAfterFailure &&
      arm === baselineArm(args) &&
      !isCompleteInstrumentedArm(result.arms[arm])
    ) {
      result.judgeNotes = `stopped after baseline arm ${arm}: incomplete, missing token metrics, or missing required injection instrumentation`;
      break;
    }
  }

  const armResults = args.arms
    .map((arm) => result.arms[arm])
    .filter((arm): arm is ArmResult => arm != null);
  if (args.execute && !args.skipJudge && isJudgeable(result, args)) {
    const verdict = await judge(s, armResults, args);
    result.verdicts = verdict.verdicts;
    result.judgeNotes = verdict.notes;
  } else if (args.execute && args.skipJudge) {
    result.judgeNotes = "judge skipped by --skip-judge";
  } else if (
    args.execute &&
    args.arms.every((arm) => isCompleteInstrumentedArm(result.arms[arm])) &&
    !hasRequiredOutcomeEvidence(result, args)
  ) {
    result.judgeNotes =
      "judge skipped: one or more requested arms is missing PR scope diagnostics";
  } else if (args.execute && !result.judgeNotes) {
    result.judgeNotes =
      "judge skipped: one or more requested arms were incomplete, missing token metrics, or missing required injection instrumentation";
  }

  return result;
}

function orderedArms(args: Args): ArmName[] {
  const baseline = baselineArm(args);
  return unique([baseline, ...args.arms]);
}

function turnArgs(
  prompt: string,
  worktree: string,
  resumeId: string | null,
  appendSystemPrompt: string | null,
) {
  // Disposable, isolated worktree — bypassPermissions lets the replay agent
  // fully operate (edit + git + build + tests) exactly as the original
  // session could. acceptEdits silently blocks Bash in headless -p.
  const a = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    worktree,
  ];
  if (!resumeId && appendSystemPrompt) {
    a.push("--append-system-prompt", appendSystemPrompt);
  }
  if (resumeId) a.push("--resume", resumeId);
  return a;
}

export function buildReplayAppendSystemPrompt(
  worktree: string,
  repoRoot: string,
  armSystemPrompt: string | null,
  preWindowPrompts: string[] = [],
  preWindowPromptOffset = 0,
): string {
  const isolation = [
    "Replay isolation rules for this benchmark:",
    `- The disposable replay worktree is ${worktree}.`,
    "- Treat the current working directory as the only repository under test.",
    `- Do not edit, write, install into, tag, push from, or create PRs from ${repoRoot}.`,
    "- If a historical prompt mentions another local checkout or absolute path, do not mutate it; adapt the task to the disposable worktree.",
    "- Produce code changes in the disposable worktree only.",
    "- Make the smallest code change necessary for the current user prompt.",
    "- Do not perform release, tag, dependency, migration, cleanup, broad refactor, or admin work unless the current prompt explicitly asks for that exact work.",
  ].join("\n");
  const priorContext = formatPreWindowPromptContext(
    preWindowPrompts,
    preWindowPromptOffset,
  );
  return [isolation, priorContext, armSystemPrompt]
    .filter(Boolean)
    .join("\n\n");
}

function formatPreWindowPromptContext(
  prompts: string[],
  promptOffset: number,
): string | null {
  if (prompts.length === 0) return null;
  const lines = [
    "Historical prompts before this replay window (neutral context only):",
    "- These prompts happened earlier in the original session.",
    "- Use them only to understand references, constraints, and intended scope in the replayed prompts.",
    "- Do not execute tasks requested only in this history unless a replayed prompt explicitly asks you to continue or apply that work now.",
    ...prompts.map(
      (prompt, index) =>
        `Historical turn ${promptOffset + index + 1}: ${oneLine(
          prompt,
          HISTORICAL_CONTEXT_PROMPT_MAX_CHARS,
        )}`,
    ),
  ];
  return lines.join("\n");
}

function extractSessionId(stdout: string): string | null {
  try {
    const p = JSON.parse(stdout) as { session_id?: string; sessionId?: string };
    return p.session_id ?? p.sessionId ?? null;
  } catch {
    return null;
  }
}

async function executeArm(
  s: Scenario,
  args: Args,
  env: Record<string, string>,
  worktree: string,
  arm: ArmName,
  appendSystemPrompt: string | null,
  scenarioExcludeSessionIds: string[],
): Promise<ArmResult> {
  removeWorktree(args.repoRoot, worktree);
  addWorktree(args.repoRoot, worktree, s.head_sha);
  const hostRepoStatusBefore = gitStatusPorcelain(args.repoRoot);
  const hookWindowStartMs = Date.now();
  try {
    let resumeId: string | null = null;
    const replaySessionIds = new Set<string>();
    let totalTokens = 0;
    let anyTokens = false;
    let totalDuration = 0;
    let exitOk = true;
    let turnsOk = 0;
    const turnResults: TurnResult[] = [];
    for (let i = 0; i < s.prompts.length; i++) {
      // Per-turn env: clamp injection to strictly before the historical
      // session start, and exclude the historical + (once known) replay
      // session ids so treatment cannot leak the answer or its own work.
      const turnEnv: Record<string, string> = {
        ...env,
        PANOPTICON_REPLAY_NOW_MS: String(s.started_at_ms - 1),
        PANOPTICON_REPLAY_EXCLUDE_SESSION_IDS: buildReplayExcludeSessionIds(
          s.session_id,
          scenarioExcludeSessionIds,
          ...replaySessionIds,
        ).join(","),
      };
      const turnStart = Date.now();
      let turnOut = "";
      let turnExitOk = true;
      const agentRun = await execFileInProcessGroup(
        "claude",
        turnArgs(
          s.prompts[i],
          worktree,
          resumeId,
          i === 0
            ? buildReplayAppendSystemPrompt(
                worktree,
                args.repoRoot,
                appendSystemPrompt,
                s.pre_window_prompts ?? [],
                s.pre_window_prompt_offset ?? 0,
              )
            : null,
        ),
        {
          cwd: worktree,
          env: { ...process.env, ...turnEnv },
          timeoutMs: args.agentTimeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (agentRun.exitOk) {
        turnsOk++;
        turnOut = agentRun.stdout;
      } else {
        turnExitOk = false;
        exitOk = false;
        turnOut =
          agentRun.stdout ||
          agentRun.stderr ||
          agentRun.errorMessage ||
          (agentRun.timedOut
            ? `agent timed out after ${args.agentTimeoutMs}ms`
            : `agent exited with code=${agentRun.code} signal=${agentRun.signal}`);
      }
      totalDuration += Date.now() - turnStart;
      const t = extractTokens(turnOut);
      if (t != null) {
        totalTokens += t;
        anyTokens = true;
      }
      const reportedSessionId = extractSessionId(turnOut);
      if (reportedSessionId) {
        replaySessionIds.add(reportedSessionId);
      }
      if (!resumeId && reportedSessionId) {
        resumeId = reportedSessionId;
      }
      turnResults.push({
        turn: i + 1,
        durationMs: Date.now() - turnStart,
        totalTokens: t,
        exitOk: turnExitOk,
        sessionId: reportedSessionId,
        resumeSessionId: resumeId,
        promptPreview: oneLine(s.prompts[i], 120),
      });
      process.stderr.write(
        `    ${arm} turn ${i + 1}/${s.prompts.length}: ` +
          `${t ?? "?"}tok ${((Date.now() - turnStart) / 1000) | 0}s` +
          `${resumeId ? "" : " (no session id — cannot resume)"}\n`,
      );
      // If we never got a session id, can't continue the same conversation.
      if (!resumeId && i + 1 < s.prompts.length) {
        exitOk = false;
        break;
      }
      // A timed-out or failed turn already proves this arm did not complete.
      // Stop the arm here instead of spending the remaining timeout budget on
      // follow-up prompts against a broken replay conversation.
      if (!exitOk) break;
    }
    const diffSummary = execFileSync(
      "git",
      ["-C", worktree, "diff", "--stat", s.head_sha, "--"],
      { encoding: "utf-8" },
    ).trim();
    const diffPatch = truncateWithFlag(
      execFileSync("git", ["-C", worktree, "diff", s.head_sha, "--"], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      }).trim(),
      RESULT_DIFF_PATCH_MAX_CHARS,
    );
    const changedFiles = execFileSync(
      "git",
      ["-C", worktree, "diff", "--name-only", s.head_sha, "--"],
      { encoding: "utf-8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const hookWindowEndMs = Date.now();
    const hostRepoStatusAfter = gitStatusPorcelain(args.repoRoot);
    const hostRepoStatusChanged = hostRepoStatusAfter !== hostRepoStatusBefore;
    if (hostRepoStatusChanged) exitOk = false;
    const hookDiagnostics = withSqliteBusyRetry(
      `collect hook diagnostics for ${arm}`,
      () =>
        collectHookDiagnostics({
          worktree,
          worktreeAliases: worktreePathAliases(worktree),
          sessionIds: [...replaySessionIds],
          expectedPrompts: s.prompts,
          windowStartMs: hookWindowStartMs,
          windowEndMs: hookWindowEndMs,
        }),
    );
    withSqliteBusyRetry(`mark replay sessions automated for ${arm}`, () =>
      markReplaySessionsAutomated(hookDiagnostics.sessionIds),
    );
    console.log(
      `  ${arm}: ${exitOk ? "ok" : "PARTIAL"} ${totalDuration}ms ` +
        `tokens=${anyTokens ? totalTokens : "?"} ` +
        `(${turnsOk}/${s.prompts.length} turns) ` +
        `hooks=SessionStart:${hookDiagnostics.sessionStartCount} ` +
        `UserPromptSubmit:${hookDiagnostics.userPromptSubmitCount} ` +
        `UPS-injectable:${hookDiagnostics.userPromptSubmitInjectionOpportunities}` +
        (hostRepoStatusChanged ? " HOST_REPO_CHANGED" : ""),
    );
    return {
      arm,
      durationMs: totalDuration,
      totalTokens: anyTokens ? totalTokens : null,
      exitOk,
      diffSummary,
      diffPatch: diffPatch.value,
      diffPatchTruncated: diffPatch.truncated,
      outcomeDiagnostics: buildOutcomeDiagnostics(s, changedFiles),
      hostRepoStatusChanged,
      hostRepoStatusBefore,
      hostRepoStatusAfter,
      crgContextTokens: appendSystemPrompt
        ? Math.ceil(appendSystemPrompt.length / CHARS_PER_TOKEN)
        : 0,
      turnsCompleted: turnsOk,
      promptCount: s.prompts.length,
      userPromptInjectionOpportunities:
        assessScenarioWindow(s).userPromptInjectionOpportunities,
      replaySessionIds: [...replaySessionIds],
      hookDiagnostics,
      turnResults,
    };
  } finally {
    removeWorktree(args.repoRoot, worktree);
  }
}

async function execFileInProcessGroup(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBuffer: number;
  },
): Promise<ProcessGroupResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let errorMessage: string | null = null;
    let settled = false;
    let sigkillTimer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({
        stdout,
        stderr,
        exitOk: code === 0 && signal == null && !timedOut && !errorMessage,
        timedOut,
        errorMessage,
        code,
        signal,
      });
    };
    const terminateGroup = (signal: NodeJS.Signals) => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          process.kill(child.pid, signal);
        } catch {
          // Process may already have exited.
        }
      }
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateGroup("SIGTERM");
      sigkillTimer = setTimeout(() => terminateGroup("SIGKILL"), 2_000);
    }, options.timeoutMs);
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      const text = chunk.toString("utf-8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (outputBytes > options.maxBuffer && !errorMessage) {
        errorMessage = `agent output exceeded ${options.maxBuffer} bytes`;
        terminateGroup("SIGTERM");
        sigkillTimer = setTimeout(() => terminateGroup("SIGKILL"), 2_000);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (err) => {
      errorMessage = err.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export function withSqliteBusyRetry<T>(label: string, fn: () => T): T {
  const delaysMs = [250, 500, 1_000, 2_000, 4_000, 8_000, 12_000, 16_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt >= delaysMs.length) throw err;
      closeDb();
      const delayMs = delaysMs[attempt] ?? delaysMs.at(-1) ?? 1_000;
      process.stderr.write(
        `    ${label}: SQLite busy, retrying in ${delayMs}ms\n`,
      );
      sleepSync(delayMs);
    }
  }
}

export function isSqliteBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /\bdatabase is locked\b/i.test(message) ||
    /\bSQLITE_BUSY\b/i.test(message) ||
    /\bSQLITE_LOCKED\b/i.test(message)
  );
}

function sleepSync(delayMs: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, delayMs);
}

function markReplaySessionsAutomated(sessionIds: string[]): void {
  const ids = unique(sessionIds).filter((id) => id.length > 0);
  if (ids.length === 0) return;
  const db = getDb();
  db.prepare(
    `UPDATE sessions
     SET is_automated = 1,
         sync_dirty = 1,
         sync_seq = COALESCE(sync_seq, 0) + 1
     WHERE session_id IN (${ids.map(() => "?").join(", ")})
       AND COALESCE(is_automated, 0) != 1`,
  ).run(...ids);
}

function collectHookDiagnostics(opts: {
  worktree: string;
  worktreeAliases?: string[];
  sessionIds: string[];
  expectedPrompts?: string[];
  windowStartMs: number;
  windowEndMs: number;
}): HookDiagnostics {
  const db = getDb();
  const uniqueSessionIds = unique(opts.sessionIds);
  const worktreeAliases = unique([
    opts.worktree,
    ...(opts.worktreeAliases ?? []),
  ]);
  const sessionClause =
    uniqueSessionIds.length > 0
      ? `h.session_id IN (${uniqueSessionIds.map(() => "?").join(", ")})`
      : "0";
  const cwdClause = `h.cwd IN (${worktreeAliases.map(() => "?").join(", ")})`;
  const filePathClause = worktreeAliases
    .map(() => "h.file_path LIKE ? ESCAPE '\\'")
    .join(" OR ");
  const payloadClause = worktreeAliases
    .map(() => "decompress(h.payload) LIKE ? ESCAPE '\\'")
    .join(" OR ");
  const likePatterns = worktreeAliases.map(buildLikePattern);
  const rows = db
    .prepare(
      `SELECT h.session_id,
              h.event_type,
              h.user_prompt,
              h.cwd
       FROM hook_events h
       WHERE h.timestamp_ms BETWEEN ? AND ?
         AND (
           ${sessionClause}
           OR ${cwdClause}
           OR ${filePathClause}
         )
       ORDER BY h.timestamp_ms ASC, h.id ASC`,
    )
    .all(
      opts.windowStartMs,
      opts.windowEndMs,
      ...uniqueSessionIds,
      ...worktreeAliases,
      ...likePatterns,
    ) as Array<{
    session_id: string;
    event_type: string;
    user_prompt: string | null;
    cwd: string | null;
  }>;

  const payloadMentionRows = db
    .prepare(
      `SELECT h.session_id
       FROM hook_events h
       WHERE h.timestamp_ms BETWEEN ? AND ?
         AND h.session_id NOT IN (${rows.length > 0 ? rows.map(() => "?").join(", ") : "''"})
         AND (${payloadClause})`,
    )
    .all(
      opts.windowStartMs,
      opts.windowEndMs,
      ...rows.map((row) => row.session_id),
      ...likePatterns,
    ) as Array<{ session_id: string }>;

  const eventCounts: Record<string, number> = {};
  const userPromptCountsBySession = new Map<string, number>();
  const sessionIds = new Set<string>(uniqueSessionIds);
  const userPromptSubmitRawPrompts: string[] = [];
  const prompts: string[] = [];
  for (const row of rows) {
    sessionIds.add(row.session_id);
    eventCounts[row.event_type] = (eventCounts[row.event_type] ?? 0) + 1;
    if (row.event_type === "UserPromptSubmit") {
      userPromptCountsBySession.set(
        row.session_id,
        (userPromptCountsBySession.get(row.session_id) ?? 0) + 1,
      );
      if (row.user_prompt) {
        userPromptSubmitRawPrompts.push(row.user_prompt);
        prompts.push(oneLine(row.user_prompt, 160));
      }
    }
  }
  const userPromptSubmitInjectionOpportunities = [
    ...userPromptCountsBySession.values(),
  ].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const replayPromptMatches = matchReplayPromptSubmits(
    opts.expectedPrompts ?? [],
    userPromptSubmitRawPrompts,
  );
  const payloadOnlyMentionSessionIds = unique(
    payloadMentionRows.map((row) => row.session_id),
  );
  return {
    windowStartMs: opts.windowStartMs,
    windowEndMs: opts.windowEndMs,
    sessionIds: [...sessionIds],
    eventCounts,
    sessionStartCount: eventCounts.SessionStart ?? 0,
    userPromptSubmitCount: eventCounts.UserPromptSubmit ?? 0,
    userPromptSubmitInjectionOpportunities,
    matchedUserPromptSubmitInjectionOpportunities:
      replayPromptMatches.matchedInjectionOpportunities,
    missingUserPromptSubmitReplayPrompts: replayPromptMatches.missingPrompts,
    userPromptSubmitPrompts: prompts,
    payloadOnlyMentionCount: payloadMentionRows.length,
    payloadOnlyMentionSessionIds,
  };
}

function matchReplayPromptSubmits(
  expectedPrompts: string[],
  observedUserPromptSubmits: string[],
): { matchedInjectionOpportunities: number; missingPrompts: string[] } {
  const available = new Map<string, number>();
  for (const prompt of observedUserPromptSubmits) {
    const key = normalizePromptForMatch(prompt);
    if (!key) continue;
    available.set(key, (available.get(key) ?? 0) + 1);
  }

  // Turn 1 emits UserPromptSubmit but production deliberately does not inject
  // there. Consume it first so duplicate first/second prompts cannot fake a
  // matched mid-session injection opportunity.
  consumePromptMatch(available, expectedPrompts[0]);

  let matchedInjectionOpportunities = 0;
  const missingPrompts: string[] = [];
  for (const prompt of expectedPrompts.slice(1)) {
    if (consumePromptMatch(available, prompt)) {
      matchedInjectionOpportunities += 1;
    } else {
      missingPrompts.push(oneLine(prompt, 120));
    }
  }
  return { matchedInjectionOpportunities, missingPrompts };
}

function consumePromptMatch(
  available: Map<string, number>,
  prompt: string | undefined,
): boolean {
  const key = normalizePromptForMatch(prompt ?? "");
  if (!key) return false;
  const count = available.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) {
    available.delete(key);
  } else {
    available.set(key, count - 1);
  }
  return true;
}

function normalizePromptForMatch(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function buildOutcomeDiagnostics(
  s: Scenario,
  changedFiles: string[],
): OutcomeDiagnostics | null {
  if (!s.expected_diffstat) return null;
  const expectedFiles = parseDiffstatFiles(s.expected_diffstat);
  if (expectedFiles.length === 0) return null;
  const changed = unique(changedFiles).sort();
  const matchedExpectedFiles = expectedFiles
    .filter((expected) =>
      changed.some((changedFile) => changedFile === expected),
    )
    .sort();
  const unexpectedFiles = changed
    .filter((changedFile) => !expectedFiles.includes(changedFile))
    .sort();
  return {
    expectedFiles,
    changedFiles: changed,
    matchedExpectedFiles,
    unexpectedFiles,
    fileRecall: matchedExpectedFiles.length / expectedFiles.length,
    exactFileSet:
      matchedExpectedFiles.length === expectedFiles.length &&
      unexpectedFiles.length === 0,
  };
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

function worktreePathAliases(worktree: string): string[] {
  const aliases = [worktree];
  try {
    aliases.push(fs.realpathSync(worktree));
  } catch {
    // Worktree may already have been removed in failure paths.
  }
  return unique(aliases);
}

function buildLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function addWorktree(
  repoRoot: string,
  worktree: string,
  headSha: string,
): void {
  try {
    execFileSync(
      "git",
      ["-C", repoRoot, "worktree", "add", "--detach", worktree, headSha],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    const stderr = childOutput((err as { stderr?: unknown }).stderr).trim();
    const stdout = childOutput((err as { stdout?: unknown }).stdout).trim();
    const detail = [stderr, stdout]
      .filter((value) => value.length > 0)
      .join("\n");
    throw new Error(
      `Failed to create replay worktree at ${worktree} for ${headSha}.` +
        (detail ? `\n${detail}` : ""),
    );
  }
}

function childOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return typeof value === "string" ? value : "";
}

function gitStatusPorcelain(repoRoot: string): string {
  try {
    return execFileSync("git", ["-C", repoRoot, "status", "--porcelain=v1"], {
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    return `status-error:${err instanceof Error ? err.message : String(err)}`;
  }
}

function readGitShowPatch(
  repoRoot: string,
  commit: string,
): { value: string; truncated: boolean } | null {
  try {
    return truncateWithFlag(
      execFileSync(
        "git",
        ["-C", repoRoot, "show", "--format=", "--find-renames", commit, "--"],
        {
          encoding: "utf-8",
          maxBuffer: 64 * 1024 * 1024,
        },
      ).trim(),
      JUDGE_DIFF_PATCH_MAX_CHARS,
    );
  } catch {
    return null;
  }
}

function truncateWithFlag(
  value: string,
  maxChars: number,
): { value: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  return {
    value: value.slice(0, Math.max(0, maxChars - 32)).trimEnd(),
    truncated: true,
  };
}

function removeWorktree(repoRoot: string, worktree: string): void {
  try {
    execFileSync(
      "git",
      ["-C", repoRoot, "worktree", "remove", "--force", worktree],
      { stdio: "ignore" },
    );
  } catch {
    // not registered — best effort
  }
  fs.rmSync(worktree, { recursive: true, force: true });
}

function extractTokens(stdout: string): number | null {
  // `claude --output-format json` emits a usage object; sum input+output.
  try {
    const parsed = JSON.parse(stdout) as {
      usage?: { input_tokens?: number; output_tokens?: number };
      total_tokens?: number;
    };
    if (typeof parsed.total_tokens === "number") return parsed.total_tokens;
    const u = parsed.usage;
    if (u) return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  } catch {
    // non-JSON (timeout/error output) — unknown
  }
  return null;
}

interface CrgCandidate {
  file: string;
  score: number;
  sources: string[];
}

function buildCrgSystemPrompt(s: Scenario, args: Args): string | null {
  const candidates = buildCrgCandidates(s.first_prompt, args.repoRoot).slice(
    0,
    12,
  );
  if (candidates.length === 0) return null;
  return [
    "Code-review-graph compact context for this replay.",
    "These are static graph leads, not instructions. Verify the current code before editing.",
    "Candidate files:",
    ...candidates.map(
      (candidate) => `- ${candidate.file} (${candidate.sources.join("+")})`,
    ),
  ].join("\n");
}

function buildCrgCandidates(prompt: string, repoRoot: string): CrgCandidate[] {
  const seeds = searchCrgSeedFiles(prompt, repoRoot).slice(0, 5);
  const provider = createCodeReviewGraphProvider();
  const candidates = new Map<string, CrgCandidate>();

  for (const seed of seeds) {
    addCrgCandidate(candidates, seed, 100, "seed");
    const overview = provider.fileOverview({
      repoRoot,
      filePath: seed,
    });
    for (const [index, relatedFile] of (
      overview.related_files ?? []
    ).entries()) {
      const key = normalizePathKey(relatedFile, repoRoot);
      if (key) addCrgCandidate(candidates, key, 1000 - index, "related");
    }
  }

  return [...candidates.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.sources.length - a.sources.length ||
      a.file.localeCompare(b.file),
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

function searchCrgSeedFiles(prompt: string, repoRoot: string): string[] {
  const terms = tokenize(prompt);
  if (terms.length === 0) return [];
  const graphDb = graphDbPath(repoRoot);
  if (!fs.existsSync(graphDb)) return [];
  let db: ReturnType<typeof openGraphDb>;
  try {
    db = openGraphDb(graphDb);
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT name, qualified_name, kind, file_path
         FROM nodes
         WHERE kind IN ('File', 'Class', 'Function', 'Test')`,
      )
      .all() as Array<{
      name: string;
      qualified_name: string;
      kind: string;
      file_path: string;
    }>;
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
    return unique(
      scored
        .map((item) => normalizePathKey(item.row.file_path, repoRoot))
        .filter((value): value is string => value !== null),
    ).slice(0, 5);
  } finally {
    db.close();
  }
}

function normalizePathKey(
  filePath: string | null | undefined,
  repoRoot: string,
): string | null {
  if (!filePath) return null;
  let value = filePath
    .replace(/^['"]|['"]$/g, "")
    .replace(/:\d+(?::\d+)?$/g, "")
    .replace(/[:,]$/g, "");
  if (value.length === 0 || !looksLikeFile(value)) return null;
  if (!path.isAbsolute(value)) value = path.resolve(repoRoot, value);
  const rel = path.relative(repoRoot, value);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(value);
  return path.normalize(rel).replaceAll("\\", "/");
}

function looksLikeFile(value: string): boolean {
  if (value.length === 0 || value === "." || value === "..") return false;
  if (/[*?{}()|^$]/.test(value)) return false;
  return /\.(cjs|css|html|js|json|jsx|md|mjs|sql|sh|toml|ts|tsx|txt|yaml|yml)$/i.test(
    value,
  );
}

function tokenize(prompt: string): string[] {
  const terms = prompt.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  return unique(
    terms
      .map((term) => term.replace(/^-+|-+$/g, ""))
      .filter((term) => term.length >= 3 && !STOPWORDS.has(term)),
  ).slice(0, 12);
}

async function judge(
  s: Scenario,
  arms: ArmResult[],
  args: Args,
): Promise<{
  verdicts: Partial<Record<ArmName, Verdict>>;
  notes: string;
}> {
  // PR-anchored scenarios have a ground-truth outcome (the merged diff);
  // judge each arm against THAT. Otherwise fall back to goal-equivalence
  // against the historical prompts.
  const expectedPatch =
    s.merge_commit != null
      ? readGitShowPatch(args.repoRoot, s.merge_commit)
      : null;
  const oracle = s.expected_diffstat
    ? `Ground truth — the change the historical session actually merged as PR #${s.pr_number} ("${s.pr_title}"). Resulting git diff --stat of the real merged PR:
${s.expected_diffstat}

Ground-truth patch excerpt:
${expectedPatch?.value || "(not available)"}
${expectedPatch?.truncated ? "\n[ground-truth patch truncated]" : ""}`
    : `Historical goal (first user prompt):
${s.first_prompt}

All historical user prompts:
${s.prompts.map((p, i) => `(${i + 1}) ${p}`).join("\n")}`;

  const prompt = buildJudgePrompt(oracle, arms);

  const raw = await invokeLlmAsync(prompt, {
    runner: args.judgeRunner,
    model: args.judgeModel,
    timeoutMs: 120_000,
  });
  if (!raw) {
    return {
      verdicts: Object.fromEntries(
        arms.map((arm) => [arm.arm, "unknown"]),
      ) as Partial<Record<ArmName, Verdict>>,
      notes: `judge invocation failed via ${args.judgeRunner}`,
    };
  }
  try {
    const fence = raw?.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(fence ? fence[0] : raw) as Record<
      string,
      unknown
    >;
    const verdicts: Partial<Record<ArmName, Verdict>> = {};
    for (const arm of arms) {
      verdicts[arm.arm] = normalizeVerdict(parsed[arm.arm]);
    }
    return {
      verdicts,
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };
  } catch {
    return {
      verdicts: Object.fromEntries(
        arms.map((arm) => [arm.arm, "unknown"]),
      ) as Partial<Record<ArmName, Verdict>>,
      notes: "judge parse failed",
    };
  }
}

export function buildJudgePrompt(oracle: string, arms: ArmResult[]): string {
  return `You are judging whether automated attempts accomplished the same user-visible work as a historical coding session.

${oracle}

${arms
  .map((arm) => {
    const patch = truncateWithFlag(arm.diffPatch, JUDGE_DIFF_PATCH_MAX_CHARS);
    return (
      `Attempt ${arm.arm} status: ${arm.exitOk ? "completed" : "incomplete"} ` +
      `(${arm.turnsCompleted}/${arm.promptCount} replay turns)\n` +
      `Attempt ${arm.arm} changed PR oracle files: ${formatOutcomeSummary(arm)}\n` +
      `Attempt ${arm.arm} resulting git diff --stat:\n${arm.diffSummary || "(no changes)"}\n` +
      `Attempt ${arm.arm} patch excerpt:\n${patch.value || "(no changes)"}\n` +
      `${patch.truncated || arm.diffPatchTruncated ? "[attempt patch truncated]" : ""}`
    );
  })
  .join("\n\n")}

Verdict rubric:
- accomplished: the attempt plausibly implements the same externally relevant behavior/change, even if code organization, constant placement, names, formatting, or exact patch shape differ from the merged PR.
- partial: the attempt addresses the right area but leaves a material part of the intended behavior incomplete, unimplemented, or likely broken.
- failed: the attempt is missing the intended behavior, changes the wrong area, or does not complete.

Do not mark an attempt partial solely because it is not a literal patch match. If the notes would say an attempt "accomplishes the goal" with only stylistic or placement differences, its verdict should be accomplished.

Respond as strict JSON using exactly these attempt keys:
${JSON.stringify({
  ...Object.fromEntries(
    arms.map((arm) => [arm.arm, "accomplished|partial|failed"]),
  ),
  notes: "one sentence",
})}`;
}

function normalizeVerdict(value: unknown): Verdict {
  return value === "accomplished" || value === "partial" || value === "failed"
    ? value
    : "unknown";
}

function report(results: ScenarioResult[], args: Args): void {
  console.log("");
  if (!args.execute) {
    console.log(
      `DRY-RUN complete: ${results.length} scenario(s) planned. ` +
        "Pass --execute to run the replay agents (expensive).",
    );
    return;
  }
  const aggregate = computeAggregate(results, args);
  console.log(
    `Phase B: ${results.length} scenarios, ${aggregate.completedCount} ` +
      "completed with token metrics, " +
      `${aggregate.instrumentedCount} had required injection instrumentation, ` +
      `${aggregate.prFileCoveredCount} covered all expected PR files, ` +
      `${aggregate.prExactFileSetCount} touched exactly the expected PR file set, ` +
      `${aggregate.comparableCount} outcome-comparable`,
  );
  console.log(
    `  baseline=${aggregate.baselineArm}; reliable reduction metrics require ` +
      "all requested arms to complete, emit tokens, expose the expected injection surface, match the exact PR file set, and be judged accomplished.",
  );
  console.log(
    `  reduction readiness: ` +
      `${aggregate.metricReadiness.reductionReady ? "ready" : "not ready"} ` +
      `${aggregate.metricReadiness.pairedReductionCount}/` +
      `${aggregate.metricReadiness.gates.totalScenarios} strict pair(s) ready ` +
      `(recommended minimum ${aggregate.metricReadiness.recommendedMinimumPairs}; ` +
      `sample-size ${aggregate.metricReadiness.meetsRecommendedSampleSize ? "ok" : "low"})`,
  );
  console.log(
    `  scope readiness: ` +
      `${aggregate.scopeMetricReadiness.scopeReady ? "ready" : "not ready"} ` +
      `${aggregate.scopeMetricReadiness.pairedScopeCount}/` +
      `${aggregate.scopeMetricReadiness.gates.totalScenarios} paired scope sample(s) ready ` +
      `(recommended minimum ${aggregate.scopeMetricReadiness.recommendedMinimumPairs}; ` +
      `sample-size ${aggregate.scopeMetricReadiness.meetsRecommendedSampleSize ? "ok" : "low"})`,
  );
  const blockerSummary = formatBlockerCounts(
    aggregate.metricReadiness.blockerCounts,
  );
  if (blockerSummary) {
    console.log(`  reduction blockers: ${blockerSummary}`);
  }
  const scopeBlockerSummary = formatBlockerCounts(
    aggregate.scopeMetricReadiness.blockerCounts,
  );
  if (scopeBlockerSummary) {
    console.log(`  scope blockers: ${scopeBlockerSummary}`);
  }
  if (aggregate.comparableCount === 0) {
    console.log(
      "  reliable aggregate: n/a (no completed, outcome-equivalent pair)",
    );
  } else {
    for (const arm of aggregate.armDeltas) {
      console.log(
        `  ${arm.arm} vs ${aggregate.baselineArm}: n=${arm.pairedCount} ` +
          `tokens mean ${formatPct(arm.meanTokenDeltaPct)} ` +
          `median ${formatPct(arm.medianTokenDeltaPct)}; ` +
          `time mean ${formatPct(arm.meanDurationDeltaPct)} ` +
          `median ${formatPct(arm.medianDurationDeltaPct)}`,
      );
    }
  }
  console.log("  PR scope quality by arm:");
  for (const arm of aggregate.armScopeMetrics) {
    console.log(
      `    ${arm.arm}: eligible=${arm.prScopeEligibleCount} ` +
        `covered=${arm.prFileCoveredCount} exact=${arm.prExactFileSetCount} ` +
        `rate=${formatRate(arm.exactFileSetRate)} ` +
        `ci95=${formatRateInterval(arm.exactFileSetRateWilson95)} ` +
        `exact_tokens mean=${formatTokens(arm.meanExactTokens)} ` +
        `median=${formatTokens(arm.medianExactTokens)} ` +
        `tokens_per_exact=${formatTokens(arm.tokensPerExactFileSet)} ` +
        `exact_time mean=${formatDurationMs(arm.meanExactDurationMs)} ` +
        `time_per_exact=${formatDurationMs(arm.durationMsPerExactFileSet)} ` +
        `unexpected mean=${formatNumber(arm.meanUnexpectedFileCount)} ` +
        `median=${formatNumber(arm.medianUnexpectedFileCount)}`,
    );
  }
  for (const delta of aggregate.scopeDeltas) {
    console.log(
      `    ${delta.arm} vs ${aggregate.baselineArm}: n=${delta.pairedCount} ` +
        `covered rate ${formatRate(delta.armPrFileCoveredRate)} vs ` +
        `${formatRate(delta.baselinePrFileCoveredRate)} ` +
        `(${formatRateDeltaPp(delta.prFileCoveredRateDelta)}) ` +
        `covered wins/ties/losses=${delta.prFileCoveredWins}/` +
        `${delta.prFileCoveredTies}/${delta.prFileCoveredLosses} ` +
        `exact rate ${formatRate(delta.armExactFileSetRate)} vs ` +
        `${formatRate(delta.baselineExactFileSetRate)} ` +
        `(${formatRateDeltaPp(delta.exactFileSetRateDelta)}) ` +
        `win_ci95=${formatRateInterval(delta.exactFileSetWinRateWilson95)} ` +
        `exact wins/ties/losses=${delta.exactFileSetWins}/` +
        `${delta.exactFileSetTies}/${delta.exactFileSetLosses} ` +
        `unexpected Δ mean=${formatNumber(delta.meanUnexpectedFilesDelta)} ` +
        `median=${formatNumber(delta.medianUnexpectedFilesDelta)} ` +
        `recall Δ mean=${formatNumber(delta.meanFileRecallDelta)} ` +
        `median=${formatNumber(delta.medianFileRecallDelta)}`,
    );
  }
  const blockedScenarios = aggregate.metricReadiness.scenarios.filter(
    (scenario) => scenario.status === "blocked",
  );
  if (blockedScenarios.length > 0) {
    console.log("  blocked reduction pairs:");
    for (const scenario of blockedScenarios) {
      console.log(
        `    ${scenario.session_id}${scenario.pr_number ? ` PR#${scenario.pr_number}` : ""} ` +
          `turn ${scenario.promptStartTurn}: ${scenario.blockers.join(", ")}`,
      );
    }
  }
  // Per-scenario detail for EVERY scenario — verdict + numbers + why,
  // so a non-comparable result is interpretable (judge said no vs judge
  // failed) instead of silent.
  for (const r of results) {
    const baseline = r.arms[aggregate.baselineArm] ?? null;
    const tok = (a: ArmResult | null) => a?.totalTokens ?? "?";
    const min = (a: ArmResult | null) =>
      a ? `${(a.durationMs / 60000).toFixed(1)}m` : "—";
    const lines = [
      `\n  ${r.session_id}${r.pr_number ? ` PR#${r.pr_number}` : ""} ` +
        `prompts=${r.promptCount}/${r.originalPromptCount} ` +
        `start_turn=${r.promptStartTurn} ` +
        `ups_opportunities=${r.window.userPromptInjectionOpportunities} ` +
        `action_turn=${r.window.likelyActionPromptTurn ?? "none"} ` +
        `measurable=${r.window.measurable}`,
    ];
    for (const arm of args.arms) {
      const a = r.arms[arm] ?? null;
      const tokenDelta =
        baseline?.totalTokens != null && a?.totalTokens != null
          ? `${(((a.totalTokens - baseline.totalTokens) / baseline.totalTokens) * 100).toFixed(0)}%`
          : "n/a";
      lines.push(
        `    ${arm.padEnd(10)} ${tok(a)} tok / ${min(a)} ` +
          `turns=${a ? `${a.turnsCompleted}/${a.promptCount}` : "—"} ` +
          `exit=${a?.exitOk ?? null} judge=${r.verdicts[arm] ?? "unknown"} ` +
          `Δtokens=${tokenDelta} ` +
          `crg_ctx=${a?.crgContextTokens ?? 0}tok ` +
          `hooks=${formatHookSummary(a, r.window)} ` +
          `host=${a?.hostRepoStatusChanged ? "changed" : "ok"} ` +
          `files=${formatOutcomeSummary(a)} ` +
          `diff:[${(a?.diffSummary || "(none)").split("\n")[0]}]`,
      );
    }
    lines.push(`    notes: ${r.judgeNotes || "(none)"}`);
    console.log(lines.join("\n"));
  }
  console.log(
    "  NOTE: small-N manual benchmark; agent runs are stochastic — " +
      "treat as directional, not precise.",
  );
}

export function dedupeRecomputedResults(
  results: ScenarioResult[],
  args: Args,
): ScenarioResult[] {
  const byKey = new Map<string, { result: ScenarioResult; score: number }>();
  for (const result of results) {
    const key = recomputeResultKey(result, args);
    const score = recomputeResultQualityScore(result, args);
    const existing = byKey.get(key);
    if (!existing || score >= existing.score) {
      byKey.set(key, { result, score });
    }
  }
  return [...byKey.values()].map((entry) => entry.result);
}

function recomputeResultKey(result: ScenarioResult, args: Args): string {
  const promptWindow = result.promptWindow;
  const promptStartTurn =
    promptWindow?.promptStartTurn ?? result.promptStartTurn;
  const promptCount = promptWindow?.promptCount ?? result.promptCount;
  const preWindowCount = promptWindow?.preWindowContext?.promptCount ?? 0;
  return [
    result.session_id,
    result.pr_number ?? "no-pr",
    promptWindow?.mode ?? "legacy",
    promptStartTurn ?? "unknown-start",
    promptCount ?? "unknown-count",
    preWindowCount,
    [...args.arms].sort().join(","),
  ].join("|");
}

function recomputeResultQualityScore(
  result: ScenarioResult,
  args: Args,
): number {
  const strict = computeScenarioMetricReadiness(result, args);
  const scope = computeScenarioScopeMetricReadiness(result, args);
  let score = 0;
  if (strict.status === "ready") score += 1_000_000;
  if (scope.status === "ready") score += 100_000;
  for (const arm of args.arms) {
    const armResult = result.arms[arm];
    if (!armResult) continue;
    if (isCompleteArm(armResult)) score += 1_000;
    if (hasRequiredInjectionSurface(armResult)) score += 100;
    if (armResult.outcomeDiagnostics?.exactFileSet === true) score += 10;
    if (result.verdicts[arm] === "accomplished") score += 1;
  }
  score -= strict.blockers.length;
  score -= scope.blockers.length;
  return score;
}

interface AggregateDelta {
  arm: ArmName;
  pairedCount: number;
  meanTokenDeltaPct: number | null;
  medianTokenDeltaPct: number | null;
  meanDurationDeltaPct: number | null;
  medianDurationDeltaPct: number | null;
}

interface RateInterval {
  lower: number;
  upper: number;
}

interface ArmScopeMetrics {
  arm: ArmName;
  completedCount: number;
  instrumentedCount: number;
  prScopeEligibleCount: number;
  prFileCoveredCount: number;
  prFileCoveredRate: number | null;
  prFileCoveredRateWilson95: RateInterval | null;
  prExactFileSetCount: number;
  exactFileSetRate: number | null;
  exactFileSetRateWilson95: RateInterval | null;
  totalAttemptTokens: number | null;
  totalAttemptDurationMs: number | null;
  meanAttemptTokens: number | null;
  medianAttemptTokens: number | null;
  meanAttemptDurationMs: number | null;
  tokensPerExactFileSet: number | null;
  durationMsPerExactFileSet: number | null;
  meanExactTokens: number | null;
  medianExactTokens: number | null;
  meanExactDurationMs: number | null;
  medianExactDurationMs: number | null;
  meanUnexpectedFileCount: number | null;
  medianUnexpectedFileCount: number | null;
  meanFileRecall: number | null;
}

interface AggregateScopeDelta {
  arm: ArmName;
  pairedCount: number;
  prFileCoveredWins: number;
  prFileCoveredTies: number;
  prFileCoveredLosses: number;
  exactFileSetWins: number;
  exactFileSetTies: number;
  exactFileSetLosses: number;
  baselineExactFileSetRate: number | null;
  armExactFileSetRate: number | null;
  exactFileSetRateDelta: number | null;
  exactFileSetWinRate: number | null;
  baselinePrFileCoveredRate: number | null;
  armPrFileCoveredRate: number | null;
  prFileCoveredRateDelta: number | null;
  prFileCoveredWinRate: number | null;
  prFileCoveredWinRateWilson95: RateInterval | null;
  meanUnexpectedFilesDelta: number | null;
  medianUnexpectedFilesDelta: number | null;
  meanFileRecallDelta: number | null;
  medianFileRecallDelta: number | null;
  exactFileSetWinRateWilson95: RateInterval | null;
  exactFileSetLossRate: number | null;
  exactFileSetLossRateWilson95: RateInterval | null;
}

interface ScenarioMetricReadiness {
  session_id: string;
  pr_number?: number;
  promptStartTurn: number;
  status: "ready" | "blocked";
  blockers: string[];
  armBlockers: Partial<Record<ArmName, string[]>>;
}

interface MetricReadiness {
  reductionReady: boolean;
  pairedReductionCount: number;
  recommendedMinimumPairs: number;
  meetsRecommendedSampleSize: boolean;
  gates: {
    totalScenarios: number;
    completePairCount: number;
    instrumentedPairCount: number;
    prScopeDiagnosticsPairCount: number;
    exactScopePairCount: number;
    judgedPairCount: number;
    accomplishedPairCount: number;
  };
  blockerCounts: Record<string, number>;
  scenarios: ScenarioMetricReadiness[];
}

interface ScopeMetricReadiness {
  scopeReady: boolean;
  pairedScopeCount: number;
  recommendedMinimumPairs: number;
  meetsRecommendedSampleSize: boolean;
  gates: {
    totalScenarios: number;
    completePairCount: number;
    instrumentedPairCount: number;
    prScopeDiagnosticsPairCount: number;
  };
  blockerCounts: Record<string, number>;
  scenarios: ScenarioMetricReadiness[];
}

interface AggregateMetrics {
  baselineArm: ArmName;
  completedCount: number;
  instrumentedCount: number;
  prFileCoveredCount: number;
  prExactFileSetCount: number;
  comparableCount: number;
  metricReadiness: MetricReadiness;
  scopeMetricReadiness: ScopeMetricReadiness;
  armScopeMetrics: ArmScopeMetrics[];
  scopeDeltas: AggregateScopeDelta[];
  armDeltas: AggregateDelta[];
}

const RECOMMENDED_MIN_REDUCTION_PAIRS = 3;
const RECOMMENDED_MIN_SCOPE_PAIRS = 3;

function baselineArm(args: Args): ArmName {
  return args.arms.includes("none") ? "none" : args.arms[0];
}

export function computeAggregate(
  results: ScenarioResult[],
  args: Args,
): AggregateMetrics {
  const baseline = baselineArm(args);
  const completed = results.filter((result) =>
    args.arms.every((arm) => {
      const armResult = result.arms[arm];
      return armResult != null && isCompleteArm(armResult);
    }),
  );
  const instrumented = completed.filter((result) =>
    args.arms.every((arm) => {
      const armResult = result.arms[arm];
      return armResult != null && hasRequiredInjectionSurface(armResult);
    }),
  );
  const prFileCovered = instrumented.filter((result) =>
    args.arms.every((arm) => {
      const diagnostics = result.arms[arm]?.outcomeDiagnostics;
      return diagnostics != null && diagnostics.fileRecall === 1;
    }),
  );
  const prExactFileSet = instrumented.filter((result) =>
    hasExactPrScopeForAllArms(result, args),
  );
  const comparable = instrumented.filter(
    (result) =>
      hasRequiredOutcomeEvidence(result, args) &&
      hasExactPrScopeForAllArms(result, args) &&
      args.arms.every((arm) => result.verdicts[arm] === "accomplished"),
  );

  return {
    baselineArm: baseline,
    completedCount: completed.length,
    instrumentedCount: instrumented.length,
    prFileCoveredCount: prFileCovered.length,
    prExactFileSetCount: prExactFileSet.length,
    comparableCount: comparable.length,
    metricReadiness: computeMetricReadiness(results, args),
    scopeMetricReadiness: computeScopeMetricReadiness(results, args),
    armScopeMetrics: computeArmScopeMetrics(results, args),
    scopeDeltas: computeScopeDeltas(results, args, baseline),
    armDeltas: args.arms
      .filter((arm) => arm !== baseline)
      .map((arm) => {
        const tokenDeltas: number[] = [];
        const durationDeltas: number[] = [];
        for (const result of comparable) {
          const baselineArmResult = result.arms[baseline];
          const current = result.arms[arm];
          if (!baselineArmResult || !current) continue;
          const tokenDelta = pctDelta(
            current.totalTokens,
            baselineArmResult.totalTokens,
          );
          const durationDelta = pctDelta(
            current.durationMs,
            baselineArmResult.durationMs,
          );
          if (tokenDelta != null) tokenDeltas.push(tokenDelta);
          if (durationDelta != null) durationDeltas.push(durationDelta);
        }
        return {
          arm,
          pairedCount: comparable.length,
          meanTokenDeltaPct: mean(tokenDeltas),
          medianTokenDeltaPct: median(tokenDeltas),
          meanDurationDeltaPct: mean(durationDeltas),
          medianDurationDeltaPct: median(durationDeltas),
        };
      }),
  };
}

function computeArmScopeMetrics(
  results: ScenarioResult[],
  args: Args,
): ArmScopeMetrics[] {
  return args.arms.map((arm) => {
    let completedCount = 0;
    let instrumentedCount = 0;
    let prFileCoveredCount = 0;
    let prExactFileSetCount = 0;
    const unexpectedCounts: number[] = [];
    const recalls: number[] = [];
    const attemptTokens: number[] = [];
    const attemptDurations: number[] = [];
    const exactTokens: number[] = [];
    const exactDurations: number[] = [];
    for (const result of results) {
      const armResult = result.arms[arm];
      if (!armResult) continue;
      const complete = isCompleteArm(armResult);
      if (complete) completedCount += 1;
      const instrumented = complete && hasRequiredInjectionSurface(armResult);
      if (instrumented) instrumentedCount += 1;
      const diagnostics = armResult.outcomeDiagnostics;
      if (!instrumented || !result.pr_number || !diagnostics) continue;
      if (armResult.totalTokens != null) {
        attemptTokens.push(armResult.totalTokens);
      }
      attemptDurations.push(armResult.durationMs);
      unexpectedCounts.push(diagnostics.unexpectedFiles.length);
      if (typeof diagnostics.fileRecall === "number") {
        recalls.push(diagnostics.fileRecall);
      }
      if (diagnostics.fileRecall === 1) prFileCoveredCount += 1;
      if (diagnostics.exactFileSet) {
        prExactFileSetCount += 1;
        if (armResult.totalTokens != null) {
          exactTokens.push(armResult.totalTokens);
        }
        exactDurations.push(armResult.durationMs);
      }
    }
    return {
      arm,
      completedCount,
      instrumentedCount,
      prScopeEligibleCount: unexpectedCounts.length,
      prFileCoveredCount,
      prFileCoveredRate: rate(prFileCoveredCount, unexpectedCounts.length),
      prFileCoveredRateWilson95: wilsonInterval(
        prFileCoveredCount,
        unexpectedCounts.length,
      ),
      prExactFileSetCount,
      exactFileSetRate: rate(prExactFileSetCount, unexpectedCounts.length),
      exactFileSetRateWilson95: wilsonInterval(
        prExactFileSetCount,
        unexpectedCounts.length,
      ),
      totalAttemptTokens: sumOrNull(attemptTokens),
      totalAttemptDurationMs: sumOrNull(attemptDurations),
      meanAttemptTokens: mean(attemptTokens),
      medianAttemptTokens: median(attemptTokens),
      meanAttemptDurationMs: mean(attemptDurations),
      tokensPerExactFileSet: perSuccess(attemptTokens, prExactFileSetCount),
      durationMsPerExactFileSet: perSuccess(
        attemptDurations,
        prExactFileSetCount,
      ),
      meanExactTokens: mean(exactTokens),
      medianExactTokens: median(exactTokens),
      meanExactDurationMs: mean(exactDurations),
      medianExactDurationMs: median(exactDurations),
      meanUnexpectedFileCount: mean(unexpectedCounts),
      medianUnexpectedFileCount: median(unexpectedCounts),
      meanFileRecall: mean(recalls),
    };
  });
}

function computeScopeDeltas(
  results: ScenarioResult[],
  args: Args,
  baseline: ArmName,
): AggregateScopeDelta[] {
  return args.arms
    .filter((arm) => arm !== baseline)
    .map((arm) => {
      let prFileCoveredWins = 0;
      let prFileCoveredTies = 0;
      let prFileCoveredLosses = 0;
      let exactFileSetWins = 0;
      let exactFileSetTies = 0;
      let exactFileSetLosses = 0;
      let baselineExactFileSetCount = 0;
      let armExactFileSetCount = 0;
      let baselinePrFileCoveredCount = 0;
      let armPrFileCoveredCount = 0;
      const unexpectedDeltas: number[] = [];
      const recallDeltas: number[] = [];
      for (const result of results) {
        if (!result.pr_number) continue;
        const baselineArmResult = result.arms[baseline];
        const current = result.arms[arm];
        if (
          !baselineArmResult ||
          !current ||
          !isCompleteArm(baselineArmResult) ||
          !isCompleteArm(current) ||
          !hasRequiredInjectionSurface(baselineArmResult) ||
          !hasRequiredInjectionSurface(current)
        ) {
          continue;
        }
        const baselineDiagnostics = baselineArmResult.outcomeDiagnostics;
        const currentDiagnostics = current.outcomeDiagnostics;
        if (!baselineDiagnostics || !currentDiagnostics) continue;
        const baselineCovered = baselineDiagnostics.fileRecall === 1;
        const currentCovered = currentDiagnostics.fileRecall === 1;
        if (baselineDiagnostics.exactFileSet) baselineExactFileSetCount += 1;
        if (currentDiagnostics.exactFileSet) armExactFileSetCount += 1;
        if (baselineCovered) {
          baselinePrFileCoveredCount += 1;
        }
        if (currentCovered) armPrFileCoveredCount += 1;
        if (currentCovered && !baselineCovered) {
          prFileCoveredWins += 1;
        } else if (!currentCovered && baselineCovered) {
          prFileCoveredLosses += 1;
        } else {
          prFileCoveredTies += 1;
        }
        if (
          currentDiagnostics.exactFileSet &&
          !baselineDiagnostics.exactFileSet
        ) {
          exactFileSetWins += 1;
        } else if (
          !currentDiagnostics.exactFileSet &&
          baselineDiagnostics.exactFileSet
        ) {
          exactFileSetLosses += 1;
        } else {
          exactFileSetTies += 1;
        }
        unexpectedDeltas.push(
          currentDiagnostics.unexpectedFiles.length -
            baselineDiagnostics.unexpectedFiles.length,
        );
        if (
          typeof currentDiagnostics.fileRecall === "number" &&
          typeof baselineDiagnostics.fileRecall === "number"
        ) {
          recallDeltas.push(
            currentDiagnostics.fileRecall - baselineDiagnostics.fileRecall,
          );
        }
      }
      return {
        arm,
        pairedCount: unexpectedDeltas.length,
        prFileCoveredWins,
        prFileCoveredTies,
        prFileCoveredLosses,
        exactFileSetWins,
        exactFileSetTies,
        exactFileSetLosses,
        baselineExactFileSetRate: rate(
          baselineExactFileSetCount,
          unexpectedDeltas.length,
        ),
        armExactFileSetRate: rate(
          armExactFileSetCount,
          unexpectedDeltas.length,
        ),
        exactFileSetRateDelta: rateDelta(
          armExactFileSetCount,
          baselineExactFileSetCount,
          unexpectedDeltas.length,
        ),
        exactFileSetWinRate: rate(exactFileSetWins, unexpectedDeltas.length),
        exactFileSetWinRateWilson95: wilsonInterval(
          exactFileSetWins,
          unexpectedDeltas.length,
        ),
        exactFileSetLossRate: rate(exactFileSetLosses, unexpectedDeltas.length),
        exactFileSetLossRateWilson95: wilsonInterval(
          exactFileSetLosses,
          unexpectedDeltas.length,
        ),
        baselinePrFileCoveredRate: rate(
          baselinePrFileCoveredCount,
          unexpectedDeltas.length,
        ),
        armPrFileCoveredRate: rate(
          armPrFileCoveredCount,
          unexpectedDeltas.length,
        ),
        prFileCoveredRateDelta: rateDelta(
          armPrFileCoveredCount,
          baselinePrFileCoveredCount,
          unexpectedDeltas.length,
        ),
        prFileCoveredWinRate: rate(prFileCoveredWins, unexpectedDeltas.length),
        prFileCoveredWinRateWilson95: wilsonInterval(
          prFileCoveredWins,
          unexpectedDeltas.length,
        ),
        meanUnexpectedFilesDelta: mean(unexpectedDeltas),
        medianUnexpectedFilesDelta: median(unexpectedDeltas),
        meanFileRecallDelta: mean(recallDeltas),
        medianFileRecallDelta: median(recallDeltas),
      };
    });
}

function computeMetricReadiness(
  results: ScenarioResult[],
  args: Args,
): MetricReadiness {
  const scenarios = results.map((result) =>
    computeScenarioMetricReadiness(result, args),
  );
  const blockerCounts: Record<string, number> = {};
  for (const scenario of scenarios) {
    for (const blocker of scenario.blockers) {
      blockerCounts[blocker] = (blockerCounts[blocker] ?? 0) + 1;
    }
  }
  const completePairCount = scenarios.filter(
    (scenario) => !scenario.blockers.includes("incomplete_pair"),
  ).length;
  const instrumentedPairCount = scenarios.filter(
    (scenario) =>
      !scenario.blockers.includes("incomplete_pair") &&
      !scenario.blockers.includes("missing_injection_surface"),
  ).length;
  const prScopeDiagnosticsPairCount = scenarios.filter(
    (scenario) =>
      !scenario.blockers.includes("incomplete_pair") &&
      !scenario.blockers.includes("missing_injection_surface") &&
      !scenario.blockers.includes("missing_pr_scope_diagnostics"),
  ).length;
  const judgedPairCount = results.filter((result, index) => {
    const scenario = scenarios[index];
    if (
      !scenario ||
      scenario.blockers.includes("incomplete_pair") ||
      scenario.blockers.includes("missing_injection_surface") ||
      scenario.blockers.includes("missing_pr_scope_diagnostics") ||
      scenario.blockers.includes("missing_exact_pr_scope")
    ) {
      return false;
    }
    return args.arms.every((arm) => {
      const verdict = result.verdicts[arm];
      return (
        verdict === "accomplished" ||
        verdict === "partial" ||
        verdict === "failed"
      );
    });
  }).length;
  const exactScopePairCount = scenarios.filter(
    (scenario) =>
      !scenario.blockers.includes("incomplete_pair") &&
      !scenario.blockers.includes("missing_injection_surface") &&
      !scenario.blockers.includes("missing_pr_scope_diagnostics") &&
      !scenario.blockers.includes("missing_exact_pr_scope"),
  ).length;
  const accomplishedPairCount = scenarios.filter(
    (scenario) => scenario.status === "ready",
  ).length;
  const meetsRecommendedSampleSize =
    accomplishedPairCount >= RECOMMENDED_MIN_REDUCTION_PAIRS;
  return {
    reductionReady: meetsRecommendedSampleSize,
    pairedReductionCount: accomplishedPairCount,
    recommendedMinimumPairs: RECOMMENDED_MIN_REDUCTION_PAIRS,
    meetsRecommendedSampleSize,
    gates: {
      totalScenarios: results.length,
      completePairCount,
      instrumentedPairCount,
      prScopeDiagnosticsPairCount,
      exactScopePairCount,
      judgedPairCount,
      accomplishedPairCount,
    },
    blockerCounts,
    scenarios,
  };
}

function computeScopeMetricReadiness(
  results: ScenarioResult[],
  args: Args,
): ScopeMetricReadiness {
  const scenarios = results.map((result) =>
    computeScenarioScopeMetricReadiness(result, args),
  );
  const blockerCounts: Record<string, number> = {};
  for (const scenario of scenarios) {
    for (const blocker of scenario.blockers) {
      blockerCounts[blocker] = (blockerCounts[blocker] ?? 0) + 1;
    }
  }
  const completePairCount = scenarios.filter(
    (scenario) => !scenario.blockers.includes("incomplete_pair"),
  ).length;
  const instrumentedPairCount = scenarios.filter(
    (scenario) =>
      !scenario.blockers.includes("incomplete_pair") &&
      !scenario.blockers.includes("missing_injection_surface"),
  ).length;
  const prScopeDiagnosticsPairCount = scenarios.filter(
    (scenario) => scenario.status === "ready",
  ).length;
  const meetsRecommendedSampleSize =
    prScopeDiagnosticsPairCount >= RECOMMENDED_MIN_SCOPE_PAIRS;
  return {
    scopeReady: meetsRecommendedSampleSize,
    pairedScopeCount: prScopeDiagnosticsPairCount,
    recommendedMinimumPairs: RECOMMENDED_MIN_SCOPE_PAIRS,
    meetsRecommendedSampleSize,
    gates: {
      totalScenarios: results.length,
      completePairCount,
      instrumentedPairCount,
      prScopeDiagnosticsPairCount,
    },
    blockerCounts,
    scenarios,
  };
}

function computeScenarioScopeMetricReadiness(
  result: ScenarioResult,
  args: Args,
): ScenarioMetricReadiness {
  const armBlockers: Partial<Record<ArmName, string[]>> = {};
  const blockers = new Set<string>();

  for (const arm of args.arms) {
    const armResult = result.arms[arm];
    if (!armResult || !isCompleteArm(armResult)) {
      pushArmBlocker(armBlockers, arm, "incomplete_arm");
      blockers.add("incomplete_pair");
      continue;
    }
    if (!hasRequiredInjectionSurface(armResult)) {
      pushArmBlocker(armBlockers, arm, "missing_injection_surface");
      blockers.add("missing_injection_surface");
      continue;
    }
    if (!result.pr_number) {
      pushArmBlocker(armBlockers, arm, "no_pr_oracle");
      blockers.add("no_pr_oracle");
      continue;
    }
    if (!armResult.outcomeDiagnostics) {
      pushArmBlocker(armBlockers, arm, "missing_pr_scope_diagnostics");
      blockers.add("missing_pr_scope_diagnostics");
    }
  }

  return {
    session_id: result.session_id,
    pr_number: result.pr_number,
    promptStartTurn: result.promptStartTurn,
    status: blockers.size === 0 ? "ready" : "blocked",
    blockers: [...blockers].sort(),
    armBlockers,
  };
}

function computeScenarioMetricReadiness(
  result: ScenarioResult,
  args: Args,
): ScenarioMetricReadiness {
  const armBlockers: Partial<Record<ArmName, string[]>> = {};
  const blockers = new Set<string>();

  for (const arm of args.arms) {
    const armResult = result.arms[arm];
    if (!armResult || !isCompleteArm(armResult)) {
      pushArmBlocker(armBlockers, arm, "incomplete_arm");
      blockers.add("incomplete_pair");
    }
  }
  if (blockers.size === 0) {
    for (const arm of args.arms) {
      const armResult = result.arms[arm];
      if (armResult && !hasRequiredInjectionSurface(armResult)) {
        pushArmBlocker(armBlockers, arm, "missing_injection_surface");
        blockers.add("missing_injection_surface");
      }
    }
  }
  if (blockers.size === 0 && result.pr_number) {
    for (const arm of args.arms) {
      const armResult = result.arms[arm];
      const diagnostics = armResult?.outcomeDiagnostics;
      if (!diagnostics) {
        pushArmBlocker(armBlockers, arm, "missing_pr_scope_diagnostics");
        blockers.add("missing_pr_scope_diagnostics");
      }
    }
  }
  if (blockers.size === 0 && result.pr_number) {
    for (const arm of args.arms) {
      const diagnostics = result.arms[arm]?.outcomeDiagnostics;
      if (diagnostics?.exactFileSet === true) continue;
      if (diagnostics) {
        if (
          diagnostics.expectedFiles.length > 0 &&
          diagnostics.matchedExpectedFiles.length <
            diagnostics.expectedFiles.length
        ) {
          pushArmBlocker(armBlockers, arm, "missing_expected_pr_files");
        }
        if (diagnostics.unexpectedFiles.length > 0) {
          pushArmBlocker(armBlockers, arm, "unexpected_pr_files");
        }
        if (
          diagnostics.expectedFiles.length === 0 &&
          diagnostics.unexpectedFiles.length === 0
        ) {
          pushArmBlocker(armBlockers, arm, "non_exact_pr_scope");
        }
      }
      blockers.add("missing_exact_pr_scope");
    }
  }
  if (blockers.size === 0) {
    for (const arm of args.arms) {
      const verdict = result.verdicts[arm];
      if (verdict !== "accomplished") {
        pushArmBlocker(armBlockers, arm, `verdict_${verdict ?? "missing"}`);
        blockers.add(
          verdict == null || verdict === "unknown"
            ? "missing_verdict"
            : "not_accomplished",
        );
      }
    }
  }
  return {
    session_id: result.session_id,
    pr_number: result.pr_number,
    promptStartTurn: result.promptStartTurn,
    status: blockers.size === 0 ? "ready" : "blocked",
    blockers: [...blockers],
    armBlockers,
  };
}

function pushArmBlocker(
  armBlockers: Partial<Record<ArmName, string[]>>,
  arm: ArmName,
  reason: string,
): void {
  const blockers = armBlockers[arm] ?? [];
  blockers.push(reason);
  armBlockers[arm] = blockers;
}

export function hasRequiredInjectionSurface(armResult: ArmResult): boolean {
  const config = ARM_CONFIGS[armResult.arm];
  if (!config.panopticon) return true;
  const diagnostics = armResult.hookDiagnostics;
  if (!diagnostics) return false;
  if (diagnostics.sessionStartCount < 1) return false;
  if (armResult.userPromptInjectionOpportunities > 0) {
    if (
      typeof diagnostics.matchedUserPromptSubmitInjectionOpportunities !==
      "number"
    ) {
      return false;
    }
    if (
      diagnostics.matchedUserPromptSubmitInjectionOpportunities <
      armResult.userPromptInjectionOpportunities
    ) {
      return false;
    }
    if ((diagnostics.missingUserPromptSubmitReplayPrompts ?? []).length > 0) {
      return false;
    }
  }
  return (
    diagnostics.userPromptSubmitInjectionOpportunities >=
    armResult.userPromptInjectionOpportunities
  );
}

function isCompleteArm(armResult: ArmResult): boolean {
  return (
    armResult.exitOk === true &&
    armResult.totalTokens != null &&
    armResult.turnsCompleted === armResult.promptCount
  );
}

function isCompleteInstrumentedArm(
  armResult: ArmResult | null | undefined,
): boolean {
  return (
    armResult != null &&
    isCompleteArm(armResult) &&
    hasRequiredInjectionSurface(armResult)
  );
}

function isJudgeable(result: ScenarioResult, args: Args): boolean {
  return (
    args.arms.every((arm) => isCompleteInstrumentedArm(result.arms[arm])) &&
    hasRequiredOutcomeEvidence(result, args)
  );
}

function hasRequiredOutcomeEvidence(
  result: ScenarioResult,
  args: Args,
): boolean {
  if (!result.pr_number) return true;
  return args.arms.every((arm) => result.arms[arm]?.outcomeDiagnostics != null);
}

function hasExactPrScopeForAllArms(
  result: ScenarioResult,
  args: Args,
): boolean {
  if (!result.pr_number) return true;
  return args.arms.every((arm) => {
    const diagnostics = result.arms[arm]?.outcomeDiagnostics;
    return diagnostics != null && diagnostics.exactFileSet === true;
  });
}

function formatHookSummary(
  armResult: ArmResult | null,
  window: ScenarioWindowAssessment,
): string {
  if (!armResult) return "n/a";
  const hooks = armResult.hookDiagnostics;
  const surfaceOk = hasRequiredInjectionSurface(armResult);
  return (
    `SS:${hooks.sessionStartCount}` +
    `/UPS:${hooks.userPromptSubmitCount}` +
    `/injectable:${hooks.userPromptSubmitInjectionOpportunities}` +
    `/matched:${hooks.matchedUserPromptSubmitInjectionOpportunities ?? "?"}` +
    `/${surfaceOk ? "ok" : "missing"}` +
    (hooks.payloadOnlyMentionCount > 0
      ? `/payload_mentions:${hooks.payloadOnlyMentionCount}`
      : "") +
    (window.userPromptInjectionOpportunities > 0
      ? `/expected:${window.userPromptInjectionOpportunities}`
      : "")
  );
}

function formatOutcomeSummary(armResult: ArmResult | null): string {
  const diagnostics = armResult?.outcomeDiagnostics;
  if (!diagnostics) return "n/a";
  return (
    `${diagnostics.matchedExpectedFiles.length}/${diagnostics.expectedFiles.length}` +
    (diagnostics.unexpectedFiles.length > 0
      ? `+${diagnostics.unexpectedFiles.length}extra`
      : "")
  );
}

function pctDelta(
  current: number | null | undefined,
  baseline: number | null | undefined,
): number | null {
  if (current == null || baseline == null || baseline <= 0) return null;
  return ((current - baseline) / baseline) * 100;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function wilsonInterval(
  successes: number,
  attempts: number,
  z = 1.959963984540054,
): RateInterval | null {
  if (attempts <= 0) return null;
  const p = successes / attempts;
  const z2 = z * z;
  const denominator = 1 + z2 / attempts;
  const center = (p + z2 / (2 * attempts)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / attempts + z2 / (4 * attempts * attempts))) /
    denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function rateDelta(
  currentCount: number,
  baselineCount: number,
  denominator: number,
): number | null {
  return denominator > 0 ? (currentCount - baselineCount) / denominator : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function perSuccess(values: number[], successes: number): number | null {
  const total = sumOrNull(values);
  return total != null && successes > 0 ? total / successes : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatPct(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(1)}%`;
}

function formatRate(value: number | null): string {
  return value == null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function formatRateDelta(value: number | null): string {
  if (value == null) return "n/a";
  const formatted = (value * 100).toFixed(0);
  return value > 0 ? `+${formatted}` : formatted;
}

function formatRateDeltaPp(value: number | null): string {
  const delta = formatRateDelta(value);
  return delta === "n/a" ? delta : `${delta}pp`;
}

function formatRateInterval(value: RateInterval | null): string {
  return value == null
    ? "n/a"
    : `[${formatRate(value.lower)},${formatRate(value.upper)}]`;
}

function formatTokens(value: number | null): string {
  return value == null ? "n/a" : String(Math.round(value));
}

function formatDurationMs(value: number | null): string {
  return value == null ? "n/a" : `${(value / 60000).toFixed(1)}m`;
}

function formatNumber(value: number | null): string {
  return value == null ? "n/a" : value.toFixed(2).replace(/\.00$/, "");
}

function formatBlockerCounts(blockerCounts: Record<string, number>): string {
  return Object.entries(blockerCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([blocker, count]) => `${blocker}=${count}`)
    .join(", ");
}

function loadOrCreateFixture(args: Args): FixtureLoadResult {
  if (args.fixtureFile) {
    return loadFixtureFile(args);
  }
  const filePath = path.join(args.fixtureDir, "scenarios.json");
  if (fs.existsSync(filePath)) {
    return loadFixtureFile({ ...args, fixtureFile: filePath });
  }
  const scenarios = sampleScenarios(args);
  fs.mkdirSync(args.fixtureDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(scenarios, null, 2)}\n`);
  return {
    scenarios,
    fixtureLoadSummary: {
      source: filePath,
      rawRowCount: scenarios.length,
      loadedScenarioCount: scenarios.length,
      droppedRowCount: 0,
      droppedReasonCounts: {},
    },
  };
}

function loadFixtureFile(args: Args): FixtureLoadResult {
  if (!args.fixtureFile) {
    return { scenarios: [], fixtureLoadSummary: null };
  }
  const rows = extractFixtureRows(
    JSON.parse(fs.readFileSync(args.fixtureFile, "utf-8")) as unknown,
  );
  const scenarios: Scenario[] = [];
  const droppedReasons: string[][] = [];
  for (const row of rows) {
    const loaded = loadFixtureScenario(row, args);
    if (loaded.scenario) {
      scenarios.push(loaded.scenario);
    } else {
      droppedReasons.push([loaded.reason]);
    }
  }
  const droppedReasonCounts = summarizeReasonCounts(droppedReasons);
  if (droppedReasons.length > 0) {
    console.log(
      `Loaded ${scenarios.length}/${rows.length} fixture row(s); dropped ` +
        formatCandidateSkipCounts(droppedReasons),
    );
  }
  return {
    scenarios,
    fixtureLoadSummary: {
      source: args.fixtureFile,
      rawRowCount: rows.length,
      loadedScenarioCount: scenarios.length,
      droppedRowCount: droppedReasons.length,
      droppedReasonCounts,
    },
  };
}

export function extractFixtureRows(
  raw: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (!isRecord(raw)) return [];
  for (const key of ["scenarios", "results", "measurements", "candidates"]) {
    const rows = raw[key];
    if (Array.isArray(rows)) return rows.filter(isRecord);
  }
  return [];
}

function loadFixtureScenario(
  row: Record<string, unknown>,
  args: Args,
): { scenario: Scenario | null; reason: string } {
  if (isScenarioFixtureRow(row)) {
    return { scenario: row, reason: "loaded" };
  }
  if (isPrCandidateFixtureRow(row)) {
    return hydratePrCandidateScenario(row, args);
  }
  return { scenario: null, reason: "unsupported_fixture_row" };
}

function isScenarioFixtureRow(row: Record<string, unknown>): row is Scenario {
  return (
    typeof row.session_id === "string" &&
    typeof row.head_sha === "string" &&
    typeof row.started_at_ms === "number" &&
    typeof row.first_prompt === "string" &&
    Array.isArray(row.prompts) &&
    row.prompts.every((prompt) => typeof prompt === "string")
  );
}

interface PrCandidateFixtureRow {
  session_id: string;
  pr_number: number;
  merge_commit: string;
  branch?: string;
  title?: string;
  date?: string;
}

function isPrCandidateFixtureRow(
  row: Record<string, unknown>,
): row is PrCandidateFixtureRow {
  return (
    typeof row.session_id === "string" &&
    typeof row.pr_number === "number" &&
    typeof row.merge_commit === "string"
  );
}

function hydratePrCandidateScenario(
  row: PrCandidateFixtureRow,
  args: Args,
): { scenario: Scenario | null; reason: string } {
  const prompts = loadSessionPrompts(row.session_id);
  if (prompts.length === 0) {
    return { scenario: null, reason: "missing_local_prompts" };
  }
  const headSha = resolveMergeParent(args.repoRoot, row.merge_commit);
  if (!headSha) return { scenario: null, reason: "missing_merge_parent" };
  const expectedDiffstat = readGitShowStat(args.repoRoot, row.merge_commit);
  if (!expectedDiffstat) {
    return { scenario: null, reason: "missing_merge_diffstat" };
  }
  const startedAtMs =
    loadSessionStartedAtMs(row.session_id) ??
    (row.date ? Date.parse(`${row.date}T00:00:00Z`) : NaN);
  if (!Number.isFinite(startedAtMs)) {
    return { scenario: null, reason: "missing_started_at" };
  }
  return {
    scenario: {
      session_id: row.session_id,
      head_sha: headSha,
      anchor: "exact",
      started_at_ms: startedAtMs,
      first_prompt: prompts[0] ?? "",
      prompts,
      pr_number: row.pr_number,
      merge_commit: row.merge_commit,
      branch: row.branch,
      pr_title: row.title,
      expected_diffstat: expectedDiffstat,
    },
    reason: "loaded",
  };
}

function loadSessionPrompts(sessionId: string): string[] {
  const db = getDb();
  const hookPrompts = (
    db
      .prepare(
        `SELECT user_prompt
         FROM hook_events
         WHERE session_id = ? AND event_type = 'UserPromptSubmit'
           AND user_prompt IS NOT NULL AND TRIM(user_prompt) != ''
         ORDER BY timestamp_ms ASC, id ASC`,
      )
      .all(sessionId) as Array<{ user_prompt: string }>
  )
    .map((row) => row.user_prompt.trim())
    .filter(isReplayableUserPrompt);
  if (hookPrompts.length > 0) return hookPrompts;
  return (
    db
      .prepare(
        `SELECT content
         FROM messages
         WHERE session_id = ? AND role = 'user'
           AND COALESCE(is_system, 0) != 1
           AND content IS NOT NULL AND TRIM(content) != ''
         ORDER BY ordinal ASC, id ASC`,
      )
      .all(sessionId) as Array<{ content: string }>
  )
    .map((row) => row.content.trim())
    .filter(isReplayableUserPrompt);
}

function isReplayableUserPrompt(prompt: string): boolean {
  return (
    prompt.length > 0 &&
    !/^<local-command-caveat|^<command-message>|^Caveat:|^<command-name>|^Reply with exactly OK|^\[Request interrupted/.test(
      prompt,
    )
  );
}

function loadSessionStartedAtMs(sessionId: string): number | null {
  try {
    const row = getDb()
      .prepare("SELECT started_at_ms FROM sessions WHERE session_id = ?")
      .get(sessionId) as { started_at_ms: number | null } | undefined;
    return typeof row?.started_at_ms === "number" ? row.started_at_ms : null;
  } catch {
    return null;
  }
}

function resolveMergeParent(
  repoRoot: string,
  mergeCommit: string,
): string | null {
  try {
    const sha = execFileSync(
      "git",
      ["-C", repoRoot, "rev-parse", `${mergeCommit}^1`],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return sha || null;
  } catch {
    return null;
  }
}

function readGitShowStat(repoRoot: string, commit: string): string | null {
  try {
    const stat = execFileSync(
      "git",
      ["-C", repoRoot, "show", "--stat", "--format=", "--find-renames", commit],
      {
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return stat || null;
  } catch {
    return null;
  }
}

function sampleScenarios(args: Args): Scenario[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.session_id AS session_id,
              sr.head_sha AS head_sha,
              sr.branch AS branch,
              s.started_at_ms AS started_at_ms,
              s.first_prompt AS first_prompt
       FROM sessions s
       JOIN session_repositories sr ON sr.session_id = s.session_id
       WHERE sr.repository = ?
         AND COALESCE(s.is_automated, 0) != 1
         AND s.started_at_ms IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM hook_events e
           WHERE e.session_id = s.session_id
             AND e.event_type = 'PostToolUse'
             AND e.tool_name IN ('Edit', 'Write', 'MultiEdit', 'apply_patch')
         )
       ORDER BY s.started_at_ms DESC
       LIMIT ?`,
    )
    .all(args.repository, args.limit * 3) as Array<{
    session_id: string;
    head_sha: string | null;
    branch: string | null;
    started_at_ms: number;
    first_prompt: string | null;
  }>;

  return rows
    .map((r) => {
      const anchor: "exact" | "approx" = r.head_sha ? "exact" : "approx";
      const sha =
        r.head_sha ?? resolveCommitAt(args.repoRoot, r.branch, r.started_at_ms);
      if (!sha) return null;
      const prompts = (
        db
          .prepare(
            `SELECT user_prompt FROM hook_events
             WHERE session_id = ? AND event_type = 'UserPromptSubmit'
               AND user_prompt IS NOT NULL AND TRIM(user_prompt) != ''
             ORDER BY timestamp_ms ASC, id ASC`,
          )
          .all(r.session_id) as Array<{ user_prompt: string }>
      ).map((p) => p.user_prompt);
      const scenario: Scenario = {
        session_id: r.session_id,
        head_sha: sha,
        anchor,
        started_at_ms: r.started_at_ms,
        first_prompt: r.first_prompt ?? prompts[0] ?? "",
        prompts,
      };
      return scenario;
    })
    .filter(
      (s): s is Scenario =>
        s !== null && s.prompts.length > 0 && s.first_prompt.length > 0,
    )
    .slice(0, args.limit);
}

function applyPromptLimit(s: Scenario, args: Args): Scenario {
  const originalPromptCount = s.original_prompt_count ?? s.prompts.length;
  const originalPromptOffset = s.original_prompt_offset ?? 0;
  const window = selectPromptWindow(s.prompts, {
    mode: args.windowMode,
    maxPrompts: args.maxPrompts,
    actionContextPrompts: args.actionContextPrompts,
    actionFollowupPrompts: args.actionFollowupPrompts,
    relevanceTerms: buildScenarioRelevanceTerms(s),
  });
  const priorContext = selectPreWindowContext(
    s.prompts,
    window.startIndex,
    args.preWindowContextPrompts,
  );
  return {
    ...s,
    prompts: window.prompts,
    first_prompt: window.prompts[0] || s.first_prompt || "",
    original_prompt_count: originalPromptCount,
    original_prompt_offset: originalPromptOffset + window.startIndex,
    pre_window_prompts: priorContext.prompts,
    pre_window_prompt_offset: originalPromptOffset + priorContext.startIndex,
  };
}

export function buildPromptWindowTrace(
  s: Scenario,
  args: Pick<Args, "windowMode">,
): PromptWindowTrace {
  const promptStartTurn = (s.original_prompt_offset ?? 0) + 1;
  const promptEndTurn = promptStartTurn + Math.max(0, s.prompts.length - 1);
  const prePrompts = s.pre_window_prompts ?? [];
  const preStartTurn =
    prePrompts.length > 0 ? (s.pre_window_prompt_offset ?? 0) + 1 : null;
  const preEndTurn =
    preStartTurn == null ? null : preStartTurn + prePrompts.length - 1;
  return {
    mode: args.windowMode,
    promptStartTurn,
    promptEndTurn,
    promptCount: s.prompts.length,
    prompts: s.prompts.map((text, index) =>
      promptWindowPrompt(promptStartTurn + index, text),
    ),
    preWindowContext: {
      promptStartTurn: preStartTurn,
      promptEndTurn: preEndTurn,
      promptCount: prePrompts.length,
      prompts: prePrompts.map((text, index) =>
        promptWindowPrompt((preStartTurn ?? 1) + index, text),
      ),
    },
  };
}

export function assessReplayCandidate(s: Scenario): CandidateAssessment {
  const window = assessScenarioWindow(s);
  const expectedFileCount = s.expected_diffstat
    ? parseDiffstatFiles(s.expected_diffstat).length
    : null;
  const relevanceScore = scoreSelectedPromptWindowRelevance(s);
  const actionIndex = findLikelyMidSessionActionPromptIndex(s.prompts);
  const actionPrompt =
    actionIndex == null ? null : (s.prompts[actionIndex] ?? null);
  const reasons: string[] = [];
  const risks: string[] = [];
  let score = 0;
  let labelCap: CandidateAssessment["label"] = "strong";

  if (s.anchor === "exact") {
    score += 10;
    reasons.push("exact head_sha anchor");
  } else {
    risks.push("approximate commit anchor");
  }
  if (s.pr_number) {
    score += 20;
    reasons.push(`PR oracle #${s.pr_number}`);
  } else {
    risks.push("no merged-PR oracle");
  }
  if (window.measurable) {
    score += 20;
    reasons.push("measurable UserPromptSubmit action window");
  } else {
    score -= 30;
    labelCap = minCandidateLabel(labelCap, "weak");
    risks.push(...window.warnings);
  }
  if (s.prompts.length === 2) {
    score += 15;
    reasons.push("two-turn action pair");
  } else if (s.prompts.length <= 3) {
    score += 10;
    reasons.push("short bounded replay window");
  } else {
    risks.push(`${s.prompts.length} replay prompts increases drift risk`);
  }
  if (relevanceScore >= 8) {
    score += 20;
    reasons.push("selected prompts strongly match PR terms");
  } else if (relevanceScore >= 4) {
    score += 15;
    labelCap = minCandidateLabel(labelCap, "medium");
    risks.push(
      "selected prompts match PR terms but not strongly enough for strict replay",
    );
  } else if (relevanceScore > 0) {
    score += 8;
    labelCap = minCandidateLabel(labelCap, "medium");
    risks.push("selected prompts weakly match PR terms");
  } else {
    score -= 20;
    labelCap = minCandidateLabel(labelCap, "medium");
    risks.push("selected prompts do not match PR title or diffstat terms");
  }
  if (expectedFileCount == null) {
    risks.push("unknown expected PR file count");
  } else if (expectedFileCount === 1) {
    score += 15;
    reasons.push("single-file PR oracle");
  } else if (expectedFileCount <= 3) {
    score += 10;
    reasons.push(`${expectedFileCount}-file PR oracle`);
  } else if (expectedFileCount <= 5) {
    labelCap = minCandidateLabel(labelCap, "medium");
    risks.push(`${expectedFileCount}-file PR oracle is broader`);
  } else if (expectedFileCount <= 10) {
    score -= 15;
    labelCap = minCandidateLabel(labelCap, "medium");
    risks.push(`${expectedFileCount}-file PR oracle is broad`);
  } else {
    score -= 30;
    labelCap = minCandidateLabel(labelCap, "weak");
    risks.push(
      `${expectedFileCount}-file PR oracle is too broad for exact-file-set metrics`,
    );
  }
  if (hasNearDuplicatePrompt(s.prompts)) {
    score -= 10;
    risks.push("selected replay prompts are near-duplicates");
  }
  if (actionPrompt && isSetupOnlyActionPrompt(actionPrompt)) {
    score -= 30;
    labelCap = minCandidateLabel(labelCap, "weak");
    risks.push("selected action prompt is setup-only, not the PR change");
  }
  const issueMentionCount = Math.max(
    0,
    ...s.prompts.map((prompt) => countIndependentIssueMentions(prompt)),
  );
  if (
    issueMentionCount > 1 &&
    expectedFileCount != null &&
    expectedFileCount < issueMentionCount
  ) {
    score -= 25;
    labelCap = minCandidateLabel(labelCap, "medium");
    risks.push(
      `selected action prompt lists ${issueMentionCount} issues for a ` +
        `${expectedFileCount}-file PR oracle`,
    );
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  const uncappedLabel =
    boundedScore >= 80 ? "strong" : boundedScore >= 50 ? "medium" : "weak";
  return {
    score: boundedScore,
    label: minCandidateLabel(uncappedLabel, labelCap),
    expectedFileCount,
    relevanceScore,
    reasons,
    risks,
  };
}

function minCandidateLabel(
  a: CandidateAssessment["label"],
  b: CandidateAssessment["label"],
): CandidateAssessment["label"] {
  return candidateLabelRank(a) <= candidateLabelRank(b) ? a : b;
}

function candidateLabelRank(label: CandidateAssessment["label"]): number {
  return { weak: 0, medium: 1, strong: 2 }[label];
}

function countIndependentIssueMentions(prompt: string): number {
  const bugIds = new Set(prompt.match(/\bbug[_-]\d+\b/gi) ?? []);
  if (bugIds.size > 1) return bugIds.size;
  const numberedItems = prompt.match(/(?:^|\n)\s*\d+[.)]\s+/g) ?? [];
  return numberedItems.length;
}

export function candidateFilterReasons(
  s: Scenario,
  args: Pick<
    Args,
    | "minCandidateLabel"
    | "minCandidateScore"
    | "minRelevanceScore"
    | "maxExpectedFiles"
    | "skipPriorAttempted"
    | "skipPriorStrictReady"
  >,
  priorOutcome: PriorReplayOutcome | null = null,
): string[] {
  const candidate = assessReplayCandidate(s);
  const reasons: string[] = [];
  if (
    args.minCandidateLabel &&
    candidateLabelRank(candidate.label) <
      candidateLabelRank(args.minCandidateLabel)
  ) {
    reasons.push(`candidate_label_below_${args.minCandidateLabel}`);
  }
  if (
    args.minCandidateScore != null &&
    candidate.score < args.minCandidateScore
  ) {
    reasons.push(`candidate_score_below_${args.minCandidateScore}`);
  }
  if (
    args.minRelevanceScore != null &&
    candidate.relevanceScore < args.minRelevanceScore
  ) {
    reasons.push(`relevance_score_below_${args.minRelevanceScore}`);
  }
  if (args.maxExpectedFiles != null) {
    if (candidate.expectedFileCount == null) {
      reasons.push("expected_files_unknown");
    } else if (candidate.expectedFileCount > args.maxExpectedFiles) {
      reasons.push(`expected_files_above_${args.maxExpectedFiles}`);
    }
  }
  if (args.skipPriorAttempted && (priorOutcome?.attempts ?? 0) > 0) {
    reasons.push("prior_current_shape_attempted");
  }
  if (args.skipPriorStrictReady && (priorOutcome?.strictReady ?? 0) > 0) {
    reasons.push("prior_current_shape_strict_ready");
  }
  return reasons;
}

export function sortReplayCandidates(scenarios: Scenario[]): Scenario[] {
  return scenarios
    .map((scenario, index) => ({
      scenario,
      index,
      candidate: assessReplayCandidate(scenario),
    }))
    .sort((a, b) => {
      const scoreDelta = b.candidate.score - a.candidate.score;
      if (scoreDelta !== 0) return scoreDelta;
      const relevanceDelta =
        b.candidate.relevanceScore - a.candidate.relevanceScore;
      if (relevanceDelta !== 0) return relevanceDelta;
      const riskDelta = a.candidate.risks.length - b.candidate.risks.length;
      if (riskDelta !== 0) return riskDelta;
      const expectedFileDelta =
        expectedFileSortValue(a.candidate.expectedFileCount) -
        expectedFileSortValue(b.candidate.expectedFileCount);
      if (expectedFileDelta !== 0) return expectedFileDelta;
      return a.index - b.index;
    })
    .map((item) => item.scenario);
}

export function dedupeReplayCandidateWindows(
  scenarios: Scenario[],
  args: Pick<Args, "windowMode">,
): Scenario[] {
  const selected: Scenario[] = [];
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    const key = replayCandidateWindowKey(scenario, args);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(scenario);
  }
  return selected;
}

function replayCandidateWindowKey(
  scenario: Scenario,
  args: Pick<Args, "windowMode">,
): string {
  const trace = buildPromptWindowTrace(scenario, args);
  return [
    scenario.session_id,
    trace.mode,
    trace.promptStartTurn,
    trace.promptCount,
    trace.preWindowContext.promptCount,
    trace.prompts.map((prompt) => prompt.text).join("\u001f"),
  ].join("|");
}

function expectedFileSortValue(value: number | null): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

function formatCandidateSkipCounts(reasonGroups: string[][]): string {
  return Object.entries(summarizeReasonCounts(reasonGroups))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
}

export function summarizeReasonCounts(
  reasonGroups: string[][],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reasons of reasonGroups) {
    for (const reason of reasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
}

function candidateFilterLabel(args: Args): string {
  const labels = [
    args.minCandidateLabel ? `min_label=${args.minCandidateLabel}` : null,
    args.minCandidateScore != null
      ? `min_score=${args.minCandidateScore}`
      : null,
    args.minRelevanceScore != null
      ? `min_relevance=${args.minRelevanceScore}`
      : null,
    args.maxExpectedFiles != null
      ? `max_expected_files=${args.maxExpectedFiles}`
      : null,
    args.skipPriorAttempted ? "skip_prior_attempted" : null,
    args.skipPriorStrictReady ? "skip_prior_strict_ready" : null,
  ].filter((value): value is string => value != null);
  return labels.length > 0 ? `candidate_filters=${labels.join(",")}` : "";
}

interface PriorResultInput {
  source: string;
  args: Args;
  results: ScenarioResult[];
}

export function summarizePriorReplayOutcomes(
  inputs: PriorResultInput[],
  targetArgs?: Args,
): Map<string, PriorReplayOutcome> {
  const outcomes = new Map<string, PriorReplayOutcome>();
  const seenAttempts = new Map<string, Set<string>>();
  for (const input of inputs) {
    const baseline = baselineArm(input.args);
    for (const result of input.results) {
      if (!hasPriorExecutedAttempt(result)) continue;
      const outcomeKey = priorOutcomeKeyForResult(result);
      const attemptKey = priorAttemptKey(result, input.args);
      const seen = seenAttempts.get(outcomeKey) ?? new Set<string>();
      if (seen.has(attemptKey)) continue;
      seen.add(attemptKey);
      seenAttempts.set(outcomeKey, seen);

      const summary = outcomes.get(outcomeKey) ?? {
        attempts: 0,
        totalAttempts: 0,
        incompatibleAttempts: 0,
        strictReady: 0,
        blockers: {},
        armExactFileSet: {},
        exactFileSetWins: {},
        sources: [],
      };
      summary.totalAttempts += 1;
      if (!summary.sources.includes(input.source)) {
        summary.sources.push(input.source);
      }
      if (!isCompatiblePriorReplayAttempt(result, input.args, targetArgs)) {
        summary.incompatibleAttempts += 1;
        outcomes.set(outcomeKey, summary);
        continue;
      }
      summary.attempts += 1;
      const readiness = computeScenarioMetricReadiness(result, input.args);
      if (readiness.status === "ready") {
        summary.strictReady += 1;
      }
      for (const blocker of readiness.blockers) {
        summary.blockers[blocker] = (summary.blockers[blocker] ?? 0) + 1;
      }
      const baselineExact =
        result.arms[baseline]?.outcomeDiagnostics?.exactFileSet === true;
      for (const arm of input.args.arms) {
        const exact =
          result.arms[arm]?.outcomeDiagnostics?.exactFileSet === true;
        if (exact) {
          summary.armExactFileSet[arm] =
            (summary.armExactFileSet[arm] ?? 0) + 1;
        }
        if (arm !== baseline && exact && !baselineExact) {
          summary.exactFileSetWins[arm] =
            (summary.exactFileSetWins[arm] ?? 0) + 1;
        }
      }
      outcomes.set(outcomeKey, summary);
    }
  }
  return outcomes;
}

export function priorOutcomeKeyForScenario(
  scenario: Scenario,
  args: Pick<Args, "windowMode">,
): string {
  const trace = buildPromptWindowTrace(scenario, args);
  return priorOutcomeKey({
    sessionId: scenario.session_id,
    prNumber: scenario.pr_number,
    mode: trace.mode,
    promptStartTurn: trace.promptStartTurn,
    promptCount: trace.promptCount,
    preWindowCount: trace.preWindowContext.promptCount,
  });
}

function priorOutcomeKeyForResult(result: ScenarioResult): string {
  return priorOutcomeKey({
    sessionId: result.session_id,
    prNumber: result.pr_number,
    mode: result.promptWindow?.mode ?? "legacy",
    promptStartTurn:
      result.promptWindow?.promptStartTurn ??
      result.promptWindow?.prompts?.[0]?.turn ??
      result.promptStartTurn,
    promptCount: result.promptWindow?.promptCount ?? result.promptCount,
    preWindowCount: result.promptWindow?.preWindowContext?.promptCount ?? 0,
  });
}

function priorOutcomeKey(input: {
  sessionId: string;
  prNumber: number | undefined;
  mode: string;
  promptStartTurn: number | undefined;
  promptCount: number | undefined;
  preWindowCount: number;
}): string {
  return [
    input.sessionId,
    input.prNumber ?? "no-pr",
    input.mode,
    input.promptStartTurn ?? "unknown-start",
    input.promptCount ?? "unknown-count",
    input.preWindowCount,
  ].join("|");
}

function hasPriorExecutedAttempt(result: ScenarioResult): boolean {
  return Object.keys(result.arms ?? {}).length > 0;
}

function priorAttemptKey(result: ScenarioResult, args: Args): string {
  const windowTurns =
    result.promptWindow?.prompts?.map((prompt) => prompt.turn).join(",") ??
    `${result.promptStartTurn}:${result.promptCount}`;
  const arms = orderedArms(args)
    .map((arm) => {
      const armResult = result.arms[arm];
      if (!armResult) return `${arm}:missing`;
      const replayIds = armResult.replaySessionIds?.join(",") ?? "";
      if (replayIds.length > 0) return `${arm}:${replayIds}`;
      return [
        arm,
        armResult.durationMs,
        armResult.totalTokens ?? "tokens-null",
        armResult.turnsCompleted,
        armResult.diffSummary,
      ].join(":");
    })
    .join("|");
  return `${windowTurns}|${arms}`;
}

function isCompatiblePriorReplayAttempt(
  result: ScenarioResult,
  priorArgs: Args,
  targetArgs: Args | undefined,
): boolean {
  if (!targetArgs) return true;
  if (!sameArmSet(priorArgs.arms, targetArgs.arms)) return false;
  if (
    result.promptWindow?.mode &&
    result.promptWindow.mode !== targetArgs.windowMode
  ) {
    return false;
  }
  const promptCount = result.promptWindow?.promptCount ?? result.promptCount;
  if (targetArgs.maxPrompts == null) {
    if (
      typeof result.originalPromptCount === "number" &&
      promptCount !== result.originalPromptCount
    ) {
      return false;
    }
  } else if (promptCount !== targetArgs.maxPrompts) {
    return false;
  }
  const preWindowCount = result.promptWindow?.preWindowContext?.promptCount;
  if (
    typeof preWindowCount === "number" &&
    preWindowCount !== targetArgs.preWindowContextPrompts
  ) {
    return false;
  }
  return true;
}

function sameArmSet(a: ArmName[], b: ArmName[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((arm, index) => arm === right[index]);
}

function loadPriorReplayOutcomes(args: Args): Map<string, PriorReplayOutcome> {
  if (args.priorResultJson.length === 0) return new Map();
  const inputs: PriorResultInput[] = [];
  for (const filePath of args.priorResultJson) {
    try {
      const input = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
        args?: Record<string, unknown>;
        results?: unknown;
      };
      if (!Array.isArray(input.results)) {
        process.stderr.write(
          `Skipping prior result JSON without results array: ${filePath}\n`,
        );
        continue;
      }
      inputs.push({
        source: filePath,
        args: argsFromSerializedResultArgs(input.args, args),
        results: input.results as ScenarioResult[],
      });
    } catch (err) {
      process.stderr.write(
        `Skipping unreadable prior result JSON ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }
  return summarizePriorReplayOutcomes(inputs, args);
}

function formatPriorReplayOutcome(outcome: PriorReplayOutcome): string {
  const blockers = formatBlockerCounts(outcome.blockers);
  const exact = Object.entries(outcome.armExactFileSet)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([arm, count]) => `${arm} exact=${count}`)
    .join(", ");
  const wins = Object.entries(outcome.exactFileSetWins)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([arm, count]) => `${arm} wins=${count}`)
    .join(", ");
  return [
    `attempts=${outcome.attempts}`,
    outcome.incompatibleAttempts > 0
      ? `other_shape_attempts=${outcome.incompatibleAttempts}`
      : "",
    `strict_ready=${outcome.strictReady}`,
    exact || "exact=none",
    wins || "",
    blockers ? `blockers=${blockers}` : "blockers=none",
  ]
    .filter((part) => part.length > 0)
    .join("; ");
}

function scoreSelectedPromptWindowRelevance(s: Scenario): number {
  const terms = buildScenarioRelevanceTerms(s);
  return s.prompts.reduce(
    (sum, prompt) => sum + scorePromptRelevance(prompt, terms),
    0,
  );
}

function hasNearDuplicatePrompt(prompts: string[]): boolean {
  const normalized = prompts.map((prompt) =>
    prompt.replace(/\s+/g, " ").trim().toLowerCase(),
  );
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i];
      const b = normalized[j];
      if (a.length < 20 || b.length < 20) continue;
      if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
    }
  }
  return false;
}

function promptWindowPrompt(turn: number, text: string): PromptWindowPrompt {
  return {
    turn,
    charCount: text.length,
    text,
  };
}

export function selectPreWindowContext(
  prompts: string[],
  windowStartIndex: number,
  maxPrompts: number,
): { prompts: string[]; startIndex: number } {
  if (maxPrompts <= 0 || windowStartIndex <= 0) {
    return { prompts: [], startIndex: windowStartIndex };
  }
  const startIndex = Math.max(0, windowStartIndex - maxPrompts);
  return {
    prompts: prompts.slice(startIndex, windowStartIndex),
    startIndex,
  };
}

export function selectPromptWindow(
  prompts: string[],
  opts: {
    mode: PromptWindowMode;
    maxPrompts: number | null;
    actionContextPrompts: number;
    actionFollowupPrompts: number;
    relevanceTerms?: string[];
  },
): { prompts: string[]; startIndex: number } {
  if (opts.mode === "prefix") {
    return {
      prompts:
        opts.maxPrompts == null ? prompts : prompts.slice(0, opts.maxPrompts),
      startIndex: 0,
    };
  }

  const actionIndex =
    opts.mode === "around-relevant-action"
      ? findRelevantMidSessionActionPromptIndex(
          prompts,
          opts.relevanceTerms ?? [],
          opts.actionContextPrompts,
        )
      : findLikelyMidSessionActionPromptIndex(prompts);
  if (actionIndex == null) {
    return {
      prompts:
        opts.maxPrompts == null ? prompts : prompts.slice(0, opts.maxPrompts),
      startIndex: 0,
    };
  }

  const startIndex = Math.max(0, actionIndex - opts.actionContextPrompts);
  let endIndex = Math.min(
    prompts.length,
    actionIndex + 1 + opts.actionFollowupPrompts,
  );
  if (opts.maxPrompts != null && endIndex - startIndex > opts.maxPrompts) {
    endIndex = Math.max(actionIndex + 1, startIndex + opts.maxPrompts);
  }
  return {
    prompts: prompts.slice(startIndex, endIndex),
    startIndex,
  };
}

function promptLimitLabel(args: Args): string {
  if (
    args.windowMode === "around-action" ||
    args.windowMode === "around-relevant-action"
  ) {
    return (
      `${args.windowMode} context=${args.actionContextPrompts} ` +
      `followup=${args.actionFollowupPrompts}` +
      (args.maxPrompts == null ? "" : ` cap=${args.maxPrompts}`) +
      (args.preWindowContextPrompts > 0
        ? ` pre=${args.preWindowContextPrompts}`
        : "")
    );
  }
  return (
    (args.maxPrompts == null ? "all" : `first ${args.maxPrompts}`) +
    (args.preWindowContextPrompts > 0
      ? ` pre=${args.preWindowContextPrompts}`
      : "")
  );
}

export function assessScenarioWindow(s: Scenario): ScenarioWindowAssessment {
  // UserPromptSubmit context is intentionally disabled on the first prompt
  // by the production ingest gate. Turn 2+ are the measurable opportunities.
  const userPromptInjectionOpportunities = Math.max(0, s.prompts.length - 1);
  const likelyActionPromptTurn = findLikelyMidSessionActionPromptTurn(s);
  const warnings: string[] = [];
  if (userPromptInjectionOpportunities === 0) {
    warnings.push(
      "single-turn window only measures SessionStart; UserPromptSubmit never fires",
    );
  }
  if (likelyActionPromptTurn == null) {
    warnings.push(
      "bounded window has no likely mid-session action prompt; PR-diff outcome judging may be uninformative",
    );
  }
  const startsWithClearCommand = isClearCommandPrompt(s.prompts[0] ?? "");
  if (startsWithClearCommand) {
    warnings.push(
      "bounded window starts with /clear; replay prefix is a context reset, not an outcome request",
    );
  }
  return {
    userPromptInjectionOpportunities,
    likelyActionPromptTurn,
    measurable:
      userPromptInjectionOpportunities > 0 &&
      likelyActionPromptTurn != null &&
      !startsWithClearCommand,
    warnings,
  };
}

function findLikelyMidSessionActionPromptTurn(s: Scenario): number | null {
  const index = findLikelyMidSessionActionPromptIndex(s.prompts);
  return index == null ? null : index + 1;
}

function findLikelyMidSessionActionPromptIndex(
  prompts: string[],
): number | null {
  for (let i = 1; i < prompts.length; i++) {
    if (isLikelyActionPrompt(prompts[i])) return i;
  }
  return null;
}

function findRelevantMidSessionActionPromptIndex(
  prompts: string[],
  relevanceTerms: string[],
  actionContextPrompts: number,
): number | null {
  const terms = unique(relevanceTerms).filter((term) => term.length > 0);
  let best: { index: number; score: number } | null = null;
  for (let i = 1; i < prompts.length; i++) {
    if (!isLikelyActionPrompt(prompts[i])) continue;
    const score = scorePromptWindowRelevance(
      prompts,
      i,
      terms,
      actionContextPrompts,
    );
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { index: i, score };
    }
  }
  if (best) return best.index;
  return terms.length > 0
    ? null
    : findLikelyMidSessionActionPromptIndex(prompts);
}

function isLikelyActionPrompt(prompt: string): boolean {
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
  return ACTION_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSetupOnlyActionPrompt(prompt: string): boolean {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (
    /\b(add|capture|change|cover|fix|handle|implement|incorporate|preserve|refactor|remove|rename|replace|resolve|test|track|update|write)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    /\b(new\s+)?worktree\b/i.test(normalized) ||
    /\b(start|stop|restart)\s+(the\s+)?(dev\s+)?server\b/i.test(normalized) ||
    /\b(checkout|switch)\b.*\bbranch\b/i.test(normalized) ||
    /\bnew branch\b/i.test(normalized) ||
    /\b(open|create|push)\s+(a\s+)?pr\b/i.test(normalized) ||
    /\b(tag|release)\b/i.test(normalized)
  );
}

function buildScenarioRelevanceTerms(s: Scenario): string[] {
  const diffFiles = s.expected_diffstat
    ? parseDiffstatFiles(s.expected_diffstat).join(" ")
    : "";
  return unique([
    ...tokenizeRelevanceText(s.pr_title ?? ""),
    ...tokenizeRelevanceText(diffFiles),
  ]);
}

function tokenizeRelevanceText(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
    .flatMap((term) => term.split(/[-_/.]/))
    .map((term) => term.replace(/^-+|-+$/g, ""))
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
}

const GENERIC_RELEVANCE_TERMS = new Set([
  // Candidate ranking only: downweight high-frequency terms so prompt windows
  // are not selected merely for repo-wide vocabulary. For repositories where
  // these are domain terms, inspect the dry-run selection before executing.
  "code",
  "data",
  "file",
  "hook",
  "hooks",
  "install",
  "installed",
  "installer",
  "panopticon",
  "path",
  "repo",
  "request",
  "session",
  "sync",
  "test",
  "uninstall",
]);

function scorePromptRelevance(prompt: string, terms: string[]): number {
  const normalized = prompt.toLowerCase();
  let score = 0;
  for (const term of unique(terms)) {
    if (!normalized.includes(term)) continue;
    score += GENERIC_RELEVANCE_TERMS.has(term) || term.length <= 4 ? 1 : 4;
  }
  return score;
}

function scorePromptWindowRelevance(
  prompts: string[],
  actionIndex: number,
  terms: string[],
  actionContextPrompts: number,
): number {
  const startIndex = Math.max(0, actionIndex - actionContextPrompts);
  return prompts
    .slice(startIndex, actionIndex + 1)
    .reduce((sum, prompt) => sum + scorePromptRelevance(prompt, terms), 0);
}

function isClearCommandPrompt(prompt: string): boolean {
  return prompt.replace(/\s+/g, " ").trim().toLowerCase() === "/clear";
}

function writeResultJson(
  results: ScenarioResult[],
  args: Args,
  selectionSummary: SelectionSummary | null = null,
  fixtureLoadSummary: FixtureLoadSummary | null = null,
): void {
  if (!args.resultJson && !args.reportMarkdown) return;
  const generatedAt = new Date().toISOString();
  const aggregate = args.execute ? computeAggregate(results, args) : null;
  const payload = {
    generated_at: generatedAt,
    args: {
      arms: args.arms,
      limit: args.limit,
      max_prompts: args.maxPrompts,
      window_mode: args.windowMode,
      action_context_prompts: args.actionContextPrompts,
      action_followup_prompts: args.actionFollowupPrompts,
      pre_window_context_prompts: args.preWindowContextPrompts,
      only_measurable: args.onlyMeasurable,
      repository: args.repository,
      repo_root: args.repoRoot,
      fixture_dir: args.fixtureDir,
      fixture_file: args.fixtureFile,
      session_id: args.sessionId,
      pr_number: args.prNumber,
      report_markdown: args.reportMarkdown,
      prior_result_json: args.priorResultJson,
      candidate_label: args.minCandidateLabel,
      min_candidate_score: args.minCandidateScore,
      min_relevance_score: args.minRelevanceScore,
      max_expected_files: args.maxExpectedFiles,
      skip_prior_attempted: args.skipPriorAttempted,
      skip_prior_strict_ready: args.skipPriorStrictReady,
      rejudge: args.rejudge,
      execute: args.execute,
      skip_judge: args.skipJudge,
      judge_runner: args.judgeRunner,
      continue_after_failure: args.continueAfterFailure,
      timeout_ms: args.agentTimeoutMs,
    },
    fixture_load_summary: fixtureLoadSummary,
    selection_summary: selectionSummary,
    aggregate,
    results,
  };
  if (args.resultJson) {
    fs.mkdirSync(path.dirname(args.resultJson), { recursive: true });
    fs.writeFileSync(args.resultJson, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nWrote result JSON: ${args.resultJson}`);
  }
  if (args.reportMarkdown) {
    writeMarkdownReport(args.reportMarkdown, {
      generatedAt,
      sources: args.resultJson ? [args.resultJson] : [],
      args,
      fixtureLoadSummary,
      selectionSummary,
      aggregate,
      results,
    });
  }
}

async function recomputeResultJson(args: Args): Promise<void> {
  if (args.recomputeResultJson.length === 0) return;
  const inputFiles = expandRecomputeInputFiles(args.recomputeResultJson, {
    expandSources: args.rejudge,
  });
  if (inputFiles.length !== args.recomputeResultJson.length) {
    console.log(
      `Expanded recompute inputs: ${args.recomputeResultJson.length} file(s) -> ` +
        `${inputFiles.length} leaf source file(s)`,
    );
  }
  const inputs = inputFiles.map((filePath) => {
    const input = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      args?: Record<string, unknown>;
      aggregate?: unknown;
      results?: unknown;
    };
    if (!Array.isArray(input.results)) {
      throw new Error(`Result JSON has no results array: ${filePath}`);
    }
    return {
      filePath,
      input,
      sourceArgs: argsFromSerializedResultArgs(input.args, args),
    };
  });
  const rawResults = (
    await Promise.all(
      inputs.map(async ({ input, sourceArgs }) =>
        maybeRejudgeResults(
          enrichResultPromptWindows(
            input.results as ScenarioResult[],
            sourceArgs,
          ),
          sourceArgs,
          args,
        ),
      ),
    )
  ).flat();
  const serializedArms =
    inputs
      .map(({ input }) => parseSerializedArms(input.args?.arms))
      .find((arms): arms is ArmName[] => arms != null) ?? null;
  const executed = inputs.some(({ input }) => input.args?.execute === true);
  const aggregateArgs = {
    ...args,
    arms: serializedArms ?? args.arms,
    execute: executed,
  } as Args;
  const results = dedupeRecomputedResults(rawResults, aggregateArgs);
  if (results.length !== rawResults.length) {
    console.log(
      `Deduped recompute inputs: ${rawResults.length} result rows -> ` +
        `${results.length} unique scenario/window row(s)`,
    );
  }
  const aggregate = aggregateArgs.execute
    ? computeAggregate(results, aggregateArgs)
    : null;
  const recomputedAt = new Date().toISOString();
  const payload = {
    recomputed_at: recomputedAt,
    sources: inputs.map(({ filePath }) => filePath),
    args: {
      arms: aggregateArgs.arms,
      execute: aggregateArgs.execute,
      rejudge: args.rejudge,
      judge_runner: args.judgeRunner,
    },
    recompute_deduplication: {
      raw_result_count: rawResults.length,
      deduped_result_count: results.length,
      dropped_duplicate_count: rawResults.length - results.length,
    },
    aggregate,
    results,
  };
  printAggregateSummary(results.length, aggregate);
  if (args.resultJson) {
    fs.mkdirSync(path.dirname(args.resultJson), { recursive: true });
    fs.writeFileSync(args.resultJson, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Wrote recomputed result JSON: ${args.resultJson}`);
  }
  if (args.reportMarkdown) {
    writeMarkdownReport(args.reportMarkdown, {
      generatedAt: recomputedAt,
      sources: inputs.map(({ filePath }) => filePath),
      args: aggregateArgs,
      aggregate,
      results,
    });
  }
}

interface MarkdownReportInput {
  generatedAt: string;
  sources: string[];
  args: Args;
  fixtureLoadSummary?: FixtureLoadSummary | null;
  selectionSummary?: SelectionSummary | null;
  aggregate: AggregateMetrics | null;
  results: ScenarioResult[];
}

export function expandRecomputeInputFiles(
  filePaths: string[],
  opts: { expandSources: boolean },
): string[] {
  if (!opts.expandSources) return filePaths;
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const filePath of filePaths) {
    expandRecomputeInputFile(filePath, seen, expanded);
  }
  return expanded;
}

function expandRecomputeInputFile(
  filePath: string,
  seen: Set<string>,
  expanded: string[],
): void {
  const key = path.resolve(filePath);
  if (seen.has(key)) return;
  seen.add(key);
  let input: { sources?: unknown };
  try {
    input = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      sources?: unknown;
    };
  } catch {
    expanded.push(filePath);
    return;
  }
  const sources = Array.isArray(input.sources)
    ? input.sources.filter(
        (source): source is string => typeof source === "string",
      )
    : [];
  if (sources.length === 0) {
    expanded.push(filePath);
    return;
  }
  const resolvedSources = sources
    .map((source) => resolveResultSourcePath(source, filePath))
    .filter((source): source is string => source != null);
  if (resolvedSources.length !== sources.length) {
    expanded.push(filePath);
    return;
  }
  for (const source of resolvedSources) {
    expandRecomputeInputFile(source, seen, expanded);
  }
}

function resolveResultSourcePath(
  source: string,
  parentFilePath: string,
): string | null {
  if (fs.existsSync(source)) return source;
  const relativeToParent = path.resolve(path.dirname(parentFilePath), source);
  return fs.existsSync(relativeToParent) ? relativeToParent : null;
}

function writeMarkdownReport(
  filePath: string,
  input: MarkdownReportInput,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buildMarkdownReport(input));
  console.log(`Wrote markdown report: ${filePath}`);
}

export function buildMarkdownReport(input: MarkdownReportInput): string {
  const { aggregate, args, results } = input;
  const lines: string[] = [
    "# Panopticon Injection Replay A/B Report",
    "",
    `Generated: ${input.generatedAt}`,
    `Arms: ${args.arms.join(", ")}`,
    `Prompt window: ${formatReportPromptWindow(input)}`,
    `Scenarios: ${results.length}`,
  ];
  if (input.sources.length > 0) {
    lines.push(`Sources: ${input.sources.join(", ")}`);
  }
  const corpusSelectionLines = formatCorpusSelectionLines(input);
  if (corpusSelectionLines.length > 0) {
    lines.push("", "## Corpus Selection", "", ...corpusSelectionLines);
  }
  lines.push(
    "",
    "## Method",
    "",
    "- Replays historical PR-backed sessions from their captured `head_sha` in isolated worktrees.",
    "- Baseline defaults to `none`; treatment arms enable Panopticon injection and/or CRG context.",
    "- Reliable token/time deltas require every requested arm to complete, expose the expected injection surface, match the exact PR file set, and be judged accomplished.",
    "- `PreToolUse` file context is disabled in all arms for point-in-time fairness.",
    "",
  );
  if (!aggregate) {
    lines.push(
      "## Result",
      "",
      "No executed aggregate is available for this dry run.",
      "",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "## Gate Summary",
    "",
    `Baseline: ${aggregate.baselineArm}`,
    `Completed pairs: ${aggregate.completedCount}/${results.length}`,
    `Instrumented pairs: ${aggregate.instrumentedCount}/${results.length}`,
    `Exact PR-scope pairs: ${aggregate.prExactFileSetCount}/${results.length}`,
    `Paired scope metric pairs: ${aggregate.scopeMetricReadiness.pairedScopeCount}/${results.length}`,
    `Scope metric sample size: ${aggregate.scopeMetricReadiness.meetsRecommendedSampleSize ? "ok" : "low"} ` +
      `(recommended minimum ${aggregate.scopeMetricReadiness.recommendedMinimumPairs})`,
    `Strict token/time reduction pairs: ${aggregate.metricReadiness.pairedReductionCount}/${results.length}`,
    `Strict token/time sample size: ${aggregate.metricReadiness.meetsRecommendedSampleSize ? "ok" : "low"} ` +
      `(recommended minimum ${aggregate.metricReadiness.recommendedMinimumPairs})`,
    `Scope blockers: ${formatBlockerCounts(aggregate.scopeMetricReadiness.blockerCounts) || "none"}`,
    `Reduction blockers: ${formatBlockerCounts(aggregate.metricReadiness.blockerCounts) || "none"}`,
    "",
    "## Metric Conclusions",
    "",
    ...formatMetricConclusionLines(aggregate, results.length),
    "",
    "## Strict Token/Time Reduction",
    "",
  );
  if (aggregate.metricReadiness.pairedReductionCount === 0) {
    lines.push(
      "Not reported. No pair passed all reliability gates, so token/time deltas would compare different outcomes.",
      "",
    );
  } else {
    if (!aggregate.metricReadiness.reductionReady) {
      lines.push(
        `Not reported as reliable. Only ${aggregate.metricReadiness.pairedReductionCount} strict pair(s) passed all gates; ` +
          `minimum recommended sample size is ${aggregate.metricReadiness.recommendedMinimumPairs}.`,
        "",
        "Descriptive strict-pair deltas are shown below for inspection only.",
        "",
      );
    }
    lines.push(
      "| Arm | n | Mean Tokens | Median Tokens | Mean Time | Median Time |",
    );
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const delta of aggregate.armDeltas) {
      lines.push(
        `| ${delta.arm} vs ${aggregate.baselineArm} | ${delta.pairedCount} | ` +
          `${formatPct(delta.meanTokenDeltaPct)} | ${formatPct(delta.medianTokenDeltaPct)} | ` +
          `${formatPct(delta.meanDurationDeltaPct)} | ${formatPct(delta.medianDurationDeltaPct)} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## PR Scope Quality",
    "",
    "Reported when completed, instrumented PR-backed pairs have scope diagnostics on all requested arms. This remains valid even when strict token/time reduction is blocked.",
    "",
    "| Arm | Eligible | Covered | Exact | Exact Rate | 95% CI | Unexpected Mean |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const arm of aggregate.armScopeMetrics) {
    lines.push(
      `| ${arm.arm} | ${arm.prScopeEligibleCount} | ${arm.prFileCoveredCount} | ` +
        `${arm.prExactFileSetCount} | ${formatRate(arm.exactFileSetRate)} | ` +
        `${formatRateInterval(arm.exactFileSetRateWilson95)} | ` +
        `${formatNumber(arm.meanUnexpectedFileCount)} |`,
    );
  }
  lines.push(
    "",
    "## Scope Efficiency",
    "",
    "Descriptive cost per exact PR-scope success. This is not a strict token/time reduction metric unless the strict gates pass.",
    "",
    "| Arm | Attempt Tokens | Mean Exact Tokens | Tokens / Exact | Attempt Time | Mean Exact Time | Time / Exact |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const arm of aggregate.armScopeMetrics) {
    lines.push(
      `| ${arm.arm} | ${formatTokens(arm.totalAttemptTokens)} | ` +
        `${formatTokens(arm.meanExactTokens)} | ` +
        `${formatTokens(arm.tokensPerExactFileSet)} | ` +
        `${formatDurationMs(arm.totalAttemptDurationMs)} | ` +
        `${formatDurationMs(arm.meanExactDurationMs)} | ` +
        `${formatDurationMs(arm.durationMsPerExactFileSet)} |`,
    );
  }
  lines.push(
    "",
    "## Paired Scope Delta",
    "",
    "| Arm | n | Covered Rate | Covered Baseline | Covered Δ | Covered W/T/L | Exact Rate | Exact Baseline | Exact Δ | Exact W/T/L | Exact Win 95% CI | Recall Δ Mean | Recall Δ Median | Unexpected Δ Mean | Unexpected Δ Median |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const delta of aggregate.scopeDeltas) {
    lines.push(
      `| ${delta.arm} vs ${aggregate.baselineArm} | ${delta.pairedCount} | ` +
        `${formatRate(delta.armPrFileCoveredRate)} | ${formatRate(delta.baselinePrFileCoveredRate)} | ` +
        `${formatRateDeltaPp(delta.prFileCoveredRateDelta)} | ` +
        `${delta.prFileCoveredWins}/${delta.prFileCoveredTies}/${delta.prFileCoveredLosses} | ` +
        `${formatRate(delta.armExactFileSetRate)} | ${formatRate(delta.baselineExactFileSetRate)} | ` +
        `${formatRateDeltaPp(delta.exactFileSetRateDelta)} | ` +
        `${delta.exactFileSetWins}/${delta.exactFileSetTies}/${delta.exactFileSetLosses} | ` +
        `${formatRateInterval(delta.exactFileSetWinRateWilson95)} | ` +
        `${formatNumber(delta.meanFileRecallDelta)} | ` +
        `${formatNumber(delta.medianFileRecallDelta)} | ` +
        `${formatNumber(delta.meanUnexpectedFilesDelta)} | ` +
        `${formatNumber(delta.medianUnexpectedFilesDelta)} |`,
    );
  }
  lines.push(
    "",
    "## Scenario Gates",
    "",
    "| Session | PR | Turns | Candidate | Prior Replay | Scope Status | Scope Blockers | Strict Status | Strict Blockers | Replay Prompts |",
    "| --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const result of results) {
    const strictReadiness = aggregate.metricReadiness.scenarios.find(
      (scenario) => scenario.session_id === result.session_id,
    );
    const scopeReadiness = aggregate.scopeMetricReadiness.scenarios.find(
      (scenario) => scenario.session_id === result.session_id,
    );
    lines.push(
      `| ${result.session_id} | ${result.pr_number ?? ""} | ${result.promptStartTurn} | ` +
        `${formatCandidateForMarkdown(result.candidate)} | ` +
        `${formatPriorReplayOutcomeForMarkdown(result.priorOutcome)} | ` +
        `${scopeReadiness?.status ?? "unknown"} | ${(scopeReadiness?.blockers ?? []).join(", ") || "none"} | ` +
        `${strictReadiness?.status ?? "unknown"} | ${(strictReadiness?.blockers ?? []).join(", ") || "none"} | ` +
        `${formatPromptWindowForMarkdown(result.promptWindow)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatCorpusSelectionLines(input: MarkdownReportInput): string[] {
  const lines: string[] = [];
  const fixture = input.fixtureLoadSummary;
  if (fixture) {
    lines.push(
      `- Fixture source: ${fixture.source ?? "generated/sample"}`,
      `- Fixture rows: ${fixture.rawRowCount}`,
      `- Hydrated scenarios: ${fixture.loadedScenarioCount}`,
      `- Dropped fixture rows: ${fixture.droppedRowCount}`,
      `- Fixture drop reasons: ${formatBlockerCounts(fixture.droppedReasonCounts) || "none"}`,
    );
  }
  const selection = input.selectionSummary;
  if (selection) {
    lines.push(
      `- Candidate input scenarios: ${selection.rawScenarioCount}`,
      `- Non-measurable windows skipped: ${selection.nonMeasurableSkippedCount}`,
      `- Candidate-filtered scenarios: ${selection.candidateSkippedCount}`,
      `- Candidate filter reasons: ${formatBlockerCounts(selection.candidateSkippedReasonCounts) || "none"}`,
      `- Duplicate windows skipped: ${selection.duplicateWindowSkippedCount}`,
      `- Passed before limit: ${selection.candidatePassedCount}`,
      `- Limit: ${selection.limit}`,
      `- Limited out: ${selection.limitedOutCount}`,
      `- Selected scenarios: ${selection.selectedCount}`,
      "- Selection caveat: replay candidates are score-ranked toward small, PR-relevant action windows before `--limit` is applied, so exact-scope rates are not corpus-representative.",
      "- Relevance caveat: prompt-window scoring downweights short/common terms; in domain-specific repositories those terms may still be meaningful, so inspect selected windows before execution.",
    );
  }
  return lines;
}

function formatMetricConclusionLines(
  aggregate: AggregateMetrics,
  resultCount: number,
): string[] {
  const lines: string[] = [];
  if (aggregate.scopeMetricReadiness.scopeReady) {
    lines.push(
      `- Reliable PR-scope A/B metric: reported with ${aggregate.scopeMetricReadiness.pairedScopeCount}/${resultCount} paired scope sample(s).`,
      "- Primary scope tables compare expected PR-file coverage, exact file-set rate, unexpected-file count, and paired W/T/L.",
    );
  } else {
    lines.push(
      `- Reliable PR-scope A/B metric: not reported; only ${aggregate.scopeMetricReadiness.pairedScopeCount}/${resultCount} paired scope sample(s) passed gates.`,
    );
  }
  if (aggregate.metricReadiness.reductionReady) {
    lines.push(
      `- Reliable strict token/time A/B metric: reported with ${aggregate.metricReadiness.pairedReductionCount}/${resultCount} strict pair(s).`,
    );
  } else {
    lines.push(
      `- Reliable strict token/time A/B metric: not reported; only ${aggregate.metricReadiness.pairedReductionCount}/${resultCount} strict pair(s) passed exact-scope and outcome gates.`,
    );
  }
  for (const delta of aggregate.scopeDeltas) {
    lines.push(
      `- ${delta.arm} vs ${aggregate.baselineArm} PR-scope signal: ` +
        `exact ${formatRate(delta.armExactFileSetRate)} vs ` +
        `${formatRate(delta.baselineExactFileSetRate)} ` +
        `(${formatRateDeltaPp(delta.exactFileSetRateDelta)}), ` +
        `exact W/T/L ${delta.exactFileSetWins}/${delta.exactFileSetTies}/${delta.exactFileSetLosses}, ` +
        `recall mean/median delta ${formatNumber(delta.meanFileRecallDelta)}/${formatNumber(delta.medianFileRecallDelta)}, ` +
        `unexpected-file mean/median delta ${formatNumber(delta.meanUnexpectedFilesDelta)}/${formatNumber(delta.medianUnexpectedFilesDelta)}.`,
    );
  }
  return lines;
}

function formatReportPromptWindow(input: MarkdownReportInput): string {
  if (input.sources.length > 1) {
    return "combined/recomputed; see scenario gate rows";
  }
  return (
    formatUniformPromptWindowSummary(input.results) ??
    promptLimitLabel(input.args)
  );
}

function formatUniformPromptWindowSummary(
  results: ScenarioResult[],
): string | null {
  if (results.length === 0) return null;
  const windows = results
    .map((result) => result.promptWindow)
    .filter((window): window is PromptWindowTrace => window != null);
  if (windows.length !== results.length) return null;
  const modes = unique(windows.map((window) => window.mode));
  const promptCounts = unique(windows.map((window) => window.promptCount));
  const preWindowCounts = unique(
    windows.map((window) => window.preWindowContext.promptCount),
  );
  if (
    modes.length !== 1 ||
    promptCounts.length !== 1 ||
    preWindowCounts.length !== 1
  ) {
    return "mixed windows; see scenario gate rows";
  }
  const promptCount = promptCounts[0];
  const preWindowCount = preWindowCounts[0];
  return [
    `${modes[0]} window`,
    `${promptCount} replay prompt${promptCount === 1 ? "" : "s"} per scenario`,
    preWindowCount > 0
      ? `${preWindowCount} neutral pre-window prompt${preWindowCount === 1 ? "" : "s"}`
      : null,
    "see scenario gate rows",
  ]
    .filter((part): part is string => part != null)
    .join("; ");
}

function formatCandidateForMarkdown(
  candidate: CandidateAssessment | undefined,
) {
  if (!candidate) return "";
  return `${candidate.label} ${candidate.score}/100`;
}

function formatPriorReplayOutcomeForMarkdown(
  outcome: PriorReplayOutcome | null | undefined,
) {
  return outcome ? formatPriorReplayOutcome(outcome) : "";
}

function formatPromptWindowForMarkdown(
  window: PromptWindowTrace | undefined,
): string {
  if (!window) return "";
  return window.prompts
    .map((prompt) => `turn ${prompt.turn}: ${oneLine(prompt.text, 70)}`)
    .join("<br>");
}

function parseSerializedArms(value: unknown): ArmName[] | null {
  if (!Array.isArray(value)) return null;
  const arms = value.filter(
    (arm): arm is ArmName => typeof arm === "string" && arm in ARM_CONFIGS,
  );
  return arms.length > 0 ? [...new Set(arms)] : null;
}

function argsFromSerializedResultArgs(
  serialized: Record<string, unknown> | undefined,
  fallback: Args,
): Args {
  if (!serialized) return fallback;
  return {
    ...fallback,
    arms: parseSerializedArms(serialized.arms) ?? fallback.arms,
    maxPrompts: parseSerializedMaxPrompts(serialized.max_prompts, fallback),
    windowMode: parseSerializedWindowMode(serialized.window_mode, fallback),
    actionContextPrompts: parseSerializedNonNegativeInt(
      serialized.action_context_prompts,
      fallback.actionContextPrompts,
    ),
    actionFollowupPrompts: parseSerializedNonNegativeInt(
      serialized.action_followup_prompts,
      fallback.actionFollowupPrompts,
    ),
    preWindowContextPrompts: parseSerializedNonNegativeInt(
      serialized.pre_window_context_prompts,
      fallback.preWindowContextPrompts,
    ),
    repository:
      typeof serialized.repository === "string"
        ? serialized.repository
        : fallback.repository,
    repoRoot:
      typeof serialized.repo_root === "string"
        ? serialized.repo_root
        : fallback.repoRoot,
    fixtureDir:
      typeof serialized.fixture_dir === "string"
        ? serialized.fixture_dir
        : fallback.fixtureDir,
    fixtureFile:
      typeof serialized.fixture_file === "string"
        ? serialized.fixture_file
        : fallback.fixtureFile,
    sessionId:
      typeof serialized.session_id === "string"
        ? serialized.session_id
        : fallback.sessionId,
    prNumber: parseSerializedPositiveInt(
      serialized.pr_number,
      fallback.prNumber,
    ),
    minCandidateLabel: parseSerializedCandidateLabel(
      serialized.candidate_label,
      fallback.minCandidateLabel,
    ),
    minCandidateScore: parseSerializedNullableNumber(
      serialized.min_candidate_score,
      fallback.minCandidateScore,
    ),
    minRelevanceScore: parseSerializedNullableNumber(
      serialized.min_relevance_score,
      fallback.minRelevanceScore,
    ),
    maxExpectedFiles: parseSerializedPositiveInt(
      serialized.max_expected_files,
      fallback.maxExpectedFiles,
    ),
    skipPriorAttempted:
      typeof serialized.skip_prior_attempted === "boolean"
        ? serialized.skip_prior_attempted
        : fallback.skipPriorAttempted,
    skipPriorStrictReady:
      typeof serialized.skip_prior_strict_ready === "boolean"
        ? serialized.skip_prior_strict_ready
        : fallback.skipPriorStrictReady,
    rejudge:
      typeof serialized.rejudge === "boolean"
        ? serialized.rejudge
        : fallback.rejudge,
    execute:
      typeof serialized.execute === "boolean"
        ? serialized.execute
        : fallback.execute,
    skipJudge:
      typeof serialized.skip_judge === "boolean"
        ? serialized.skip_judge
        : fallback.skipJudge,
    judgeRunner: parseSerializedJudgeRunner(
      serialized.judge_runner,
      fallback.judgeRunner,
    ),
    continueAfterFailure:
      typeof serialized.continue_after_failure === "boolean"
        ? serialized.continue_after_failure
        : fallback.continueAfterFailure,
    agentTimeoutMs:
      typeof serialized.timeout_ms === "number"
        ? serialized.timeout_ms
        : fallback.agentTimeoutMs,
  };
}

function parseSerializedMaxPrompts(
  value: unknown,
  fallback: Args,
): number | null {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback.maxPrompts;
}

function parseSerializedWindowMode(
  value: unknown,
  fallback: Args,
): PromptWindowMode {
  return typeof value === "string" && isPromptWindowMode(value)
    ? value
    : fallback.windowMode;
}

function parseSerializedNonNegativeInt(
  value: unknown,
  fallback: number,
): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function parseSerializedPositiveInt(
  value: unknown,
  fallback: number | null,
): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function parseSerializedNullableNumber(
  value: unknown,
  fallback: number | null,
): number | null {
  return typeof value === "number" ? value : fallback;
}

function parseSerializedCandidateLabel(
  value: unknown,
  fallback: CandidateAssessment["label"] | null,
): CandidateAssessment["label"] | null {
  return value === "weak" || value === "medium" || value === "strong"
    ? value
    : fallback;
}

function parseSerializedJudgeRunner(
  value: unknown,
  fallback: JudgeRunner,
): JudgeRunner {
  return value === "claude" || value === "codex" ? value : fallback;
}

function enrichResultPromptWindows(
  results: ScenarioResult[],
  sourceArgs: Args,
): ScenarioResult[] {
  if (!sourceArgs.fixtureFile || !fs.existsSync(sourceArgs.fixtureFile)) {
    return results;
  }
  const scenarios = (
    JSON.parse(fs.readFileSync(sourceArgs.fixtureFile, "utf-8")) as Scenario[]
  ).map((scenario) => applyPromptLimit(scenario, sourceArgs));
  return results.map((result) => {
    const scenario = findMatchingScenarioForResult(scenarios, result);
    if (!scenario) {
      return result;
    }
    const promptWindow =
      result.promptWindow ?? buildPromptWindowTrace(scenario, sourceArgs);
    return {
      ...result,
      candidate: assessReplayCandidate(scenario),
      promptWindow,
    };
  });
}

function findMatchingScenarioForResult(
  scenarios: Scenario[],
  result: ScenarioResult,
): Scenario | null {
  const promptStartTurn =
    result.promptWindow?.promptStartTurn ?? result.promptStartTurn;
  return (
    scenarios.find(
      (scenario) =>
        scenario.session_id === result.session_id &&
        (result.pr_number == null || scenario.pr_number === result.pr_number) &&
        (scenario.original_prompt_offset ?? 0) + 1 === promptStartTurn,
    ) ??
    scenarios.find(
      (scenario) =>
        scenario.session_id === result.session_id &&
        (result.pr_number == null || scenario.pr_number === result.pr_number),
    ) ??
    scenarios.find((scenario) => scenario.session_id === result.session_id) ??
    null
  );
}

async function maybeRejudgeResults(
  results: ScenarioResult[],
  sourceArgs: Args,
  targetArgs: Args,
): Promise<ScenarioResult[]> {
  if (!targetArgs.rejudge) return results;
  const scenarios = loadFixtureScenariosForArgs(sourceArgs);
  if (scenarios.size === 0) return results;
  const judgeArgs = {
    ...sourceArgs,
    judgeModel: targetArgs.judgeModel ?? sourceArgs.judgeModel,
    judgeRunner: targetArgs.judgeRunner ?? sourceArgs.judgeRunner,
  };
  const next: ScenarioResult[] = [];
  for (const result of results) {
    const scenario = scenarios.get(result.session_id);
    const arms = orderedArms(sourceArgs)
      .map((arm) => result.arms[arm])
      .filter((armResult): armResult is ArmResult => armResult != null);
    if (!scenario || arms.length !== orderedArms(sourceArgs).length) {
      next.push(result);
      continue;
    }
    if (!canRejudgeResult(result, sourceArgs)) {
      next.push(result);
      continue;
    }
    const verdict = await judge(scenario, arms, judgeArgs);
    next.push({
      ...result,
      verdicts: verdict.verdicts,
      judgeNotes: `rejudged: ${verdict.notes}`,
    });
  }
  return next;
}

function loadFixtureScenariosForArgs(args: Args): Map<string, Scenario> {
  if (!args.fixtureFile || !fs.existsSync(args.fixtureFile)) return new Map();
  const scenarios = (
    JSON.parse(fs.readFileSync(args.fixtureFile, "utf-8")) as Scenario[]
  ).map((scenario) => applyPromptLimit(scenario, args));
  return new Map(scenarios.map((scenario) => [scenario.session_id, scenario]));
}

function canRejudgeResult(result: ScenarioResult, args: Args): boolean {
  return computeScenarioScopeMetricReadiness(result, args).status === "ready";
}

function printAggregateSummary(
  scenarioCount: number,
  aggregate: AggregateMetrics | null,
): void {
  if (!aggregate) {
    console.log(
      `Recomputed aggregate: n/a (${scenarioCount} dry-run scenario(s), no executed arms)`,
    );
    return;
  }
  console.log(
    `Recomputed aggregate: ${scenarioCount} scenarios, ` +
      `${aggregate.completedCount} completed, ` +
      `${aggregate.instrumentedCount} instrumented, ` +
      `${aggregate.prFileCoveredCount} PR-file-covered, ` +
      `${aggregate.prExactFileSetCount} exact PR file-set, ` +
      `${aggregate.comparableCount} comparable`,
  );
  console.log(
    `  reduction readiness: ` +
      `${aggregate.metricReadiness.reductionReady ? "ready" : "not ready"} ` +
      `${aggregate.metricReadiness.pairedReductionCount}/` +
      `${aggregate.metricReadiness.gates.totalScenarios} strict pair(s) ready ` +
      `(recommended minimum ${aggregate.metricReadiness.recommendedMinimumPairs}; ` +
      `sample-size ${aggregate.metricReadiness.meetsRecommendedSampleSize ? "ok" : "low"})`,
  );
  console.log(
    `  scope readiness: ` +
      `${aggregate.scopeMetricReadiness.scopeReady ? "ready" : "not ready"} ` +
      `${aggregate.scopeMetricReadiness.pairedScopeCount}/` +
      `${aggregate.scopeMetricReadiness.gates.totalScenarios} paired scope sample(s) ready ` +
      `(recommended minimum ${aggregate.scopeMetricReadiness.recommendedMinimumPairs}; ` +
      `sample-size ${aggregate.scopeMetricReadiness.meetsRecommendedSampleSize ? "ok" : "low"})`,
  );
  const blockerSummary = formatBlockerCounts(
    aggregate.metricReadiness.blockerCounts,
  );
  if (blockerSummary) {
    console.log(`  reduction blockers: ${blockerSummary}`);
  }
  const scopeBlockerSummary = formatBlockerCounts(
    aggregate.scopeMetricReadiness.blockerCounts,
  );
  if (scopeBlockerSummary) {
    console.log(`  scope blockers: ${scopeBlockerSummary}`);
  }
  for (const arm of aggregate.armDeltas) {
    console.log(
      `  ${arm.arm} vs ${aggregate.baselineArm}: n=${arm.pairedCount} ` +
        `tokens mean ${formatPct(arm.meanTokenDeltaPct)} ` +
        `median ${formatPct(arm.medianTokenDeltaPct)}; ` +
        `time mean ${formatPct(arm.meanDurationDeltaPct)} ` +
        `median ${formatPct(arm.medianDurationDeltaPct)}`,
    );
  }
  for (const arm of aggregate.armScopeMetrics) {
    console.log(
      `  scope ${arm.arm}: eligible=${arm.prScopeEligibleCount} ` +
        `covered=${arm.prFileCoveredCount} exact=${arm.prExactFileSetCount} ` +
        `rate=${formatRate(arm.exactFileSetRate)} ` +
        `ci95=${formatRateInterval(arm.exactFileSetRateWilson95)} ` +
        `exact_tokens mean=${formatTokens(arm.meanExactTokens)} ` +
        `tokens_per_exact=${formatTokens(arm.tokensPerExactFileSet)} ` +
        `exact_time mean=${formatDurationMs(arm.meanExactDurationMs)} ` +
        `time_per_exact=${formatDurationMs(arm.durationMsPerExactFileSet)} ` +
        `unexpected mean=${formatNumber(arm.meanUnexpectedFileCount)}`,
    );
  }
  for (const delta of aggregate.scopeDeltas) {
    console.log(
      `  scope ${delta.arm} vs ${aggregate.baselineArm}: ` +
        `covered rate ${formatRate(delta.armPrFileCoveredRate)} vs ` +
        `${formatRate(delta.baselinePrFileCoveredRate)} ` +
        `(${formatRateDeltaPp(delta.prFileCoveredRateDelta)}); ` +
        `exact rate ${formatRate(delta.armExactFileSetRate)} vs ` +
        `${formatRate(delta.baselineExactFileSetRate)} ` +
        `(${formatRateDeltaPp(delta.exactFileSetRateDelta)}); ` +
        `win_ci95=${formatRateInterval(delta.exactFileSetWinRateWilson95)} ` +
        `n=${delta.pairedCount} exact wins/ties/losses=` +
        `${delta.exactFileSetWins}/${delta.exactFileSetTies}/` +
        `${delta.exactFileSetLosses} unexpected Δ mean=` +
        `${formatNumber(delta.meanUnexpectedFilesDelta)} median=` +
        `${formatNumber(delta.medianUnexpectedFilesDelta)} recall Δ mean=` +
        `${formatNumber(delta.meanFileRecallDelta)} median=` +
        `${formatNumber(delta.medianFileRecallDelta)}`,
    );
  }
}

// Last commit on the recorded branch at/before the session start. Used
// only when there is no exact head_sha (historical sessions); state is
// approximate — a dirty working tree at session start is unrecoverable.
function resolveCommitAt(
  repoRoot: string,
  branch: string | null,
  startedAtMs: number,
): string | null {
  const beforeIso = new Date(startedAtMs).toISOString();
  for (const ref of [branch, "HEAD"]) {
    if (!ref) continue;
    try {
      const sha = execFileSync(
        "git",
        ["-C", repoRoot, "rev-list", "-1", `--before=${beforeIso}`, ref],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (sha) return sha;
    } catch {
      // ref not found locally — try the next
    }
  }
  return null;
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    limit: DEFAULT_LIMIT,
    repository: DEFAULT_REPOSITORY,
    repoRoot: DEFAULT_REPO_ROOT,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    fixtureFile: null,
    sessionId: null,
    prNumber: null,
    maxPrompts: DEFAULT_MAX_PROMPTS,
    windowMode: "prefix",
    actionContextPrompts: 1,
    actionFollowupPrompts: 1,
    preWindowContextPrompts: 0,
    onlyMeasurable: false,
    resultJson: null,
    reportMarkdown: null,
    recomputeResultJson: [],
    priorResultJson: [],
    minCandidateLabel: null,
    minCandidateScore: null,
    minRelevanceScore: null,
    maxExpectedFiles: null,
    skipPriorAttempted: false,
    skipPriorStrictReady: false,
    rejudge: false,
    execute: false,
    skipJudge: false,
    continueAfterFailure: false,
    judgeModel: null,
    judgeRunner: "claude",
    agentTimeoutMs: AGENT_TIMEOUT_MS,
    arms: DEFAULT_ARMS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      parsed.limit = Number(argv[++i]);
    } else if (arg === "--repository") {
      parsed.repository = argv[++i];
    } else if (arg === "--repo-root") {
      parsed.repoRoot = argv[++i];
    } else if (arg === "--fixture-dir") {
      parsed.fixtureDir = argv[++i];
    } else if (arg === "--fixture-file") {
      parsed.fixtureFile = argv[++i];
    } else if (arg === "--session-id") {
      parsed.sessionId = argv[++i];
    } else if (arg === "--pr-number") {
      parsed.prNumber = parsePositiveInt(argv[++i], "--pr-number");
    } else if (arg === "--max-prompts") {
      parsed.maxPrompts = parseMaxPrompts(argv[++i]);
    } else if (arg === "--action-pair") {
      parsed.windowMode = "around-relevant-action";
      parsed.actionContextPrompts = 1;
      parsed.actionFollowupPrompts = 0;
      parsed.maxPrompts = 2;
    } else if (arg === "--window-mode") {
      parsed.windowMode = parseWindowMode(argv[++i]);
    } else if (arg === "--action-context-prompts") {
      parsed.actionContextPrompts = parseNonNegativeInt(
        argv[++i],
        "--action-context-prompts",
      );
    } else if (arg === "--action-followup-prompts") {
      parsed.actionFollowupPrompts = parseNonNegativeInt(
        argv[++i],
        "--action-followup-prompts",
      );
    } else if (arg === "--pre-window-context-prompts") {
      parsed.preWindowContextPrompts = parseNonNegativeInt(
        argv[++i],
        "--pre-window-context-prompts",
      );
    } else if (arg === "--only-measurable") {
      parsed.onlyMeasurable = true;
    } else if (arg === "--result-json") {
      parsed.resultJson = argv[++i];
    } else if (arg === "--report-markdown") {
      parsed.reportMarkdown = argv[++i];
    } else if (arg === "--recompute-result-json") {
      parsed.recomputeResultJson.push(...parsePathList(argv[++i]));
    } else if (arg === "--prior-result-json") {
      parsed.priorResultJson.push(...parsePathList(argv[++i]));
    } else if (arg === "--candidate-label") {
      parsed.minCandidateLabel = parseCandidateLabel(argv[++i]);
    } else if (arg === "--min-candidate-score") {
      parsed.minCandidateScore = parseBoundedScore(
        argv[++i],
        "--min-candidate-score",
      );
    } else if (arg === "--min-relevance-score") {
      parsed.minRelevanceScore = parseBoundedScore(
        argv[++i],
        "--min-relevance-score",
      );
    } else if (arg === "--max-expected-files") {
      parsed.maxExpectedFiles = parsePositiveInt(
        argv[++i],
        "--max-expected-files",
      );
    } else if (arg === "--skip-prior-attempted") {
      parsed.skipPriorAttempted = true;
    } else if (arg === "--skip-prior-strict-ready") {
      parsed.skipPriorStrictReady = true;
    } else if (arg === "--rejudge") {
      parsed.rejudge = true;
    } else if (arg === "--judge-model") {
      parsed.judgeModel = argv[++i];
    } else if (arg === "--judge-runner") {
      parsed.judgeRunner = parseJudgeRunner(argv[++i]);
    } else if (arg === "--timeout-ms") {
      parsed.agentTimeoutMs = parsePositiveInt(argv[++i], "--timeout-ms");
    } else if (arg === "--arms") {
      parsed.arms = parseArms(argv[++i]);
    } else if (arg === "--execute") {
      parsed.execute = true;
    } else if (arg === "--skip-judge") {
      parsed.skipJudge = true;
    } else if (arg === "--continue-after-failure") {
      parsed.continueAfterFailure = true;
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
  if (parsed.arms.length === 0) {
    throw new Error("--arms expects at least one arm");
  }
  if (parsed.maxPrompts != null && parsed.maxPrompts <= 0) {
    throw new Error("--max-prompts expects a positive integer or 'all'");
  }
  if (
    isAroundActionWindowMode(parsed.windowMode) &&
    parsed.actionContextPrompts === 0
  ) {
    throw new Error(
      "--window-mode around-action requires --action-context-prompts >= 1 so UserPromptSubmit can be measured",
    );
  }
  if (
    isAroundActionWindowMode(parsed.windowMode) &&
    parsed.maxPrompts != null &&
    parsed.maxPrompts <= parsed.actionContextPrompts
  ) {
    throw new Error(
      "--max-prompts must be greater than --action-context-prompts for around-action windows",
    );
  }
  return parsed;
}

function isAroundActionWindowMode(mode: PromptWindowMode): boolean {
  return mode === "around-action" || mode === "around-relevant-action";
}

function parseWindowMode(value: string | undefined): PromptWindowMode {
  if (isPromptWindowMode(value)) {
    return value;
  }
  throw new Error(
    "--window-mode expects 'prefix', 'around-action', or 'around-relevant-action'",
  );
}

function isPromptWindowMode(value: unknown): value is PromptWindowMode {
  return (
    value === "prefix" ||
    value === "around-action" ||
    value === "around-relevant-action"
  );
}

function parseNonNegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} expects a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer`);
  }
  return parsed;
}

function parseBoundedScore(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${flag} expects an integer from 0 to 100`);
  }
  return parsed;
}

function parseCandidateLabel(
  value: string | undefined,
): CandidateAssessment["label"] {
  if (value === "weak" || value === "medium" || value === "strong") {
    return value;
  }
  throw new Error("--candidate-label expects weak, medium, or strong");
}

function parseJudgeRunner(value: string | undefined): JudgeRunner {
  if (value === "claude" || value === "codex") return value;
  throw new Error("--judge-runner expects claude or codex");
}

function parseMaxPrompts(value: string | undefined): number | null {
  if (!value) throw new Error("--max-prompts expects a value");
  if (value === "all") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--max-prompts expects a positive integer or 'all'");
  }
  return parsed;
}

function parsePathList(value: string | undefined): string[] {
  if (!value) throw new Error("--recompute-result-json expects a path");
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseArms(value: string | undefined): ArmName[] {
  if (!value) throw new Error("--arms expects a comma-separated list");
  const arms = value
    .split(",")
    .map((arm) => arm.trim())
    .filter((arm) => arm.length > 0);
  for (const arm of arms) {
    if (!(arm in ARM_CONFIGS)) {
      throw new Error(
        `Unknown arm "${arm}". Expected one of: ${Object.keys(ARM_CONFIGS).join(", ")}`,
      );
    }
  }
  return [...new Set(arms)] as ArmName[];
}

export function buildReplayExcludeSessionIds(
  historicalSessionId: string,
  priorReplaySessionIds: string[],
  ...currentArmReplaySessionIds: string[]
): string[] {
  return unique(
    [
      historicalSessionId,
      ...priorReplaySessionIds,
      ...currentArmReplaySessionIds,
    ].filter(
      (sessionId): sessionId is string =>
        typeof sessionId === "string" && sessionId.length > 0,
    ),
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printHelp(): void {
  console.log(`Usage: pnpm eval:replay -- [options]

Reconstructs each session at its captured head_sha and replays its
prompts through a headless agent for each requested arm, then an LLM
judge decides goal-equivalence.

Options:
  --limit N          Scenarios sampled (default: ${DEFAULT_LIMIT})
  --repository SLUG   Repository filter (default: ${DEFAULT_REPOSITORY})
  --repo-root PATH    Local git repo to make worktrees from
  --fixture-dir PATH  Scenario fixture directory
  --fixture-file PATH Read scenarios from a specific JSON file
  --session-id ID     Run only one scenario from the fixture
  --pr-number N       Run only one PR oracle from the fixture
  --max-prompts N     Replay only the first N prompts; use "all" for full
                      historical replay (default: ${DEFAULT_MAX_PROMPTS})
  --action-pair       Preset for reliable PR-scope replays:
                      --window-mode around-relevant-action
                      --action-context-prompts 1
                      --action-followup-prompts 0
                      --max-prompts 2
  --window-mode MODE  Prompt window: prefix, around-action, or
                      around-relevant-action (default: prefix).
                      around-action keeps historical prompt(s) before the first
                      likely mid-session action prompt.
                      around-relevant-action prefers action prompts matching
                      PR title/diffstat terms, avoiding long unrelated prefixes.
  --action-context-prompts N
                      Prompts before the action in around-action mode (default: 1)
  --action-followup-prompts N
                      Prompts after the action in around-action mode (default: 1)
  --pre-window-context-prompts N
                      Add up to N prompts before the selected replay window as
                      neutral first-turn context for every arm. Context is not
                      replayed as instructions (default: 0)
  --only-measurable   Skip bounded windows without a likely mid-session action
                      prompt, so runs are less likely to spend on unjudgeable
                      discovery-only prefixes
  --result-json PATH  Write raw per-turn/per-arm metrics and aggregate JSON
  --report-markdown PATH
                      Write a concise markdown report from executed or
                      recomputed results.
  --recompute-result-json PATH
                      Re-score one or more existing result JSON files with the
                      current aggregate reliability gates. Repeat the flag or
                      pass comma-separated paths. Use --result-json to write a
                      combined recomputed copy.
  --rejudge           With --recompute-result-json, rerun the LLM judge for
                      completed, instrumented PR-scope-ready rows using the
                      current judge rubric and source fixture.
  --prior-result-json PATH
                      Overlay prior executed outcomes onto dry-run candidates.
                      Repeat the flag or pass comma-separated paths.
  --candidate-label LEVEL
                      Keep candidates at or above LEVEL: weak, medium, strong.
                      Use strong for expensive runs targeting strict PR-scope
                      metrics.
  --min-candidate-score N
                      Keep candidates scoring at least N out of 100.
  --min-relevance-score N
                      Keep only prompt windows with PR title/diffstat relevance
                      score at least N. Useful before expensive live replays.
  --max-expected-files N
                      Keep only merged-PR oracles touching N or fewer files.
  --skip-prior-attempted
                      Skip scenarios that already have a compatible executed
                      prior attempt in --prior-result-json overlays.
  --skip-prior-strict-ready
                      Skip only scenarios with a compatible prior attempt that
                      passes the current strict token/time metric gates.
  --judge-model M     Model for the LLM judge
  --judge-runner R    Runner for the LLM judge: claude or codex
                      (default: claude)
  --arms LIST         Comma-separated arms: none,panop,crg,panop+crg
                      (default: ${DEFAULT_ARMS.join(",")})
  --execute           Actually spawn the replay agents (EXPENSIVE).
                      Default is a dry-run (plan only, no agent spawn).
  --skip-judge        Execute arms but skip the LLM judge; useful only for
                      harness smoke tests, not reliable reduction metrics.
  --continue-after-failure
                      Continue running remaining arms after the baseline arm
                      cannot produce comparable metrics. Default stops early.
  --help, -h          Show this help

Manual benchmark — not CI. Agent runs are stochastic and token-costly.`);
}

if (isDirectRun()) {
  main()
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exitCode = 1;
    })
    .finally(() => {
      closeDb();
    });
}
