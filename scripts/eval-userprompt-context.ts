#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import type { SessionSummaryRunnerName } from "../src/config.js";
import { closeDb, getDb } from "../src/db/schema.js";
import {
  buildSessionStartRecentHistoryContext,
  buildUserPromptSubmitLocalContext,
} from "../src/hooks/session-context.js";
import {
  inferRunnerFromSessionTarget,
  isSummaryRunnerName,
} from "../src/session_summaries/policy.js";
import { invokeLlmAsync } from "../src/summary/llm.js";

type EvalSet = "first" | "later";

interface Args {
  set: EvalSet | "both";
  limit: number;
  fixtureDir: string;
  refresh: boolean;
  verbose: boolean;
  json: boolean;
  llmJudge: boolean;
  judgeRunner: SessionSummaryRunnerName | null;
  judgeModel: string | null;
  judgeLimit: number | null;
  judgeTimeoutMs: number;
  judgeMaxChars: number;
  judgeDryRun: boolean;
  writeLabelTemplate: boolean;
}

interface PromptFixture {
  generatedAt: string;
  set: EvalSet;
  limit: number;
  prompts: EvalPrompt[];
}

interface EvalPrompt {
  id: number;
  sessionId: string;
  timestampMs: number;
  target: string | null;
  project: string | null;
  cwd: string | null;
  repository: string | null;
  promptIndex: number;
  promptCount: number;
  prompt: string;
}

interface EvalResult {
  set: EvalSet;
  ordinal: number;
  prompt: EvalPrompt;
  userPromptSessionIds: string[];
  sessionStartSessionIds: string[];
  overlapSessionIds: string[];
  userPromptLines: string[];
  sessionStartLines: string[];
  usefulness: ContextUsefulnessAssessment;
  labelAssessment: LabelAssessment;
  llmJudge: LlmJudgeAssessment | null;
}

type UsefulnessLevel = "none" | "low" | "medium" | "high";

interface ContextUsefulnessAssessment {
  level: UsefulnessLevel;
  score: number;
  itemCount: number;
  usefulHitCount: number;
  lowValueHitCount: number;
  duplicateHitCount: number;
  precisionLike: number | null;
  reasons: string[];
  items: ContextItemUsefulnessAssessment[];
}

interface ContextItemUsefulnessAssessment {
  sessionId: string;
  level: Exclude<UsefulnessLevel, "none">;
  score: number;
  matchedTerms: string[];
  specificMatchedTerms: string[];
  strongMatchedTerms: string[];
  reasons: string[];
  line: string;
}

interface AssessmentTerm {
  term: string;
  weight: number;
  strong: boolean;
  index: number;
}

type JudgeUtilityLevel = "none" | "low" | "medium" | "high";
type JudgeItemUtility = "irrelevant" | "weak" | "useful" | "critical";
type JudgeRecommendedAction =
  | "keep"
  | "tighten"
  | "broaden"
  | "label_for_review";

interface LlmJudgeAssessment {
  status: "skipped" | "ok" | "failed";
  runner: SessionSummaryRunnerName | null;
  model: string | null;
  error?: string;
  judgePrompt?: string;
  rawOutput?: string;
  outcome: SubsequentActivity;
  result?: LlmJudgeResult;
}

interface LlmJudgeResult {
  overallUtility: JudgeUtilityLevel;
  score: number;
  rationale: string;
  items: LlmJudgeItemResult[];
  missedContext: LlmJudgeMissedContext[];
  recommendedAction: JudgeRecommendedAction;
}

interface LlmJudgeItemResult {
  sessionId: string;
  utility: JudgeItemUtility;
  reason: string;
  evidence: string;
}

interface LlmJudgeMissedContext {
  query: string;
  reason: string;
  evidence: string;
}

type LabelReviewStatus = "unreviewed" | "llm_draft" | "human_reviewed";
type ExpectedPanopticonKind = "session" | "query" | "none";
type ExpectedPanopticonUtility = "weak" | "useful" | "critical";
type ExpectedPanopticonSource = "human" | "llm" | "placeholder";

interface EvalLabelFile {
  generatedAt: string;
  set: EvalSet;
  labels: EvalPromptLabel[];
}

interface EvalPromptLabel {
  promptKey: string;
  eventId: number;
  sessionId: string;
  promptIndex: number;
  timestamp: string;
  target: string | null;
  project: string | null;
  cwd: string | null;
  repository: string | null;
  prompt: string;
  reviewStatus: LabelReviewStatus;
  whatHappened: string[];
  injectedContext: string[];
  expectedUsefulPanopticon: ExpectedUsefulPanopticonData[];
  noUsefulPanopticonExpected: boolean | null;
  notes: string;
}

interface ExpectedUsefulPanopticonData {
  kind: ExpectedPanopticonKind;
  utility: ExpectedPanopticonUtility;
  source: ExpectedPanopticonSource;
  sessionId?: string;
  query?: string;
  reason: string;
  evidence?: string;
}

interface LabelAssessment {
  status: "unlabeled" | "labeled";
  reviewStatus: LabelReviewStatus | null;
  expectedSessionIds: string[];
  injectedExpectedSessionIds: string[];
  missedExpectedSessionIds: string[];
  unexpectedInjectedSessionIds: string[];
  expectedQueries: string[];
  injectedExpectedQueries: string[];
  missedExpectedQueries: string[];
  queryContextLines: string[];
  unexpectedQueryContextLines: string[];
  sourceGapCount: number;
  noUsefulExpected: boolean;
  falseNegative: boolean;
  precisionLike: number | null;
  recallLike: number | null;
  reasons: string[];
}

interface SubsequentActivity {
  window: {
    startMs: number;
    endMs: number | null;
    endReason: "next_user_prompt" | "session_end" | "available_activity";
    nextPrompt: string | null;
  };
  messages: EvidenceMessage[];
  hookEvents: EvidenceHookEvent[];
  toolCalls: EvidenceToolCall[];
  scannerEvents: EvidenceScannerEvent[];
}

interface EvidenceMessage {
  timestampMs: number | null;
  ordinal: number;
  role: string;
  content: string;
}

interface EvidenceHookEvent {
  id: number;
  timestampMs: number;
  eventType: string;
  toolName: string | null;
  userPrompt: string | null;
  filePath: string | null;
  command: string | null;
  toolResult: string | null;
}

interface EvidenceToolCall {
  timestampMs: number | null;
  messageOrdinal: number | null;
  toolName: string;
  category: string;
  input: string | null;
  result: string | null;
}

interface EvidenceScannerEvent {
  timestampMs: number;
  eventType: string;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  content: string | null;
}

const DEFAULT_LIMIT = 25;
const DEFAULT_JUDGE_TIMEOUT_MS = 180_000;
const DEFAULT_JUDGE_MAX_CHARS = 18_000;
const JUDGE_MESSAGE_LIMIT = 18;
const JUDGE_HOOK_EVENT_LIMIT = 24;
const JUDGE_TOOL_CALL_LIMIT = 16;
const JUDGE_SCANNER_EVENT_LIMIT = 16;
const JUDGE_FIELD_MAX_CHARS = 1_200;
const LABEL_SUMMARY_LIMIT = 36;
const LABEL_SUMMARY_FIELD_MAX_CHARS = 220;
const DEFAULT_FIXTURE_DIR = path.join(
  process.cwd(),
  ".tmp",
  "evals",
  "userprompt-context",
);
const ASSESSMENT_TERM_LIMIT = 14;
const ASSESSMENT_STOPWORDS = new Set([
  "about",
  "actually",
  "after",
  "again",
  "also",
  "and",
  "anything",
  "are",
  "before",
  "but",
  "can",
  "confirm",
  "could",
  "did",
  "does",
  "for",
  "from",
  "have",
  "how",
  "just",
  "into",
  "let",
  "lets",
  "like",
  "make",
  "more",
  "much",
  "not",
  "now",
  "old",
  "our",
  "see",
  "should",
  "that",
  "the",
  "then",
  "there",
  "this",
  "too",
  "use",
  "using",
  "want",
  "was",
  "what",
  "when",
  "where",
  "with",
  "would",
  "yes",
  "you",
]);
const ASSESSMENT_WEAK_TERMS = new Set([
  "add",
  "app",
  "build",
  "change",
  "changes",
  "code",
  "context",
  "current",
  "data",
  "fml",
  "github",
  "history",
  "hook",
  "hooks",
  "install",
  "local",
  "main",
  "mcp",
  "mode",
  "pack",
  "panopticon",
  "pano",
  "prompt",
  "prompts",
  "pull",
  "query",
  "repo",
  "review",
  "session",
  "sessions",
  "start",
  "test",
  "tool",
  "tools",
  "work",
  "workspace",
  "worktree",
  "worktrees",
]);
const ASSESSMENT_STRONG_TERMS = new Set([
  "anamnesis",
  "is_automated",
  "pretooluse",
  "sessionstart",
  "userpromptsubmit",
]);
const LLM_JUDGE_SYSTEM_PROMPT = `You are judging the utility of local context injected into a coding agent after a UserPromptSubmit hook.

Use the subsequent session activity as hindsight evidence. The live hook would not have seen that future activity; you are using it only to judge whether the injected context would have helped with what the agent actually did next.

Judge each injected context item independently:
- critical: directly necessary or would have prevented a likely wrong turn
- useful: clearly relevant to the next work, investigation, decision, or verification
- weak: tangential, generic, or only mildly helpful
- irrelevant: unrelated, stale noise, or misleading

Also judge whether important local context appears missing based on what happened next. Do not invent facts that are not supported by the evidence. Prefer concise reasons with evidence.

Output only JSON with this exact shape:
{
  "overallUtility": "none|low|medium|high",
  "score": 0,
  "rationale": "short explanation",
  "items": [
    {
      "sessionId": "string",
      "utility": "irrelevant|weak|useful|critical",
      "reason": "short explanation",
      "evidence": "specific hindsight evidence"
    }
  ],
  "missedContext": [
    {
      "query": "what should have been retrieved",
      "reason": "why it would help",
      "evidence": "specific hindsight evidence"
    }
  ],
  "recommendedAction": "keep|tighten|broaden|label_for_review"
}`;

main()
  .catch((err: unknown) => {
    console.error(
      err instanceof Error ? err.stack || err.message : String(err),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sets: EvalSet[] = args.set === "both" ? ["first", "later"] : [args.set];

  for (const set of sets) {
    const fixture = loadOrCreateFixture(set, args);
    const labelsByKey = loadLabelsByKey(set, args.fixtureDir);
    const results: EvalResult[] = [];
    for (const [index, prompt] of fixture.prompts.entries()) {
      const shouldJudge =
        args.llmJudge && (args.judgeLimit === null || index < args.judgeLimit);
      results.push(
        await evaluatePrompt(set, index + 1, prompt, {
          args,
          label: labelsByKey.get(promptKey(prompt)) ?? null,
          llmJudge: shouldJudge,
        }),
      );
    }
    if (args.json) {
      console.log(JSON.stringify({ fixture, results }, null, 2));
    } else {
      printResults(set, results, args);
    }
    writeResults(set, args.fixtureDir, results);
    if (args.writeLabelTemplate) {
      writeLabelTemplate(set, args.fixtureDir, results);
    }
  }
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    set: "both",
    limit: DEFAULT_LIMIT,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    refresh: false,
    verbose: false,
    json: false,
    llmJudge: false,
    judgeRunner: null,
    judgeModel: null,
    judgeLimit: null,
    judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
    judgeMaxChars: DEFAULT_JUDGE_MAX_CHARS,
    judgeDryRun: false,
    writeLabelTemplate: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--set") {
      parsed.set = parseSet(readArgValue(argv, ++i, arg), true);
    } else if (arg.startsWith("--set=")) {
      parsed.set = parseSet(arg.slice("--set=".length), true);
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInt(readArgValue(argv, ++i, arg), arg);
    } else if (arg.startsWith("--limit=")) {
      parsed.limit = parsePositiveInt(arg.slice("--limit=".length), arg);
    } else if (arg === "--fixture-dir") {
      parsed.fixtureDir = path.resolve(readArgValue(argv, ++i, arg));
    } else if (arg.startsWith("--fixture-dir=")) {
      parsed.fixtureDir = path.resolve(arg.slice("--fixture-dir=".length));
    } else if (arg === "--refresh") {
      parsed.refresh = true;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--llm-judge") {
      parsed.llmJudge = true;
    } else if (arg === "--judge-dry-run") {
      parsed.llmJudge = true;
      parsed.judgeDryRun = true;
    } else if (arg === "--judge-runner") {
      parsed.judgeRunner = parseRunner(readArgValue(argv, ++i, arg));
    } else if (arg.startsWith("--judge-runner=")) {
      parsed.judgeRunner = parseRunner(arg.slice("--judge-runner=".length));
    } else if (arg === "--judge-model") {
      parsed.judgeModel = readArgValue(argv, ++i, arg);
    } else if (arg.startsWith("--judge-model=")) {
      parsed.judgeModel = arg.slice("--judge-model=".length);
    } else if (arg === "--judge-limit") {
      parsed.judgeLimit = parsePositiveInt(readArgValue(argv, ++i, arg), arg);
    } else if (arg.startsWith("--judge-limit=")) {
      parsed.judgeLimit = parsePositiveInt(
        arg.slice("--judge-limit=".length),
        "--judge-limit",
      );
    } else if (arg === "--judge-timeout-ms") {
      parsed.judgeTimeoutMs = parsePositiveInt(
        readArgValue(argv, ++i, arg),
        arg,
      );
    } else if (arg.startsWith("--judge-timeout-ms=")) {
      parsed.judgeTimeoutMs = parsePositiveInt(
        arg.slice("--judge-timeout-ms=".length),
        "--judge-timeout-ms",
      );
    } else if (arg === "--judge-max-chars") {
      parsed.judgeMaxChars = parsePositiveInt(
        readArgValue(argv, ++i, arg),
        arg,
      );
    } else if (arg.startsWith("--judge-max-chars=")) {
      parsed.judgeMaxChars = parsePositiveInt(
        arg.slice("--judge-max-chars=".length),
        "--judge-max-chars",
      );
    } else if (arg === "--write-label-template") {
      parsed.writeLabelTemplate = true;
    } else if (arg === "--") {
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function parseSet(value: string, allowBoth: true): EvalSet | "both" {
  if (
    value === "first" ||
    value === "later" ||
    (allowBoth && value === "both")
  ) {
    return value;
  }
  throw new Error(`Invalid --set value: ${value}`);
}

function parseRunner(value: string): SessionSummaryRunnerName {
  if (isSummaryRunnerName(value)) return value;
  throw new Error(`Invalid runner: ${value} (expected claude or codex)`);
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: pnpm eval:userprompt -- [options]

Options:
  --set first|later|both      Prompt set to evaluate (default: both)
  --limit N                  Number of prompts sampled per set on refresh (default: ${DEFAULT_LIMIT})
  --fixture-dir PATH         Prompt fixture/result directory (default: ${DEFAULT_FIXTURE_DIR})
  --refresh                  Resample fixture prompts from the local DB
  --verbose                  Print returned context lines
  --json                     Print full JSON results
  --llm-judge                Ask an LLM to judge injected-context utility using subsequent session activity
  --judge-dry-run            Build and store judge inputs without calling an LLM
  --judge-runner claude|codex  Runner for --llm-judge (default: infer from target, then claude)
  --judge-model MODEL        Optional model passed to the runner
  --judge-limit N            Judge only the first N prompts per set
  --judge-timeout-ms N       LLM judge timeout (default: ${DEFAULT_JUDGE_TIMEOUT_MS})
  --judge-max-chars N        Max judge prompt chars (default: ${DEFAULT_JUDGE_MAX_CHARS})
  --write-label-template     Write {set}.labels.json with what-happened evidence and expected-context slots

Fixtures are local-only by default under .tmp/evals/userprompt-context.`);
}

function loadOrCreateFixture(set: EvalSet, opts: Args): PromptFixture {
  const filePath = fixturePath(opts.fixtureDir, set);
  if (!opts.refresh && fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as PromptFixture;
  }

  const fixture: PromptFixture = {
    generatedAt: new Date().toISOString(),
    set,
    limit: opts.limit,
    prompts: samplePrompts(set, opts.limit),
  };
  fs.mkdirSync(opts.fixtureDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(fixture, null, 2)}\n`);
  return fixture;
}

function fixturePath(dir: string, set: EvalSet): string {
  return path.join(dir, `${set}.json`);
}

function resultsPath(dir: string, set: EvalSet): string {
  return path.join(dir, `${set}.results.json`);
}

function labelsPath(dir: string, set: EvalSet): string {
  return path.join(dir, `${set}.labels.json`);
}

function samplePrompts(set: EvalSet, limit: number): EvalPrompt[] {
  const db = getDb();
  const promptFilter =
    set === "first" ? "prompt_index = 1" : "prompt_index > 1";
  const rows = db
    .prepare(
      `WITH prompts AS (
         SELECT h.id,
                h.session_id,
                h.timestamp_ms,
                h.user_prompt,
                h.cwd,
                h.repository,
                s.target,
                s.project,
                ROW_NUMBER() OVER (
                  PARTITION BY h.session_id
                  ORDER BY h.timestamp_ms, h.id
                ) AS prompt_index,
                COUNT(*) OVER (PARTITION BY h.session_id) AS prompt_count,
                LENGTH(h.user_prompt) AS prompt_len
         FROM hook_events h
         LEFT JOIN sessions s ON s.session_id = h.session_id
         WHERE h.event_type = 'UserPromptSubmit'
           AND h.user_prompt IS NOT NULL
           AND TRIM(h.user_prompt) != ''
           AND COALESCE(s.is_automated, 0) != 1
       ),
       eligible AS (
         SELECT *,
                CASE
                  WHEN prompt_len BETWEEN 35 AND 420 THEN 1000
                  ELSE 0
                END
                + MIN(prompt_len, 420)
                + (prompt_count * 4)
                + CASE WHEN user_prompt LIKE '%?%' THEN 40 ELSE 0 END
                + CASE
                    WHEN user_prompt LIKE '%pr %'
                      OR user_prompt LIKE '%session%'
                      OR user_prompt LIKE '%hook%'
                      OR user_prompt LIKE '%build%'
                      OR user_prompt LIKE '%install%'
                      OR user_prompt LIKE '%review%'
                      OR user_prompt LIKE '%schema%'
                      OR user_prompt LIKE '%query%'
                    THEN 60
                    ELSE 0
                  END AS complexity_score,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id
                  ORDER BY
                    CASE WHEN prompt_len BETWEEN 35 AND 420 THEN 0 ELSE 1 END,
                    prompt_len DESC,
                    timestamp_ms DESC,
                    id DESC
                ) AS session_prompt_rank
         FROM prompts
         WHERE ${promptFilter}
           AND prompt_len BETWEEN 20 AND 800
       )
       SELECT id,
              session_id,
              timestamp_ms,
              target,
              project,
              cwd,
              repository,
              prompt_index,
              prompt_count,
              user_prompt
       FROM eligible
       WHERE session_prompt_rank <= 5
       ORDER BY session_prompt_rank ASC,
                complexity_score DESC,
                timestamp_ms DESC,
                id DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    session_id: string;
    timestamp_ms: number;
    target: string | null;
    project: string | null;
    cwd: string | null;
    repository: string | null;
    prompt_index: number;
    prompt_count: number;
    user_prompt: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    timestampMs: row.timestamp_ms,
    target: row.target,
    project: row.project,
    cwd: row.cwd,
    repository: row.repository,
    promptIndex: row.prompt_index,
    promptCount: row.prompt_count,
    prompt: row.user_prompt,
  }));
}

function evaluatePrompt(
  set: EvalSet,
  ordinal: number,
  prompt: EvalPrompt,
  opts: { args: Args; label: EvalPromptLabel | null; llmJudge: boolean },
): Promise<EvalResult> {
  const input = {
    session_id: prompt.sessionId,
    cwd: prompt.cwd ?? undefined,
    repository: prompt.repository ?? undefined,
    prompt: prompt.prompt,
    is_first_user_prompt_submit: prompt.promptIndex === 1,
    now_ms: prompt.timestampMs,
  };
  const userPromptContext = buildUserPromptSubmitLocalContext(input);
  const sessionStartContext =
    prompt.cwd && set === "first"
      ? buildSessionStartRecentHistoryContext({
          session_id: prompt.sessionId,
          cwd: prompt.cwd,
          now_ms: prompt.timestampMs,
        })
      : null;

  const userPromptSessionIds = extractSessionIds(userPromptContext);
  const sessionStartSessionIds = extractSessionIds(sessionStartContext);
  const userPromptLines = extractSummaryLines(userPromptContext);
  const sessionStartLines = extractSummaryLines(sessionStartContext);
  const sessionStartSet = new Set(sessionStartSessionIds);
  const overlapSessionIds = userPromptSessionIds.filter((id) =>
    sessionStartSet.has(id),
  );
  const usefulness = assessContextUsefulness({
    prompt: prompt.prompt,
    userPromptLines,
    overlapSessionIds,
  });
  const labelAssessment = assessAgainstLabel({
    label: opts.label,
    userPromptSessionIds,
    userPromptLines,
  });
  const result: EvalResult = {
    set,
    ordinal,
    prompt,
    userPromptSessionIds,
    sessionStartSessionIds,
    overlapSessionIds,
    userPromptLines,
    sessionStartLines,
    usefulness,
    labelAssessment,
    llmJudge: null,
  };
  if (!opts.llmJudge) return Promise.resolve(result);

  return judgePromptWithLlm({
    prompt,
    result,
    args: opts.args,
  }).then((llmJudge) => ({ ...result, llmJudge }));
}

function extractSessionIds(context: string | null): string[] {
  if (!context) return [];
  const ids = [...context.matchAll(/session_id=([^\s]+)/g)].map(
    (match) => match[1],
  );
  return [...new Set(ids)];
}

function extractSummaryLines(context: string | null): string[] {
  if (!context) return [];
  return context
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.trim());
}

function printResults(set: EvalSet, results: EvalResult[], opts: Args): void {
  const withContext = results.filter(
    (result) => result.userPromptSessionIds.length > 0,
  );
  const highUsefulness = results.filter(
    (result) => result.usefulness.level === "high",
  );
  const mediumUsefulness = results.filter(
    (result) => result.usefulness.level === "medium",
  );
  const lowUsefulness = results.filter(
    (result) => result.usefulness.level === "low",
  );
  const noUsefulness = results.filter(
    (result) => result.usefulness.level === "none",
  );
  const fullOverlap = results.filter(
    (result) =>
      result.userPromptSessionIds.length > 0 &&
      result.userPromptSessionIds.every((id) =>
        result.sessionStartSessionIds.includes(id),
      ),
  );
  const partialOverlap = results.filter(
    (result) =>
      result.overlapSessionIds.length > 0 &&
      result.overlapSessionIds.length < result.userPromptSessionIds.length,
  );
  const avgHits =
    results.length === 0
      ? 0
      : results.reduce(
          (sum, result) => sum + result.userPromptSessionIds.length,
          0,
        ) / results.length;
  const totalAssessedItems = results.reduce(
    (sum, result) => sum + result.usefulness.itemCount,
    0,
  );
  const usefulAssessedItems = results.reduce(
    (sum, result) => sum + result.usefulness.usefulHitCount,
    0,
  );
  const avgContextScore =
    results.length === 0
      ? 0
      : results.reduce((sum, result) => sum + result.usefulness.score, 0) /
        results.length;
  const judged = results.filter((result) => result.llmJudge !== null);
  const judgeOk = judged.filter((result) => result.llmJudge?.status === "ok");
  const judgeFailed = judged.filter(
    (result) => result.llmJudge?.status === "failed",
  );
  const judgeSkipped = judged.filter(
    (result) => result.llmJudge?.status === "skipped",
  );
  const judgeUtilityCounts = countJudgeUtilityLevels(judgeOk);
  const labeled = results.filter(
    (result) => result.labelAssessment.status === "labeled",
  );
  const labelFalseNegatives = labeled.filter(
    (result) => result.labelAssessment.falseNegative,
  );
  const expectedSessionCount = labeled.reduce(
    (sum, result) => sum + result.labelAssessment.expectedSessionIds.length,
    0,
  );
  const hitExpectedSessionCount = labeled.reduce(
    (sum, result) =>
      sum + result.labelAssessment.injectedExpectedSessionIds.length,
    0,
  );
  const sourceGapCount = labeled.reduce(
    (sum, result) => sum + result.labelAssessment.sourceGapCount,
    0,
  );
  const hitExpectedQueryCount = labeled.reduce(
    (sum, result) =>
      sum + result.labelAssessment.injectedExpectedQueries.length,
    0,
  );
  const expectedQueryCount = labeled.reduce(
    (sum, result) => sum + result.labelAssessment.expectedQueries.length,
    0,
  );
  const labelSessionCases = labeled.filter(
    (result) => result.labelAssessment.expectedSessionIds.length > 0,
  );
  const labelSessionMissCases = labeled.filter(
    (result) => result.labelAssessment.missedExpectedSessionIds.length > 0,
  );
  const labelQueryCases = labeled.filter(
    (result) => result.labelAssessment.expectedQueries.length > 0,
  );
  const labelNoUsefulCases = labeled.filter(
    (result) => result.labelAssessment.noUsefulExpected,
  );
  const labelNoUsefulCorrect = labelNoUsefulCases.filter(
    (result) => result.userPromptLines.length === 0,
  );
  const labelNoUsefulUnexpected = labelNoUsefulCases.filter(
    (result) =>
      result.labelAssessment.unexpectedInjectedSessionIds.length > 0 ||
      result.labelAssessment.unexpectedQueryContextLines.length > 0,
  );

  console.log("");
  console.log(
    `${set.toUpperCase()} prompts: ${results.length} fixture prompts (${fixturePath(opts.fixtureDir, set)})`,
  );
  console.log(
    `  with_context=${withContext.length} no_context=${
      results.length - withContext.length
    } avg_hits=${avgHits.toFixed(2)} full_sessionstart_overlap=${
      fullOverlap.length
    } partial_sessionstart_overlap=${partialOverlap.length}`,
  );
  console.log(
    `  usefulness high=${highUsefulness.length} medium=${
      mediumUsefulness.length
    } low=${lowUsefulness.length} none=${
      noUsefulness.length
    } avg_context_score=${avgContextScore.toFixed(2)} useful_hits=${usefulAssessedItems}/${totalAssessedItems}`,
  );
  if (opts.llmJudge) {
    console.log(
      `  llm_judge ok=${judgeOk.length} failed=${judgeFailed.length} skipped=${
        judgeSkipped.length
      } high=${judgeUtilityCounts.high} medium=${judgeUtilityCounts.medium} low=${
        judgeUtilityCounts.low
      } none=${judgeUtilityCounts.none}`,
    );
  }
  if (labeled.length > 0) {
    console.log(
      `  labels labeled=${labeled.length} false_negatives=${
        labelFalseNegatives.length
      } expected_session_hits=${hitExpectedSessionCount}/${expectedSessionCount} source_gaps=${sourceGapCount}`,
    );
    console.log(
      `  label_kinds session_cases=${labelSessionCases.length} session_hits=${hitExpectedSessionCount}/${expectedSessionCount} session_miss_cases=${labelSessionMissCases.length} query_cases=${labelQueryCases.length} query_hits=${hitExpectedQueryCount}/${expectedQueryCount} query_gaps=${sourceGapCount}/${expectedQueryCount} none_cases=${labelNoUsefulCases.length} none_correct=${labelNoUsefulCorrect.length} none_unexpected=${labelNoUsefulUnexpected.length}`,
    );
  }

  for (const result of results) {
    const prompt = result.prompt;
    const overlap =
      result.sessionStartSessionIds.length > 0
        ? `${result.overlapSessionIds.length}/${result.userPromptSessionIds.length}`
        : "n/a";
    console.log("");
    console.log(
      `[${set} #${String(result.ordinal).padStart(2, "0")}] hits=${
        result.userPromptSessionIds.length
      } sessionstart_overlap=${overlap} prompt_index=${prompt.promptIndex}/${
        prompt.promptCount
      } ${formatDate(prompt.timestampMs)} ${prompt.target ?? "unknown"} ${
        prompt.project ?? ""
      }`,
    );
    console.log(
      `  usefulness=${result.usefulness.level} score=${result.usefulness.score.toFixed(
        2,
      )} useful_hits=${result.usefulness.usefulHitCount}/${
        result.usefulness.itemCount
      } low_hits=${result.usefulness.lowValueHitCount} duplicate_hits=${
        result.usefulness.duplicateHitCount
      } reasons=${result.usefulness.reasons.join(",") || "none"}`,
    );
    if (result.llmJudge) {
      const judge = result.llmJudge;
      const judgeResult = judge.result;
      console.log(
        `  llm_judge=${judge.status} runner=${judge.runner ?? "none"} model=${
          judge.model ?? "default"
        } utility=${judgeResult?.overallUtility ?? "n/a"} score=${
          judgeResult?.score ?? "n/a"
        } action=${judgeResult?.recommendedAction ?? "n/a"} reason=${
          judge.error
            ? oneLine(judge.error, 140)
            : oneLine(judgeResult?.rationale ?? "", 140)
        }`,
      );
    }
    if (result.labelAssessment.status === "labeled") {
      const label = result.labelAssessment;
      console.log(
        `  labels=${label.reviewStatus ?? "unknown"} recall=${
          label.recallLike === null ? "n/a" : label.recallLike.toFixed(2)
        } precision=${
          label.precisionLike === null ? "n/a" : label.precisionLike.toFixed(2)
        } false_negative=${label.falseNegative} missed=${
          label.missedExpectedSessionIds.join(",") || "none"
        } query_missed=${
          label.missedExpectedQueries.length
        } source_gaps=${label.sourceGapCount} no_useful_expected=${
          label.noUsefulExpected
        } reasons=${label.reasons.join(",") || "none"}`,
      );
    }
    console.log(`  session_id=${prompt.sessionId}`);
    console.log(`  prompt=${oneLine(prompt.prompt, 220)}`);
    if (result.userPromptSessionIds.length > 0) {
      console.log(`  userprompt_ids=${result.userPromptSessionIds.join(", ")}`);
    }
    if (result.overlapSessionIds.length > 0) {
      console.log(`  overlap_ids=${result.overlapSessionIds.join(", ")}`);
    }
    if (opts.verbose) {
      for (const item of result.usefulness.items) {
        console.log(
          `    userprompt [${item.level} score=${item.score.toFixed(
            2,
          )} matched=${formatTermList(
            item.matchedTerms,
          )} specific=${formatTermList(
            item.specificMatchedTerms,
          )} strong=${formatTermList(
            item.strongMatchedTerms,
          )} reasons=${item.reasons.join(",") || "none"}] ${oneLine(
            item.line,
            260,
          )}`,
        );
      }
      for (const line of result.sessionStartLines) {
        console.log(`    sessionstart ${oneLine(line, 260)}`);
      }
    }
  }
}

function assessContextUsefulness(opts: {
  prompt: string;
  userPromptLines: string[];
  overlapSessionIds: string[];
}): ContextUsefulnessAssessment {
  if (opts.userPromptLines.length === 0) {
    return {
      level: "none",
      score: 0,
      itemCount: 0,
      usefulHitCount: 0,
      lowValueHitCount: 0,
      duplicateHitCount: 0,
      precisionLike: null,
      reasons: ["no_context_returned"],
      items: [],
    };
  }

  const terms = extractAssessmentTerms(opts.prompt);
  const overlapSessionIds = new Set(opts.overlapSessionIds);
  const items = opts.userPromptLines.map((line) =>
    assessContextLineUsefulness({
      line,
      terms,
      duplicatesSessionStart: overlapSessionIds.has(
        extractSessionIdFromLine(line) ?? "",
      ),
    }),
  );
  const usefulHitCount = items.filter((item) => item.score >= 2).length;
  const lowValueHitCount = items.filter((item) => item.level === "low").length;
  const duplicateHitCount = items.filter((item) =>
    item.reasons.includes("duplicates_sessionstart"),
  ).length;
  const maxScore = items.reduce((max, item) => Math.max(max, item.score), 0);
  const score = Number(maxScore.toFixed(2));
  const level = score >= 2.5 ? "high" : score >= 1.5 ? "medium" : "low";
  const reasons: string[] = [];
  if (usefulHitCount > 0) reasons.push("has_useful_context");
  if (lowValueHitCount > 0) reasons.push("has_low_value_context");
  if (duplicateHitCount > 0) reasons.push("has_sessionstart_duplicate");
  if (terms.length === 0) reasons.push("no_assessable_prompt_terms");
  if (usefulHitCount === 0 && duplicateHitCount === 0) {
    reasons.push("only_weak_or_no_prompt_overlap");
  }

  return {
    level,
    score,
    itemCount: items.length,
    usefulHitCount,
    lowValueHitCount,
    duplicateHitCount,
    precisionLike: Number((usefulHitCount / items.length).toFixed(2)),
    reasons,
    items,
  };
}

function assessContextLineUsefulness(opts: {
  line: string;
  terms: AssessmentTerm[];
  duplicatesSessionStart: boolean;
}): ContextItemUsefulnessAssessment {
  const lineText = opts.line.toLowerCase();
  const matchedTerms = opts.terms.filter((term) =>
    lineText.includes(term.term),
  );
  const specificMatchedTerms = matchedTerms.filter(
    (term) => term.strong || term.weight > 1,
  );
  const strongMatchedTerms = matchedTerms.filter((term) => term.strong);
  const specificScore = specificMatchedTerms.reduce(
    (sum, term) => sum + term.weight,
    0,
  );
  const reasons: string[] = [];
  let score = 0;

  if (opts.duplicatesSessionStart) {
    reasons.push("duplicates_sessionstart");
  }
  if (strongMatchedTerms.length > 0) {
    reasons.push("strong_prompt_term_match");
  }
  if (matchedTerms.length >= 3) {
    reasons.push("multiple_prompt_term_matches");
  }
  if (matchedTerms.length > 0 && specificMatchedTerms.length === 0) {
    reasons.push("generic_only_prompt_term_match");
  }
  if (matchedTerms.length === 0) {
    reasons.push("no_prompt_term_overlap");
  }

  if (!opts.duplicatesSessionStart) {
    if (strongMatchedTerms.length >= 2 || specificScore >= 6) {
      score = 3;
    } else if (
      strongMatchedTerms.length === 1 ||
      specificScore >= 3 ||
      specificMatchedTerms.length >= 2
    ) {
      score = 2;
    } else if (matchedTerms.length > 0) {
      score = 1;
    }
  }

  return {
    sessionId: extractSessionIdFromLine(opts.line) ?? "unknown",
    level: score >= 2.5 ? "high" : score >= 1.5 ? "medium" : "low",
    score,
    matchedTerms: matchedTerms.map((term) => term.term),
    specificMatchedTerms: specificMatchedTerms.map((term) => term.term),
    strongMatchedTerms: strongMatchedTerms.map((term) => term.term),
    reasons,
    line: opts.line,
  };
}

function extractAssessmentTerms(prompt: string): AssessmentTerm[] {
  const seen = new Map<string, number>();
  const terms = prompt.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  for (const [index, term] of terms.entries()) {
    const normalized = term.replace(/^-+|-+$/g, "");
    if (
      normalized.length < 3 ||
      (/^\d+$/.test(normalized) && normalized.length < 3) ||
      ASSESSMENT_STOPWORDS.has(normalized)
    ) {
      continue;
    }
    if (!seen.has(normalized)) seen.set(normalized, index);
  }

  return [...seen.entries()]
    .map(([term, index]) => ({
      term,
      weight: scoreAssessmentTerm(term),
      strong: isStrongAssessmentTerm(term),
      index,
    }))
    .sort(
      (a, b) =>
        Number(b.strong) - Number(a.strong) ||
        b.weight - a.weight ||
        a.index - b.index,
    )
    .slice(0, ASSESSMENT_TERM_LIMIT);
}

function scoreAssessmentTerm(term: string): number {
  if (ASSESSMENT_STRONG_TERMS.has(term)) return 4;
  if (/^\d{3,}$/.test(term)) return 3;
  if (/[0-9]/.test(term) && /[a-z]/.test(term)) return 3;
  if (term.includes("_") || term.includes("-")) return 3;
  if (ASSESSMENT_WEAK_TERMS.has(term)) return 1;
  return term.length >= 8 ? 2 : 1;
}

function isStrongAssessmentTerm(term: string): boolean {
  return (
    ASSESSMENT_STRONG_TERMS.has(term) ||
    /^\d{3,}$/.test(term) ||
    (/[0-9]/.test(term) && /[a-z]/.test(term)) ||
    term.includes("_") ||
    term.includes("-") ||
    (!ASSESSMENT_WEAK_TERMS.has(term) && term.length >= 8)
  );
}

function extractSessionIdFromLine(line: string): string | null {
  return line.match(/session_id=([^\s]+)/)?.[1] ?? null;
}

function formatTermList(terms: string[]): string {
  return terms.length > 0 ? terms.join("|") : "none";
}

function writeResults(
  set: EvalSet,
  fixtureDir: string,
  results: EvalResult[],
): void {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    resultsPath(fixtureDir, set),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), set, results }, null, 2)}\n`,
  );
}

function loadLabelsByKey(
  set: EvalSet,
  fixtureDir: string,
): Map<string, EvalPromptLabel> {
  const filePath = labelsPath(fixtureDir, set);
  if (!fs.existsSync(filePath)) return new Map();

  const parsed = JSON.parse(
    fs.readFileSync(filePath, "utf-8"),
  ) as Partial<EvalLabelFile>;
  const labels = Array.isArray(parsed.labels) ? parsed.labels : [];
  return new Map(
    labels.filter(isEvalPromptLabel).map((label) => [label.promptKey, label]),
  );
}

function writeLabelTemplate(
  set: EvalSet,
  fixtureDir: string,
  results: EvalResult[],
): void {
  const existing = loadLabelsByKey(set, fixtureDir);
  const labels = results.map((result) =>
    mergeLabelTemplate(result, existing.get(promptKey(result.prompt)) ?? null),
  );
  const filePath = labelsPath(fixtureDir, set);
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), set, labels }, null, 2)}\n`,
  );
  console.log(`  wrote_label_template=${filePath}`);
}

function mergeLabelTemplate(
  result: EvalResult,
  existing: EvalPromptLabel | null,
): EvalPromptLabel {
  const generated = buildGeneratedLabel(result);
  if (!existing) return generated;

  const keepExistingLabels =
    existing.reviewStatus === "human_reviewed" ||
    (existing.reviewStatus === "llm_draft" &&
      generated.reviewStatus === "unreviewed") ||
    (existing.expectedUsefulPanopticon.length > 0 &&
      generated.expectedUsefulPanopticon.length === 0) ||
    (existing.noUsefulPanopticonExpected !== null &&
      generated.noUsefulPanopticonExpected === null);

  return {
    ...generated,
    reviewStatus: keepExistingLabels
      ? existing.reviewStatus
      : generated.reviewStatus,
    expectedUsefulPanopticon: keepExistingLabels
      ? existing.expectedUsefulPanopticon
      : generated.expectedUsefulPanopticon,
    noUsefulPanopticonExpected: keepExistingLabels
      ? existing.noUsefulPanopticonExpected
      : generated.noUsefulPanopticonExpected,
    notes: existing.notes,
  };
}

function buildGeneratedLabel(result: EvalResult): EvalPromptLabel {
  const outcome =
    result.llmJudge?.outcome ?? loadSubsequentActivity(result.prompt);
  const expectedUsefulPanopticon = expectedDataFromJudge(
    result.llmJudge?.result,
  );
  const hasJudge = result.llmJudge?.status === "ok" && result.llmJudge.result;
  const noUsefulPanopticonExpected =
    hasJudge &&
    result.llmJudge?.result?.overallUtility === "none" &&
    expectedUsefulPanopticon.length === 0
      ? true
      : null;

  return {
    promptKey: promptKey(result.prompt),
    eventId: result.prompt.id,
    sessionId: result.prompt.sessionId,
    promptIndex: result.prompt.promptIndex,
    timestamp: formatDate(result.prompt.timestampMs),
    target: result.prompt.target,
    project: result.prompt.project,
    cwd: result.prompt.cwd,
    repository: result.prompt.repository,
    prompt: result.prompt.prompt,
    reviewStatus: hasJudge ? "llm_draft" : "unreviewed",
    whatHappened: summarizeSubsequentActivity(outcome),
    injectedContext: result.userPromptLines,
    expectedUsefulPanopticon,
    noUsefulPanopticonExpected,
    notes: "",
  };
}

function expectedDataFromJudge(
  judge: LlmJudgeResult | undefined,
): ExpectedUsefulPanopticonData[] {
  if (!judge) return [];
  const items: ExpectedUsefulPanopticonData[] = [];

  for (const item of judge.items) {
    const utility = expectedUtilityFromJudgeItem(item.utility);
    if (!utility) continue;
    items.push({
      kind: "session",
      sessionId: item.sessionId,
      utility,
      source: "llm",
      reason: item.reason,
      evidence: item.evidence,
    });
  }

  for (const missed of judge.missedContext) {
    items.push({
      kind: "query",
      query: missed.query,
      utility: "useful",
      source: "llm",
      reason: missed.reason,
      evidence: missed.evidence,
    });
  }

  return items;
}

function expectedUtilityFromJudgeItem(
  utility: JudgeItemUtility,
): ExpectedPanopticonUtility | null {
  switch (utility) {
    case "critical":
      return "critical";
    case "useful":
      return "useful";
    case "weak":
      return "weak";
    case "irrelevant":
      return null;
  }
}

function assessAgainstLabel(opts: {
  label: EvalPromptLabel | null;
  userPromptSessionIds: string[];
  userPromptLines: string[];
}): LabelAssessment {
  const unlabeled: LabelAssessment = {
    status: "unlabeled",
    reviewStatus: null,
    expectedSessionIds: [],
    injectedExpectedSessionIds: [],
    missedExpectedSessionIds: [],
    unexpectedInjectedSessionIds: [],
    expectedQueries: [],
    injectedExpectedQueries: [],
    missedExpectedQueries: [],
    queryContextLines: [],
    unexpectedQueryContextLines: [],
    sourceGapCount: 0,
    noUsefulExpected: false,
    falseNegative: false,
    precisionLike: null,
    recallLike: null,
    reasons: ["no_label"],
  };
  if (!opts.label || !hasActionableLabel(opts.label)) return unlabeled;

  const expected = opts.label.expectedUsefulPanopticon.filter(
    (item) => item.utility === "useful" || item.utility === "critical",
  );
  const expectedSessionIds = uniqueStrings(
    expected
      .filter((item) => item.kind === "session" && item.sessionId)
      .map((item) => item.sessionId as string),
  );
  const expectedQueries = uniqueStrings(
    expected
      .filter((item) => item.kind === "query" && item.query)
      .map((item) => item.query as string),
  );
  const queryContextLines = extractQueryContextLines(opts.userPromptLines);
  const injectedSet = new Set(opts.userPromptSessionIds);
  const injectedExpectedSessionIds = expectedSessionIds.filter((id) =>
    injectedSet.has(id),
  );
  const missedExpectedSessionIds = expectedSessionIds.filter(
    (id) => !injectedSet.has(id),
  );
  const injectedExpectedQueries = expectedQueries.filter((query) =>
    queryContextSatisfiesExpectedQuery(query, queryContextLines),
  );
  const missedExpectedQueries = expectedQueries.filter(
    (query) => !injectedExpectedQueries.includes(query),
  );
  const noUsefulExpected = opts.label.noUsefulPanopticonExpected === true;
  const unexpectedInjectedSessionIds = noUsefulExpected
    ? opts.userPromptSessionIds
    : expectedSessionIds.length > 0
      ? opts.userPromptSessionIds.filter(
          (id) => !expectedSessionIds.includes(id),
        )
      : [];
  const unexpectedQueryContextLines = noUsefulExpected ? queryContextLines : [];
  const sourceGapCount = missedExpectedQueries.length;
  const expectedUnitCount = expectedSessionIds.length + expectedQueries.length;
  const injectedUsefulUnitCount =
    injectedExpectedSessionIds.length + injectedExpectedQueries.length;
  const injectedUnitCount =
    opts.userPromptSessionIds.length + queryContextLines.length;
  const precisionLike = calculatePrecisionLike({
    noUsefulExpected,
    injectedCount: injectedUnitCount,
    expectedSessionCount: expectedUnitCount,
    hitCount: injectedUsefulUnitCount,
  });
  const recallLike =
    expectedUnitCount === 0
      ? null
      : roundMetric(injectedUsefulUnitCount / expectedUnitCount);
  const falseNegative =
    missedExpectedSessionIds.length > 0 || missedExpectedQueries.length > 0;
  const reasons: string[] = [];

  if (missedExpectedSessionIds.length > 0)
    reasons.push("missed_expected_session");
  if (injectedExpectedQueries.length > 0)
    reasons.push("matched_expected_query_context");
  if (missedExpectedQueries.length > 0)
    reasons.push("missed_expected_query_context");
  if (unexpectedInjectedSessionIds.length > 0)
    reasons.push("unexpected_injected_session");
  if (unexpectedQueryContextLines.length > 0)
    reasons.push("unexpected_query_context");
  if (noUsefulExpected && opts.userPromptLines.length === 0) {
    reasons.push("correctly_returned_no_context");
  }
  if (reasons.length === 0) reasons.push("matches_label");

  return {
    status: "labeled",
    reviewStatus: opts.label.reviewStatus,
    expectedSessionIds,
    injectedExpectedSessionIds,
    missedExpectedSessionIds,
    unexpectedInjectedSessionIds,
    expectedQueries,
    injectedExpectedQueries,
    missedExpectedQueries,
    queryContextLines,
    unexpectedQueryContextLines,
    sourceGapCount,
    noUsefulExpected,
    falseNegative,
    precisionLike,
    recallLike,
    reasons,
  };
}

function extractQueryContextLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes("query_kind="));
}

function queryContextSatisfiesExpectedQuery(
  expectedQuery: string,
  queryContextLines: string[],
): boolean {
  if (queryContextLines.length === 0) return false;

  const expectedText = expectedQuery.toLowerCase();
  const expectedTerms = extractAssessmentTerms(expectedQuery);
  const specificTerms = expectedTerms.filter(
    (term) => term.strong || term.weight > 1,
  );
  const candidateTerms =
    specificTerms.length > 0 ? specificTerms : expectedTerms.slice(0, 6);

  for (const line of queryContextLines) {
    const lineText = line.toLowerCase();
    const kind = extractQueryKind(line);
    if (queryKindMatchesExpectedQuery(kind, expectedText)) return true;

    const matchedTerms = candidateTerms.filter((term) =>
      lineText.includes(term.term),
    );
    const matchedStrongTerms = matchedTerms.filter((term) => term.strong);
    const matchedWeight = matchedTerms.reduce(
      (sum, term) => sum + term.weight,
      0,
    );
    if (matchedStrongTerms.length > 0) return true;
    if (matchedTerms.length >= 2 && matchedWeight >= 4) return true;
    if (matchedTerms.length >= 3) return true;
  }

  return false;
}

function extractQueryKind(line: string): string | null {
  return line.match(/\bquery_kind=([^\s]+)/)?.[1] ?? null;
}

function queryKindMatchesExpectedQuery(
  kind: string | null,
  expectedText: string,
): boolean {
  switch (kind) {
    case "hook_code":
      return (
        hasAllExpectedTerms(expectedText, ["hook"]) &&
        hasAnyExpectedTerm(expectedText, [
          "additionalcontext",
          "additional context",
          "codex",
          "injection",
          "entry points",
        ])
      );
    case "external_data_sources":
      return hasAnyExpectedTerm(expectedText, ["fml", "anamnesis", "team"]);
    case "panopticon_capabilities":
      return (
        hasAllExpectedTerms(expectedText, ["panopticon"]) &&
        hasAnyExpectedTerm(expectedText, [
          "capabilities",
          "data model",
          "tool surface",
          "comparison",
          "compare",
        ])
      );
    case "schema_sync":
      return hasAnyExpectedTerm(expectedText, [
        "schema",
        "sync",
        "panopticon_v2",
        "messageid",
        "relationshiptype",
      ]);
    case "session_summary_api":
      return hasAnyExpectedTerm(expectedText, [
        "session_summary_detail",
        "summary_detail",
        "compact session-summary",
        "compact context",
        "preview shape",
        "output contract",
      ]);
    case "hook_events":
      return hasAnyExpectedTerm(expectedText, [
        "hook_events",
        "pretooluse",
        "posttooluse",
        "userpromptsubmit",
      ]);
    case "enrichment_stats":
      return hasAnyExpectedTerm(expectedText, [
        "session_summary_enrichments",
        "enrichment",
        "regenerated",
      ]);
    case "userpromptsubmit_corpus":
      return (
        hasAllExpectedTerms(expectedText, ["userpromptsubmit"]) &&
        hasAnyExpectedTerm(expectedText, [
          "corpus",
          "prompt list",
          "first",
          "later",
        ])
      );
    case "related_prompt":
      return hasAnyExpectedTerm(expectedText, [
        "deferred",
        "prior",
        "previous",
        "related",
        "session id",
        "pr ",
        "branch",
        "review",
        "left off",
        "resume",
      ]);
    default:
      return false;
  }
}

function hasAllExpectedTerms(text: string, terms: string[]): boolean {
  return terms.every((term) => text.includes(term));
}

function hasAnyExpectedTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function hasActionableLabel(label: EvalPromptLabel): boolean {
  return (
    label.reviewStatus !== "unreviewed" ||
    label.expectedUsefulPanopticon.length > 0 ||
    label.noUsefulPanopticonExpected !== null
  );
}

function calculatePrecisionLike(opts: {
  noUsefulExpected: boolean;
  injectedCount: number;
  expectedSessionCount: number;
  hitCount: number;
}): number | null {
  if (opts.noUsefulExpected) return opts.injectedCount === 0 ? 1 : 0;
  if (opts.injectedCount === 0 || opts.expectedSessionCount === 0) return null;
  return roundMetric(opts.hitCount / opts.injectedCount);
}

function summarizeSubsequentActivity(outcome: SubsequentActivity): string[] {
  const lines: string[] = [];
  lines.push(
    `window ${formatDate(outcome.window.startMs)} -> ${
      outcome.window.endMs === null
        ? "available_activity"
        : formatDate(outcome.window.endMs)
    } reason=${outcome.window.endReason}`,
  );
  if (outcome.window.nextPrompt) {
    lines.push(
      `next_prompt: ${oneLine(
        outcome.window.nextPrompt,
        LABEL_SUMMARY_FIELD_MAX_CHARS,
      )}`,
    );
  }

  for (const message of outcome.messages) {
    lines.push(
      `message ${message.ordinal} ${message.role}: ${oneLine(
        message.content,
        LABEL_SUMMARY_FIELD_MAX_CHARS,
      )}`,
    );
  }
  for (const event of outcome.hookEvents) {
    lines.push(describeHookEvent(event));
  }
  for (const call of outcome.toolCalls) {
    lines.push(describeToolCall(call));
  }
  for (const event of outcome.scannerEvents) {
    lines.push(describeScannerEvent(event));
  }

  return lines.slice(0, LABEL_SUMMARY_LIMIT);
}

function describeHookEvent(event: EvidenceHookEvent): string {
  const details = [
    event.toolName ? `tool=${event.toolName}` : null,
    event.filePath ? `file=${event.filePath}` : null,
    event.command ? `command=${oneLine(event.command, 120)}` : null,
    event.userPrompt ? `prompt=${oneLine(event.userPrompt, 120)}` : null,
    event.toolResult ? `result=${oneLine(event.toolResult, 120)}` : null,
  ].filter(isNonNull);
  return oneLine(
    `hook ${formatDate(event.timestampMs)} ${event.eventType} ${details.join(" ")}`,
    LABEL_SUMMARY_FIELD_MAX_CHARS,
  );
}

function describeToolCall(call: EvidenceToolCall): string {
  const details = [
    `tool=${call.toolName}`,
    `category=${call.category}`,
    call.input ? `input=${oneLine(call.input, 120)}` : null,
    call.result ? `result=${oneLine(call.result, 120)}` : null,
  ].filter(isNonNull);
  return oneLine(
    `tool_call ${
      call.timestampMs === null ? "unknown_time" : formatDate(call.timestampMs)
    } message=${call.messageOrdinal ?? "unknown"} ${details.join(" ")}`,
    LABEL_SUMMARY_FIELD_MAX_CHARS,
  );
}

function describeScannerEvent(event: EvidenceScannerEvent): string {
  const details = [
    event.toolName ? `tool=${event.toolName}` : null,
    event.toolInput ? `input=${oneLine(event.toolInput, 120)}` : null,
    event.toolOutput ? `output=${oneLine(event.toolOutput, 120)}` : null,
    event.content ? `content=${oneLine(event.content, 120)}` : null,
  ].filter(isNonNull);
  return oneLine(
    `scanner ${formatDate(event.timestampMs)} ${event.eventType} ${details.join(" ")}`,
    LABEL_SUMMARY_FIELD_MAX_CHARS,
  );
}

function isEvalPromptLabel(value: unknown): value is EvalPromptLabel {
  if (!value || typeof value !== "object") return false;
  const label = value as Partial<EvalPromptLabel>;
  return (
    typeof label.promptKey === "string" &&
    typeof label.sessionId === "string" &&
    Array.isArray(label.whatHappened) &&
    Array.isArray(label.injectedContext) &&
    Array.isArray(label.expectedUsefulPanopticon) &&
    isLabelReviewStatus(label.reviewStatus)
  );
}

function isLabelReviewStatus(value: unknown): value is LabelReviewStatus {
  return (
    value === "unreviewed" ||
    value === "llm_draft" ||
    value === "human_reviewed"
  );
}

function promptKey(prompt: EvalPrompt): string {
  return `${prompt.sessionId}:${prompt.promptIndex}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function roundMetric(value: number): number {
  return Number(value.toFixed(2));
}

function countJudgeUtilityLevels(
  results: EvalResult[],
): Record<JudgeUtilityLevel, number> {
  const counts: Record<JudgeUtilityLevel, number> = {
    none: 0,
    low: 0,
    medium: 0,
    high: 0,
  };
  for (const result of results) {
    const level = result.llmJudge?.result?.overallUtility;
    if (level) counts[level] += 1;
  }
  return counts;
}

async function judgePromptWithLlm(opts: {
  prompt: EvalPrompt;
  result: EvalResult;
  args: Args;
}): Promise<LlmJudgeAssessment> {
  const runner =
    opts.args.judgeRunner ??
    inferRunnerFromSessionTarget(opts.prompt.target) ??
    "claude";
  const model = opts.args.judgeModel;
  const outcome = loadSubsequentActivity(opts.prompt);
  const judgePrompt = buildLlmJudgePrompt({
    prompt: opts.prompt,
    result: opts.result,
    outcome,
    maxChars: opts.args.judgeMaxChars,
  });
  if (opts.args.judgeDryRun) {
    return {
      status: "skipped",
      runner,
      model,
      error: "judge_dry_run",
      judgePrompt,
      outcome,
    };
  }

  // The runner CLI occasionally returns nothing (transient). One retry
  // recovers virtually all of these without skewing results.
  let rawOutput: string | null = null;
  for (let attempt = 0; attempt < 2 && !rawOutput; attempt++) {
    rawOutput = await invokeLlmAsync(judgePrompt, {
      runner,
      model,
      timeoutMs: opts.args.judgeTimeoutMs,
      withMcp: false,
      systemPrompt: LLM_JUDGE_SYSTEM_PROMPT,
    });
  }
  if (!rawOutput) {
    return {
      status: "failed",
      runner,
      model,
      error: "LLM runner returned no output",
      outcome,
    };
  }

  const parsed = parseLlmJudgeResult(rawOutput);
  if (!parsed.ok) {
    return {
      status: "failed",
      runner,
      model,
      error: parsed.error,
      rawOutput: trimToMaxChars(rawOutput, 4_000),
      outcome,
    };
  }

  return {
    status: "ok",
    runner,
    model,
    rawOutput: trimToMaxChars(rawOutput, 4_000),
    outcome,
    result: parsed.result,
  };
}

function loadSubsequentActivity(prompt: EvalPrompt): SubsequentActivity {
  const db = getDb();
  const nextPrompt = db
    .prepare(
      `SELECT id, timestamp_ms, user_prompt
       FROM hook_events
       WHERE session_id = ?
         AND event_type = 'UserPromptSubmit'
         AND (
           timestamp_ms > ?
           OR (timestamp_ms = ? AND id > ?)
         )
       ORDER BY timestamp_ms ASC, id ASC
       LIMIT 1`,
    )
    .get(prompt.sessionId, prompt.timestampMs, prompt.timestampMs, prompt.id) as
    | { id: number; timestamp_ms: number; user_prompt: string | null }
    | undefined;
  const session = db
    .prepare(
      `SELECT ended_at_ms
       FROM sessions
       WHERE session_id = ?`,
    )
    .get(prompt.sessionId) as { ended_at_ms: number | null } | undefined;
  const endMs = nextPrompt?.timestamp_ms ?? session?.ended_at_ms ?? null;
  const endReason = nextPrompt
    ? "next_user_prompt"
    : session?.ended_at_ms
      ? "session_end"
      : "available_activity";

  return {
    window: {
      startMs: prompt.timestampMs,
      endMs,
      endReason,
      nextPrompt: nextPrompt?.user_prompt ?? null,
    },
    messages: loadEvidenceMessages(prompt, endMs),
    hookEvents: loadEvidenceHookEvents(prompt, nextPrompt ?? null),
    toolCalls: loadEvidenceToolCalls(prompt, endMs),
    scannerEvents: loadEvidenceScannerEvents(prompt, endMs),
  };
}

function loadEvidenceMessages(
  prompt: EvalPrompt,
  endMs: number | null,
): EvidenceMessage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT timestamp_ms, ordinal, role, content
       FROM messages
       WHERE session_id = ?
         AND timestamp_ms IS NOT NULL
         AND timestamp_ms >= ?
         ${endMs === null ? "" : "AND timestamp_ms < ?"}
         AND is_system = 0
       ORDER BY timestamp_ms ASC, ordinal ASC
       LIMIT ?`,
    )
    .all(
      prompt.sessionId,
      prompt.timestampMs,
      ...(endMs === null ? [] : [endMs]),
      JUDGE_MESSAGE_LIMIT,
    ) as Array<{
    timestamp_ms: number | null;
    ordinal: number;
    role: string;
    content: string;
  }>;
  return rows.map((row) => ({
    timestampMs: row.timestamp_ms,
    ordinal: row.ordinal,
    role: row.role,
    content: trimToMaxChars(row.content, JUDGE_FIELD_MAX_CHARS),
  }));
}

function loadEvidenceHookEvents(
  prompt: EvalPrompt,
  nextPrompt: { id: number; timestamp_ms: number } | null,
): EvidenceHookEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, timestamp_ms, event_type, tool_name, user_prompt, file_path, command, tool_result
       FROM hook_events
       WHERE session_id = ?
         AND (
           timestamp_ms > ?
           OR (timestamp_ms = ? AND id > ?)
         )
         ${
           nextPrompt === null
             ? ""
             : `AND (
                  timestamp_ms < ?
                  OR (timestamp_ms = ? AND id < ?)
                )`
         }
       ORDER BY timestamp_ms ASC, id ASC
       LIMIT ?`,
    )
    .all(
      prompt.sessionId,
      prompt.timestampMs,
      prompt.timestampMs,
      prompt.id,
      ...(nextPrompt === null
        ? []
        : [nextPrompt.timestamp_ms, nextPrompt.timestamp_ms, nextPrompt.id]),
      JUDGE_HOOK_EVENT_LIMIT,
    ) as Array<{
    id: number;
    timestamp_ms: number;
    event_type: string;
    tool_name: string | null;
    user_prompt: string | null;
    file_path: string | null;
    command: string | null;
    tool_result: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    timestampMs: row.timestamp_ms,
    eventType: row.event_type,
    toolName: row.tool_name,
    userPrompt: trimNullable(row.user_prompt, JUDGE_FIELD_MAX_CHARS),
    filePath: row.file_path,
    command: trimNullable(row.command, JUDGE_FIELD_MAX_CHARS),
    toolResult: trimNullable(row.tool_result, JUDGE_FIELD_MAX_CHARS),
  }));
}

function loadEvidenceToolCalls(
  prompt: EvalPrompt,
  endMs: number | null,
): EvidenceToolCall[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.timestamp_ms,
              m.ordinal AS message_ordinal,
              tc.tool_name,
              tc.category,
              tc.input_json,
              tc.result_content
       FROM tool_calls tc
       LEFT JOIN messages m
         ON m.id = tc.message_id
       WHERE tc.session_id = ?
         AND m.timestamp_ms IS NOT NULL
         AND m.timestamp_ms >= ?
         ${endMs === null ? "" : "AND m.timestamp_ms < ?"}
       ORDER BY m.timestamp_ms ASC, m.ordinal ASC, tc.call_index ASC
       LIMIT ?`,
    )
    .all(
      prompt.sessionId,
      prompt.timestampMs,
      ...(endMs === null ? [] : [endMs]),
      JUDGE_TOOL_CALL_LIMIT,
    ) as Array<{
    timestamp_ms: number | null;
    message_ordinal: number | null;
    tool_name: string;
    category: string;
    input_json: string | null;
    result_content: string | null;
  }>;
  return rows.map((row) => ({
    timestampMs: row.timestamp_ms,
    messageOrdinal: row.message_ordinal,
    toolName: row.tool_name,
    category: row.category,
    input: trimNullable(row.input_json, JUDGE_FIELD_MAX_CHARS),
    result: trimNullable(row.result_content, JUDGE_FIELD_MAX_CHARS),
  }));
}

function loadEvidenceScannerEvents(
  prompt: EvalPrompt,
  endMs: number | null,
): EvidenceScannerEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT timestamp_ms, event_type, tool_name, tool_input, tool_output, content
       FROM scanner_events
       WHERE session_id = ?
         AND timestamp_ms >= ?
         ${endMs === null ? "" : "AND timestamp_ms < ?"}
       ORDER BY timestamp_ms ASC, event_index ASC
       LIMIT ?`,
    )
    .all(
      prompt.sessionId,
      prompt.timestampMs,
      ...(endMs === null ? [] : [endMs]),
      JUDGE_SCANNER_EVENT_LIMIT,
    ) as Array<{
    timestamp_ms: number;
    event_type: string;
    tool_name: string | null;
    tool_input: string | null;
    tool_output: string | null;
    content: string | null;
  }>;
  return rows.map((row) => ({
    timestampMs: row.timestamp_ms,
    eventType: row.event_type,
    toolName: row.tool_name,
    toolInput: trimNullable(row.tool_input, JUDGE_FIELD_MAX_CHARS),
    toolOutput: trimNullable(row.tool_output, JUDGE_FIELD_MAX_CHARS),
    content: trimNullable(row.content, JUDGE_FIELD_MAX_CHARS),
  }));
}

function buildLlmJudgePrompt(opts: {
  prompt: EvalPrompt;
  result: EvalResult;
  outcome: SubsequentActivity;
  maxChars: number;
}): string {
  const payload = {
    task: "Judge whether the injected context was useful for what happened after this prompt.",
    prompt: {
      sessionId: opts.prompt.sessionId,
      timestamp: formatDate(opts.prompt.timestampMs),
      target: opts.prompt.target,
      project: opts.prompt.project,
      cwd: opts.prompt.cwd,
      repository: opts.prompt.repository,
      promptIndex: opts.prompt.promptIndex,
      promptCount: opts.prompt.promptCount,
      text: opts.prompt.prompt,
    },
    injectedContext: opts.result.userPromptLines.map((line) => ({
      sessionId: extractSessionIdFromLine(line),
      line,
    })),
    deterministicAssessment: opts.result.usefulness,
    sessionStartOverlapSessionIds: opts.result.overlapSessionIds,
    subsequentActivity: opts.outcome,
  };
  return trimToMaxChars(JSON.stringify(payload, null, 2), opts.maxChars);
}

function parseLlmJudgeResult(
  rawOutput: string,
): { ok: true; result: LlmJudgeResult } | { ok: false; error: string } {
  const jsonText = extractJsonObject(rawOutput);
  if (!jsonText) return { ok: false, error: "No JSON object found in output" };
  try {
    const parsed = JSON.parse(jsonText) as Partial<LlmJudgeResult>;
    const numericScore =
      typeof parsed.score === "number" && Number.isFinite(parsed.score)
        ? Math.max(0, Math.min(3, parsed.score))
        : null;
    // Be tolerant: a judge that produced a usable verdict but fumbled one
    // enum field should still count. Only hard-fail when we can't recover
    // the core signal (utility) at all.
    const overallUtility = isJudgeUtilityLevel(parsed.overallUtility)
      ? parsed.overallUtility
      : numericScore !== null
        ? utilityLevelFromScore(numericScore)
        : null;
    if (overallUtility === null) {
      return { ok: false, error: "Invalid or missing overallUtility" };
    }
    const recommendedAction = isJudgeRecommendedAction(parsed.recommendedAction)
      ? parsed.recommendedAction
      : inferRecommendedAction(overallUtility);
    const score = numericScore ?? utilityScore(overallUtility);
    return {
      ok: true,
      result: {
        overallUtility,
        score,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
        items: Array.isArray(parsed.items)
          ? parsed.items.map(normalizeJudgeItem).filter(isNonNull)
          : [],
        missedContext: Array.isArray(parsed.missedContext)
          ? parsed.missedContext.map(normalizeMissedContext).filter(isNonNull)
          : [],
        recommendedAction,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractJsonObject(rawOutput: string): string | null {
  const fenced = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("{")) return fenced;
  const start = rawOutput.indexOf("{");
  const end = rawOutput.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return rawOutput.slice(start, end + 1);
}

function normalizeJudgeItem(value: unknown): LlmJudgeItemResult | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<LlmJudgeItemResult>;
  if (typeof item.sessionId !== "string" || !isJudgeItemUtility(item.utility)) {
    return null;
  }
  return {
    sessionId: item.sessionId,
    utility: item.utility,
    reason: typeof item.reason === "string" ? item.reason : "",
    evidence: typeof item.evidence === "string" ? item.evidence : "",
  };
}

function normalizeMissedContext(value: unknown): LlmJudgeMissedContext | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<LlmJudgeMissedContext>;
  if (typeof item.query !== "string" || typeof item.reason !== "string") {
    return null;
  }
  return {
    query: item.query,
    reason: item.reason,
    evidence: typeof item.evidence === "string" ? item.evidence : "",
  };
}

function isJudgeUtilityLevel(value: unknown): value is JudgeUtilityLevel {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

function isJudgeItemUtility(value: unknown): value is JudgeItemUtility {
  return (
    value === "irrelevant" ||
    value === "weak" ||
    value === "useful" ||
    value === "critical"
  );
}

function isJudgeRecommendedAction(
  value: unknown,
): value is JudgeRecommendedAction {
  return (
    value === "keep" ||
    value === "tighten" ||
    value === "broaden" ||
    value === "label_for_review"
  );
}

function utilityLevelFromScore(score: number): JudgeUtilityLevel {
  if (score >= 2.5) return "high";
  if (score >= 1.5) return "medium";
  if (score >= 0.5) return "low";
  return "none";
}

// When the judge omits/garbles recommendedAction, derive a reasonable one
// from the utility verdict: useful context → keep, weak/none → broaden
// (most "none" cases in practice are "nothing was injected").
function inferRecommendedAction(
  level: JudgeUtilityLevel,
): JudgeRecommendedAction {
  if (level === "high" || level === "medium") return "keep";
  if (level === "low") return "tighten";
  return "broaden";
}

function utilityScore(level: JudgeUtilityLevel): number {
  switch (level) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    case "none":
      return 0;
  }
}

function trimNullable(value: string | null, maxChars: number): string | null {
  return value === null ? null : trimToMaxChars(value, maxChars);
}

function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString();
}

function oneLine(value: string, maxChars: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
