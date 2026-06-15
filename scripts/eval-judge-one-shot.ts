#!/usr/bin/env node

// Judge one-shot replay results after execution.
//
// This is intentionally separate from preparation and execution. It reads the
// one-shot prep manifest, inspects existing per-arm worktrees, and asks an LLM
// judge whether each attempt accomplished the historical PR's user-visible
// behavior. Deterministic file-set diagnostics are reported as scope signals,
// not as the final verdict.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config, type SessionSummaryRunnerName } from "../src/config.js";
import { Database } from "../src/db/driver.js";
import { invokeLlmAsync } from "../src/summary/llm.js";

const DEFAULT_PREP_DIR = path.join(".tmp", "evals", "replay-one-shot-prep");
const DEFAULT_REPO_ROOT = resolveDefaultRepoRoot();
const DEFAULT_WORKTREE_ROOT = path.join(os.tmpdir(), "pano-one-shot-worktrees");
const JUDGE_DIFF_PATCH_MAX_CHARS = 24_000;
const RESULT_DIFF_PATCH_MAX_CHARS = 48_000;
const FINAL_MESSAGE_MAX_CHARS = 4_000;

type Verdict = "accomplished" | "partial" | "failed" | "unknown";
type QualityComparison = "better" | "same" | "worse" | "unknown";
type JudgeRunner = Extract<SessionSummaryRunnerName, "claude" | "codex">;

interface Args {
  prepDir: string;
  repoRoot: string;
  worktreeRoot: string;
  prNumbers: number[];
  sessionIds: string[];
  arms: string[];
  resultJson: string;
  reportMarkdown: string;
  judgeRunner: JudgeRunner;
  judgeModel: string | null;
  skipJudge: boolean;
}

interface Manifest {
  repo_root?: string;
  rows: ManifestRow[];
}

interface ManifestRow {
  date?: string;
  session_id: string;
  pr_number: number;
  merge_commit: string;
  branch?: string;
  title?: string;
  base_commit: string;
  started_at_ms: number;
  prompt_path: string;
  expected_files: string[];
  expected_file_count: number;
  diffstat_path: string;
  leakage_warnings?: string[];
}

interface ArmAttempt {
  arm: string;
  worktree: string;
  worktree_exists: boolean;
  status: string;
  changed_files: string[];
  matched_expected_files: string[];
  unexpected_files: string[];
  file_recall: number | null;
  exact_file_set: boolean | null;
  diff_summary: string;
  diff_patch: string;
  diff_patch_truncated: boolean;
  final_message_path: string | null;
  final_message_excerpt: string | null;
  resource_usage: ArmResourceUsage;
}

interface ScenarioJudgment {
  pr_number: number;
  session_id: string;
  title?: string;
  base_commit: string;
  merge_commit: string;
  prompt_path: string;
  expected_files: string[];
  arms: ArmAttempt[];
  comparisons: PairwiseImpact[];
  judge: {
    verdicts: Record<string, Verdict>;
    quality_vs_original: Record<string, QualityComparison>;
    notes: string;
    quality_notes: string;
    raw_response: string | null;
  };
}

interface PairwiseImpact {
  control_arm: string;
  treatment_arm: string;
  outcome: "win" | "tie" | "loss" | "unknown";
  control_verdict: Verdict;
  treatment_verdict: Verdict;
  verdict_delta: number | null;
  control_quality_vs_original: QualityComparison;
  treatment_quality_vs_original: QualityComparison;
  quality_delta: number | null;
  file_recall_delta: number | null;
  unexpected_files_delta: number | null;
  changed_files_delta: number | null;
  exact_file_set_change:
    | "same"
    | "treatment_gained"
    | "treatment_lost"
    | "unknown";
  resource_usage_delta: ResourceUsageDelta | null;
}

interface ArmResourceUsageUnavailable {
  available: false;
  source: "panopticon_db";
  db_path: string | null;
  worktree: string;
  reason: string;
}

interface ArmResourceUsageAvailable {
  available: true;
  source: "panopticon_db";
  db_path: string;
  matched_by: "session_cwds.cwd" | "sessions.target";
  worktree: string;
  session_id: string;
  model: string | null;
  started_at_ms: number | null;
  ended_at_ms: number | null;
  elapsed_ms: number | null;
  turn_count: number;
  message_count: number;
  user_message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  context_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
  pricing: {
    model_id: string;
    input_per_m: number;
    output_per_m: number;
    cache_read_per_m: number;
    cache_write_per_m: number;
    updated_ms: number;
  } | null;
  tool_calls: number;
  tool_duration_ms: number | null;
}

type ArmResourceUsage = ArmResourceUsageAvailable | ArmResourceUsageUnavailable;

interface ResourceUsageDelta {
  control_available: boolean;
  treatment_available: boolean;
  elapsed_ms_delta: number | null;
  elapsed_pct_delta: number | null;
  turn_delta: number | null;
  turn_pct_delta: number | null;
  input_token_delta: number | null;
  input_token_pct_delta: number | null;
  cache_read_token_delta: number | null;
  cache_read_token_pct_delta: number | null;
  context_token_delta: number | null;
  context_token_pct_delta: number | null;
  output_token_delta: number | null;
  output_token_pct_delta: number | null;
  reasoning_token_delta: number | null;
  reasoning_token_pct_delta: number | null;
  total_token_delta: number | null;
  total_token_pct_delta: number | null;
  estimated_cost_usd_delta: number | null;
  estimated_cost_pct_delta: number | null;
  tool_call_delta: number | null;
  tool_call_pct_delta: number | null;
  tool_duration_ms_delta: number | null;
  tool_duration_pct_delta: number | null;
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(entry).href : false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest(args.prepDir);
  const rows = selectRows(manifest.rows, args);
  if (rows.length === 0) {
    throw new Error("No prepared one-shot rows matched the judge filters");
  }

  const results: ScenarioJudgment[] = [];
  for (const row of rows) {
    console.error(`Judging PR #${row.pr_number} (${row.session_id})`);
    const result = await judgeScenario(row, args);
    results.push(result);
    const summary = Object.entries(result.judge.verdicts)
      .map(([arm, verdict]) => `${arm}=${verdict}`)
      .join(" ");
    const impactSummary = result.comparisons
      .map(
        (comparison) =>
          `${comparison.control_arm}->${comparison.treatment_arm}:${comparison.outcome}`,
      )
      .join(" ");
    const qualitySummary = result.comparisons
      .map(
        (comparison) =>
          `${comparison.control_arm}->${comparison.treatment_arm}:quality_delta=${comparison.quality_delta ?? "n/a"}`,
      )
      .join(" ");
    console.error(`  ${summary || "no verdicts"} ${result.judge.notes}`);
    if (impactSummary) console.error(`  impact ${impactSummary}`);
    if (qualitySummary) console.error(`  quality ${qualitySummary}`);
  }

  writeJson(args.resultJson, {
    generated_at: new Date().toISOString(),
    prep_dir: args.prepDir,
    repo_root: args.repoRoot,
    worktree_root: args.worktreeRoot,
    judge_runner: args.skipJudge ? null : args.judgeRunner,
    judge_model: args.skipJudge ? null : args.judgeModel,
    resource_usage_notes: [
      "Arm resource usage is collected from the local Panopticon database at judge time by matching each replay worktree to session_cwds.cwd, falling back to sessions.target.",
      "Token and cache-read values are per-session Codex-reported totals. Sequential arm execution can make provider prompt-cache behavior order-dependent, so cache-read deltas should be interpreted with randomized or repeated arm ordering.",
    ],
    results,
  });
  writeText(args.reportMarkdown, renderMarkdownReport(results, args));
  console.log(`Wrote ${args.resultJson}`);
  console.log(`Wrote ${args.reportMarkdown}`);
}

async function judgeScenario(
  row: ManifestRow,
  args: Args,
): Promise<ScenarioJudgment> {
  const arms = args.arms.map((arm) => collectArmAttempt(row, arm, args));
  if (args.skipJudge) {
    const verdicts = Object.fromEntries(
      arms.map((arm) => [arm.arm, "unknown" as Verdict]),
    );
    const qualityVsOriginal = Object.fromEntries(
      arms.map((arm) => [arm.arm, "unknown" as QualityComparison]),
    );
    return {
      pr_number: row.pr_number,
      session_id: row.session_id,
      title: row.title,
      base_commit: row.base_commit,
      merge_commit: row.merge_commit,
      prompt_path: row.prompt_path,
      expected_files: row.expected_files,
      arms,
      comparisons: buildPairwiseImpacts(arms, verdicts, qualityVsOriginal),
      judge: {
        verdicts,
        quality_vs_original: qualityVsOriginal,
        notes: "judge skipped",
        quality_notes: "judge skipped",
        raw_response: null,
      },
    };
  }

  const prompt = buildOneShotJudgePrompt({
    row,
    userGoal: safeReadText(row.prompt_path).trim(),
    expectedDiffstat: safeReadText(row.diffstat_path).trim(),
    expectedPatch: readGitShowPatch(args.repoRoot, row.merge_commit),
    arms,
  });
  const raw = await invokeLlmAsync(prompt, {
    runner: args.judgeRunner,
    model: args.judgeModel,
    timeoutMs: 120_000,
  });
  const parsed = parseJudgeResponse(
    raw,
    arms.map((arm) => arm.arm),
  );

  return {
    pr_number: row.pr_number,
    session_id: row.session_id,
    title: row.title,
    base_commit: row.base_commit,
    merge_commit: row.merge_commit,
    prompt_path: row.prompt_path,
    expected_files: row.expected_files,
    arms,
    comparisons: buildPairwiseImpacts(
      arms,
      parsed.verdicts,
      parsed.qualityVsOriginal,
    ),
    judge: {
      verdicts: parsed.verdicts,
      quality_vs_original: parsed.qualityVsOriginal,
      notes: parsed.notes,
      quality_notes: parsed.qualityNotes,
      raw_response: raw,
    },
  };
}

export function buildOneShotJudgePrompt(input: {
  row: Pick<ManifestRow, "pr_number" | "title" | "expected_files">;
  userGoal: string;
  expectedDiffstat: string;
  expectedPatch: { value: string; truncated: boolean } | null;
  arms: ArmAttempt[];
}): string {
  return `You are judging whether one-shot coding attempts accomplished the same user-visible work as a historical merged PR.

User-facing goal prompt given to every attempt:
${input.userGoal || "(not available)"}

Ground truth: the historical session merged PR #${input.row.pr_number}${input.row.title ? ` ("${input.row.title}")` : ""}.
Ground-truth git diff --stat:
${input.expectedDiffstat || "(not available)"}

Ground-truth patch excerpt:
${input.expectedPatch?.value || "(not available)"}
${input.expectedPatch?.truncated ? "\n[ground-truth patch truncated]" : ""}

Expected PR oracle files:
${input.row.expected_files.length > 0 ? input.row.expected_files.map((file) => `- ${file}`).join("\n") : "(none)"}

${input.arms.map(formatArmForJudge).join("\n\n")}

Verdict rubric:
- accomplished: the attempt plausibly implements the same externally relevant behavior/change, even if code organization, constant placement, tests, names, formatting, or exact patch shape differ from the merged PR.
- partial: the attempt addresses the right area but leaves a material part of the intended behavior incomplete, unimplemented, or likely broken.
- failed: the attempt is missing the intended behavior, changes the wrong area, or does not complete.

Quality-vs-original rubric:
- better: the attempt is materially better than the historical merged patch in maintainability, generality, test coverage, regression risk, or simplicity while preserving the intended behavior.
- same: the attempt and historical patch are comparable overall, or differences are mostly stylistic/organizational tradeoffs.
- worse: the attempt is materially worse than the historical patch because it is less maintainable, less general, riskier, overbroad, under-tested, or changes behavior unnecessarily.
- unknown: there is not enough evidence to compare quality.

Treat deterministic file-set diagnostics as evidence, not as the verdict. Do not mark an attempt partial solely because it touched different files from the historical PR. If the attempt implements the same externally relevant behavior with a reasonable alternate structure, mark it accomplished.

Respond as strict JSON using exactly these attempt keys:
${JSON.stringify({
  ...Object.fromEntries(
    input.arms.map((arm) => [arm.arm, "accomplished|partial|failed"]),
  ),
  quality_vs_original: Object.fromEntries(
    input.arms.map((arm) => [arm.arm, "better|same|worse|unknown"]),
  ),
  notes: "one sentence explaining the key outcome distinction",
  quality_notes:
    "one sentence comparing attempt quality to the historical original solution",
})}`;
}

export function buildPairwiseImpacts(
  arms: ArmAttempt[],
  verdicts: Record<string, Verdict>,
  qualityVsOriginal: Record<string, QualityComparison> = {},
): PairwiseImpact[] {
  if (arms.length < 2) return [];
  const control = arms.find((arm) => arm.arm === "none") ?? arms[0];
  return arms
    .filter((arm) => arm.arm !== control.arm)
    .map((treatment) =>
      compareArms({
        control,
        treatment,
        verdicts,
        qualityVsOriginal,
      }),
    );
}

function compareArms(input: {
  control: ArmAttempt;
  treatment: ArmAttempt;
  verdicts: Record<string, Verdict>;
  qualityVsOriginal: Record<string, QualityComparison>;
}): PairwiseImpact {
  const controlVerdict = input.verdicts[input.control.arm] ?? "unknown";
  const treatmentVerdict = input.verdicts[input.treatment.arm] ?? "unknown";
  const controlQuality =
    input.qualityVsOriginal[input.control.arm] ?? "unknown";
  const treatmentQuality =
    input.qualityVsOriginal[input.treatment.arm] ?? "unknown";
  const controlScore = verdictScore(controlVerdict);
  const treatmentScore = verdictScore(treatmentVerdict);
  const controlQualityScore = qualityScore(controlQuality);
  const treatmentQualityScore = qualityScore(treatmentQuality);
  const verdictDelta =
    controlScore == null || treatmentScore == null
      ? null
      : treatmentScore - controlScore;
  const qualityDelta =
    controlQualityScore == null || treatmentQualityScore == null
      ? null
      : treatmentQualityScore - controlQualityScore;
  return {
    control_arm: input.control.arm,
    treatment_arm: input.treatment.arm,
    outcome: impactOutcome(verdictDelta),
    control_verdict: controlVerdict,
    treatment_verdict: treatmentVerdict,
    verdict_delta: verdictDelta,
    control_quality_vs_original: controlQuality,
    treatment_quality_vs_original: treatmentQuality,
    quality_delta: qualityDelta,
    file_recall_delta: numericDelta(
      input.treatment.file_recall,
      input.control.file_recall,
    ),
    unexpected_files_delta:
      input.treatment.unexpected_files.length -
      input.control.unexpected_files.length,
    changed_files_delta:
      input.treatment.changed_files.length - input.control.changed_files.length,
    exact_file_set_change: exactFileSetChange(
      input.control.exact_file_set,
      input.treatment.exact_file_set,
    ),
    resource_usage_delta: buildResourceUsageDelta(
      input.control.resource_usage,
      input.treatment.resource_usage,
    ),
  };
}

function verdictScore(verdict: Verdict): number | null {
  switch (verdict) {
    case "failed":
      return 0;
    case "partial":
      return 1;
    case "accomplished":
      return 2;
    case "unknown":
      return null;
  }
}

function qualityScore(quality: QualityComparison): number | null {
  switch (quality) {
    case "worse":
      return 0;
    case "same":
      return 1;
    case "better":
      return 2;
    case "unknown":
      return null;
  }
}

function impactOutcome(delta: number | null): PairwiseImpact["outcome"] {
  if (delta == null) return "unknown";
  if (delta > 0) return "win";
  if (delta < 0) return "loss";
  return "tie";
}

function numericDelta(
  treatment: number | null,
  control: number | null,
): number | null {
  return treatment == null || control == null ? null : treatment - control;
}

function pctDelta(
  treatment: number | null,
  control: number | null,
): number | null {
  if (treatment == null || control == null || control === 0) return null;
  return ((treatment - control) / control) * 100;
}

export function buildResourceUsageDelta(
  control: ArmResourceUsage,
  treatment: ArmResourceUsage,
): ResourceUsageDelta | null {
  if (!control.available || !treatment.available) {
    return {
      control_available: control.available,
      treatment_available: treatment.available,
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
    };
  }

  return {
    control_available: true,
    treatment_available: true,
    elapsed_ms_delta: numericDelta(treatment.elapsed_ms, control.elapsed_ms),
    elapsed_pct_delta: pctDelta(treatment.elapsed_ms, control.elapsed_ms),
    turn_delta: treatment.turn_count - control.turn_count,
    turn_pct_delta: pctDelta(treatment.turn_count, control.turn_count),
    input_token_delta: treatment.input_tokens - control.input_tokens,
    input_token_pct_delta: pctDelta(
      treatment.input_tokens,
      control.input_tokens,
    ),
    cache_read_token_delta:
      treatment.cache_read_tokens - control.cache_read_tokens,
    cache_read_token_pct_delta: pctDelta(
      treatment.cache_read_tokens,
      control.cache_read_tokens,
    ),
    context_token_delta: treatment.context_tokens - control.context_tokens,
    context_token_pct_delta: pctDelta(
      treatment.context_tokens,
      control.context_tokens,
    ),
    output_token_delta: treatment.output_tokens - control.output_tokens,
    output_token_pct_delta: pctDelta(
      treatment.output_tokens,
      control.output_tokens,
    ),
    reasoning_token_delta:
      treatment.reasoning_tokens - control.reasoning_tokens,
    reasoning_token_pct_delta: pctDelta(
      treatment.reasoning_tokens,
      control.reasoning_tokens,
    ),
    total_token_delta: treatment.total_tokens - control.total_tokens,
    total_token_pct_delta: pctDelta(
      treatment.total_tokens,
      control.total_tokens,
    ),
    estimated_cost_usd_delta: numericDelta(
      treatment.estimated_cost_usd,
      control.estimated_cost_usd,
    ),
    estimated_cost_pct_delta: pctDelta(
      treatment.estimated_cost_usd,
      control.estimated_cost_usd,
    ),
    tool_call_delta: treatment.tool_calls - control.tool_calls,
    tool_call_pct_delta: pctDelta(treatment.tool_calls, control.tool_calls),
    tool_duration_ms_delta: numericDelta(
      treatment.tool_duration_ms,
      control.tool_duration_ms,
    ),
    tool_duration_pct_delta: pctDelta(
      treatment.tool_duration_ms,
      control.tool_duration_ms,
    ),
  };
}

function exactFileSetChange(
  control: boolean | null,
  treatment: boolean | null,
): PairwiseImpact["exact_file_set_change"] {
  if (control == null || treatment == null) return "unknown";
  if (control === treatment) return "same";
  return treatment ? "treatment_gained" : "treatment_lost";
}

function formatArmForJudge(arm: ArmAttempt): string {
  const patch = truncateWithFlag(arm.diff_patch, JUDGE_DIFF_PATCH_MAX_CHARS);
  return `Attempt ${arm.arm}
Worktree status: ${arm.worktree_exists ? "present" : "missing"}
Git status:
${arm.status || "(clean)"}
Changed files:
${arm.changed_files.length > 0 ? arm.changed_files.map((file) => `- ${file}`).join("\n") : "(none)"}
Expected-file diagnostics: matched=${arm.matched_expected_files.length} unexpected=${arm.unexpected_files.length} recall=${arm.file_recall ?? "n/a"} exact=${arm.exact_file_set ?? "n/a"}
Final assistant message excerpt:
${arm.final_message_excerpt ?? "(not available)"}
Resulting diff summary:
${arm.diff_summary || "(no changes)"}
Patch excerpt:
${patch.value || "(no changes)"}
${patch.truncated || arm.diff_patch_truncated ? "[attempt patch truncated]" : ""}`;
}

export function parseJudgeResponse(
  raw: string | null,
  arms: string[],
): {
  verdicts: Record<string, Verdict>;
  qualityVsOriginal: Record<string, QualityComparison>;
  notes: string;
  qualityNotes: string;
} {
  const unknown = Object.fromEntries(
    arms.map((arm) => [arm, "unknown" as Verdict]),
  );
  const unknownQuality = Object.fromEntries(
    arms.map((arm) => [arm, "unknown" as QualityComparison]),
  );
  if (!raw) {
    return {
      verdicts: unknown,
      qualityVsOriginal: unknownQuality,
      notes: "judge invocation failed",
      qualityNotes: "judge invocation failed",
    };
  }
  try {
    const jsonText = extractJsonObject(raw);
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const quality = isRecord(parsed.quality_vs_original)
      ? parsed.quality_vs_original
      : {};
    return {
      verdicts: Object.fromEntries(
        arms.map((arm) => [arm, normalizeVerdict(parsed[arm])]),
      ),
      qualityVsOriginal: Object.fromEntries(
        arms.map((arm) => [arm, normalizeQualityComparison(quality[arm])]),
      ),
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
      qualityNotes:
        typeof parsed.quality_notes === "string" ? parsed.quality_notes : "",
    };
  } catch {
    return {
      verdicts: unknown,
      qualityVsOriginal: unknownQuality,
      notes: "judge parse failed",
      qualityNotes: "judge parse failed",
    };
  }
}

function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in judge response");
  }
  return raw.slice(start, end + 1);
}

function normalizeVerdict(value: unknown): Verdict {
  return value === "accomplished" || value === "partial" || value === "failed"
    ? value
    : "unknown";
}

function normalizeQualityComparison(value: unknown): QualityComparison {
  return value === "better" || value === "same" || value === "worse"
    ? value
    : "unknown";
}

function collectArmAttempt(
  row: ManifestRow,
  arm: string,
  args: Args,
): ArmAttempt {
  const worktree = path.join(args.worktreeRoot, `pr-${row.pr_number}-${arm}`);
  if (!fs.existsSync(worktree)) {
    const finalMessagePath = findFinalMessagePath(
      args.prepDir,
      row.pr_number,
      arm,
    );
    return {
      arm,
      worktree,
      worktree_exists: false,
      status: "missing worktree",
      changed_files: [],
      matched_expected_files: [],
      unexpected_files: [],
      file_recall: null,
      exact_file_set: null,
      diff_summary: "",
      diff_patch: "",
      diff_patch_truncated: false,
      final_message_path: finalMessagePath,
      final_message_excerpt: readFinalMessageExcerpt(finalMessagePath),
      resource_usage: unavailableResourceUsage(worktree, "missing worktree"),
    };
  }

  const status = git(worktree, ["status", "--porcelain=v1"]);
  const trackedChanged = lines(
    git(worktree, ["diff", "--name-only", row.base_commit, "--"]),
  );
  const untracked = lines(
    git(worktree, ["ls-files", "--others", "--exclude-standard"]),
  );
  const changedFiles = unique([...trackedChanged, ...untracked]).sort();
  const diagnostics = computeOutcomeDiagnostics(
    row.expected_files,
    changedFiles,
  );
  const trackedSummary = git(worktree, [
    "diff",
    "--stat",
    row.base_commit,
    "--",
  ]);
  const trackedPatch = git(worktree, ["diff", row.base_commit, "--"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const untrackedPatch = buildUntrackedPatch(worktree, untracked);
  const patch = truncateWithFlag(
    [trackedPatch, untrackedPatch].filter(Boolean).join("\n\n"),
    RESULT_DIFF_PATCH_MAX_CHARS,
  );
  const finalMessagePath = findFinalMessagePath(
    args.prepDir,
    row.pr_number,
    arm,
  );

  return {
    arm,
    worktree,
    worktree_exists: true,
    status,
    changed_files: changedFiles,
    ...diagnostics,
    diff_summary: appendUntrackedSummary(trackedSummary, untracked),
    diff_patch: patch.value,
    diff_patch_truncated: patch.truncated,
    final_message_path: finalMessagePath,
    final_message_excerpt: readFinalMessageExcerpt(finalMessagePath),
    resource_usage: collectArmResourceUsage(worktree),
  };
}

function unavailableResourceUsage(
  worktree: string,
  reason: string,
  dbPath: string | null = config.dbPath,
): ArmResourceUsageUnavailable {
  return {
    available: false,
    source: "panopticon_db",
    db_path: dbPath,
    worktree: path.resolve(worktree),
    reason,
  };
}

interface SessionUsageRow {
  session_id: string;
  matched_by: "session_cwds.cwd" | "sessions.target";
  model: string | null;
  started_at_ms: number | null;
  ended_at_ms: number | null;
  turn_count: number | null;
  message_count: number | null;
  user_message_count: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cache_read_tokens: number | null;
  total_cache_creation_tokens: number | null;
  total_reasoning_tokens: number | null;
}

interface PricingRow {
  model_id: string;
  input_per_m: number;
  output_per_m: number;
  cache_read_per_m: number;
  cache_write_per_m: number;
  updated_ms: number;
}

interface ToolUsageRow {
  tool_calls: number | null;
  tool_duration_ms: number | null;
}

export function collectArmResourceUsage(
  worktree: string,
  dbPath = config.dbPath,
): ArmResourceUsage {
  const resolvedWorktree = path.resolve(worktree);
  if (!fs.existsSync(dbPath)) {
    return unavailableResourceUsage(
      resolvedWorktree,
      "panopticon database not found",
      dbPath,
    );
  }

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const sessionRow =
      findSessionUsageRow(db, resolvedWorktree, "session_cwds.cwd") ??
      findSessionUsageRow(db, resolvedWorktree, "sessions.target");
    if (!sessionRow) {
      return unavailableResourceUsage(
        resolvedWorktree,
        "no Panopticon session matched the arm worktree",
        dbPath,
      );
    }

    const pricing = findPricingRow(db, sessionRow.model);
    const toolUsage = readToolUsage(db, sessionRow.session_id);
    const inputTokens = sessionRow.total_input_tokens ?? 0;
    const outputTokens = sessionRow.total_output_tokens ?? 0;
    const cacheReadTokens = sessionRow.total_cache_read_tokens ?? 0;
    const cacheCreationTokens = sessionRow.total_cache_creation_tokens ?? 0;
    const reasoningTokens = sessionRow.total_reasoning_tokens ?? 0;
    const contextTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
    const totalTokens = contextTokens + outputTokens;
    const estimatedCostUsd = pricing
      ? (inputTokens * pricing.input_per_m +
          outputTokens * pricing.output_per_m +
          cacheReadTokens * pricing.cache_read_per_m +
          cacheCreationTokens * pricing.cache_write_per_m) /
        1_000_000
      : null;

    return {
      available: true,
      source: "panopticon_db",
      db_path: dbPath,
      matched_by: sessionRow.matched_by,
      worktree: resolvedWorktree,
      session_id: sessionRow.session_id,
      model: sessionRow.model,
      started_at_ms: sessionRow.started_at_ms,
      ended_at_ms: sessionRow.ended_at_ms,
      elapsed_ms:
        sessionRow.started_at_ms != null && sessionRow.ended_at_ms != null
          ? sessionRow.ended_at_ms - sessionRow.started_at_ms
          : null,
      turn_count: sessionRow.turn_count ?? 0,
      message_count: sessionRow.message_count ?? 0,
      user_message_count: sessionRow.user_message_count ?? 0,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      reasoning_tokens: reasoningTokens,
      context_tokens: contextTokens,
      total_tokens: totalTokens,
      estimated_cost_usd: estimatedCostUsd,
      pricing,
      tool_calls: toolUsage.tool_calls ?? 0,
      tool_duration_ms: toolUsage.tool_duration_ms,
    };
  } catch (err) {
    return unavailableResourceUsage(
      resolvedWorktree,
      `failed to read Panopticon resource usage: ${
        err instanceof Error ? err.message : String(err)
      }`,
      dbPath,
    );
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function findSessionUsageRow(
  db: Database,
  worktree: string,
  matchBy: "session_cwds.cwd" | "sessions.target",
): SessionUsageRow | null {
  const sql =
    matchBy === "session_cwds.cwd"
      ? `SELECT s.session_id, 'session_cwds.cwd' AS matched_by, s.model,
                s.started_at_ms, s.ended_at_ms, s.turn_count, s.message_count,
                s.user_message_count, s.total_input_tokens, s.total_output_tokens,
                s.total_cache_read_tokens, s.total_cache_creation_tokens,
                s.total_reasoning_tokens
         FROM sessions s
         JOIN session_cwds c ON c.session_id = s.session_id
         WHERE c.cwd = ?
         ORDER BY c.first_seen_ms DESC, s.started_at_ms DESC
         LIMIT 1`
      : `SELECT s.session_id, 'sessions.target' AS matched_by, s.model,
                s.started_at_ms, s.ended_at_ms, s.turn_count, s.message_count,
                s.user_message_count, s.total_input_tokens, s.total_output_tokens,
                s.total_cache_read_tokens, s.total_cache_creation_tokens,
                s.total_reasoning_tokens
         FROM sessions s
         WHERE s.target = ?
         ORDER BY s.started_at_ms DESC
         LIMIT 1`;
  return (db.prepare(sql).get(worktree) as SessionUsageRow | undefined) ?? null;
}

function findPricingRow(db: Database, model: string | null): PricingRow | null {
  if (!model) return null;
  return (
    (db
      .prepare(
        `SELECT model_id, input_per_m, output_per_m, cache_read_per_m,
                cache_write_per_m, updated_ms
         FROM model_pricing
         WHERE ? LIKE model_id || '%'
         ORDER BY LENGTH(model_id) DESC, updated_ms DESC
         LIMIT 1`,
      )
      .get(model) as PricingRow | undefined) ?? null
  );
}

function readToolUsage(db: Database, sessionId: string): ToolUsageRow {
  return (
    (db
      .prepare(
        `SELECT COUNT(*) AS tool_calls, SUM(duration_ms) AS tool_duration_ms
         FROM tool_calls
         WHERE session_id = ?`,
      )
      .get(sessionId) as ToolUsageRow | undefined) ?? {
      tool_calls: 0,
      tool_duration_ms: null,
    }
  );
}

export function computeOutcomeDiagnostics(
  expectedFiles: string[],
  changedFiles: string[],
): Pick<
  ArmAttempt,
  | "matched_expected_files"
  | "unexpected_files"
  | "file_recall"
  | "exact_file_set"
> {
  const expectedSet = new Set(expectedFiles);
  const changedSet = new Set(changedFiles);
  const matched = expectedFiles.filter((file) => changedSet.has(file));
  const unexpected = changedFiles.filter((file) => !expectedSet.has(file));
  return {
    matched_expected_files: matched,
    unexpected_files: unexpected,
    file_recall:
      expectedFiles.length === 0 ? null : matched.length / expectedFiles.length,
    exact_file_set:
      expectedFiles.length === 0
        ? changedFiles.length === 0
        : matched.length === expectedFiles.length && unexpected.length === 0,
  };
}

function buildUntrackedPatch(worktree: string, files: string[]): string {
  return files
    .map((file) => {
      const fullPath = path.join(worktree, file);
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        return "";
      }
      const raw = fs.readFileSync(fullPath);
      const content = raw.includes(0)
        ? "(binary file omitted)"
        : raw.toString("utf-8");
      return [
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file}`,
        "@@ untracked file content @@",
        ...content.split("\n").map((line) => `+${line}`),
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function appendUntrackedSummary(summary: string, untracked: string[]): string {
  if (untracked.length === 0) return summary;
  const untrackedSummary = [
    "Untracked files:",
    ...untracked.map((file) => `  ${file}`),
  ].join("\n");
  return [summary, untrackedSummary].filter(Boolean).join("\n");
}

function findFinalMessagePath(
  prepDir: string,
  prNumber: number,
  arm: string,
): string | null {
  const outputDir = path.join(prepDir, "codex-output", "exec");
  if (!fs.existsSync(outputDir)) return null;
  const exact = path.join(outputDir, `pr-${prNumber}-${arm}.last-message.txt`);
  const candidates = fs
    .readdirSync(outputDir)
    .filter(
      (name) =>
        name === path.basename(exact) ||
        (name.startsWith(`pr-${prNumber}-`) &&
          name.endsWith(`-${arm}.last-message.txt`)),
    )
    .map((name) => path.join(outputDir, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function readFinalMessageExcerpt(filePath: string | null): string | null {
  if (!filePath) return null;
  const text = safeReadText(filePath).trim();
  if (!text) return null;
  return truncateWithFlag(text, FINAL_MESSAGE_MAX_CHARS).value;
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

function readManifest(prepDir: string): Manifest {
  const manifestPath = path.join(prepDir, "manifest.json");
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.rows) ||
    !raw.rows.every(isManifestRow)
  ) {
    throw new Error(`Invalid one-shot manifest: ${manifestPath}`);
  }
  return raw as unknown as Manifest;
}

function isManifestRow(value: unknown): value is ManifestRow {
  return (
    isRecord(value) &&
    typeof value.session_id === "string" &&
    typeof value.pr_number === "number" &&
    typeof value.merge_commit === "string" &&
    typeof value.base_commit === "string" &&
    typeof value.prompt_path === "string" &&
    typeof value.diffstat_path === "string" &&
    Array.isArray(value.expected_files)
  );
}

function selectRows(rows: ManifestRow[], args: Args): ManifestRow[] {
  let selected = rows;
  if (args.prNumbers.length > 0) {
    const wanted = new Set(args.prNumbers);
    selected = selected.filter((row) => wanted.has(row.pr_number));
  }
  if (args.sessionIds.length > 0) {
    const wanted = new Set(args.sessionIds);
    selected = selected.filter((row) => wanted.has(row.session_id));
  }
  return selected;
}

function renderMarkdownReport(results: ScenarioJudgment[], args: Args): string {
  const lines = [
    "# One-Shot Outcome Judge",
    "",
    `Prep dir: \`${args.prepDir}\``,
    `Judge: \`${args.skipJudge ? "skipped" : args.judgeRunner}${args.judgeModel ? `/${args.judgeModel}` : ""}\``,
    "",
    "| PR | Session | Arm | Verdict | Quality vs Original | File Recall | Exact Files | Unexpected | Notes | Quality Notes |",
    "| --- | --- | --- | --- | --- | ---: | --- | ---: | --- | --- |",
  ];
  for (const result of results) {
    for (const arm of result.arms) {
      lines.push(
        [
          result.pr_number,
          `\`${result.session_id.slice(0, 8)}\``,
          `\`${arm.arm}\``,
          result.judge.verdicts[arm.arm] ?? "unknown",
          result.judge.quality_vs_original[arm.arm] ?? "unknown",
          arm.file_recall == null ? "n/a" : arm.file_recall.toFixed(2),
          arm.exact_file_set == null ? "n/a" : String(arm.exact_file_set),
          arm.unexpected_files.length,
          escapeMarkdownCell(result.judge.notes),
          escapeMarkdownCell(result.judge.quality_notes),
        ].join(" | "),
      );
    }
  }
  const comparisons = results.flatMap((result) =>
    result.comparisons.map((comparison) => ({ result, comparison })),
  );
  if (comparisons.length > 0) {
    lines.push(
      "",
      "## Paired Impact",
      "",
      "| PR | Control | Treatment | Outcome | Verdict Delta | Quality Delta | Recall Delta | Unexpected Delta | Changed Files Delta | Exact Files |",
      "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const { result, comparison } of comparisons) {
      lines.push(
        [
          result.pr_number,
          `\`${comparison.control_arm}\``,
          `\`${comparison.treatment_arm}\``,
          comparison.outcome,
          formatNullableNumber(comparison.verdict_delta),
          formatNullableNumber(comparison.quality_delta),
          formatNullableNumber(comparison.file_recall_delta),
          formatNullableNumber(comparison.unexpected_files_delta),
          formatNullableNumber(comparison.changed_files_delta),
          comparison.exact_file_set_change,
        ].join(" | "),
      );
    }
  }
  const resourceArms = results.flatMap((result) =>
    result.arms.map((arm) => ({ result, arm })),
  );
  if (resourceArms.length > 0) {
    lines.push(
      "",
      "## Resource Usage",
      "",
      "Collected from Panopticon sessions matched by replay worktree. Cache-read metrics can be order-dependent when arms run sequentially.",
      "",
      "| PR | Arm | Replay Session | Model | Elapsed | Turns | Input Tokens | Cache Read | Context Tokens | Output Tokens | Reasoning Tokens | Total Tokens | Est. Cost | Tool Calls |",
      "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const { result, arm } of resourceArms) {
      const usage = arm.resource_usage;
      lines.push(
        [
          result.pr_number,
          `\`${arm.arm}\``,
          usage.available ? `\`${usage.session_id.slice(0, 8)}\`` : "n/a",
          usage.available ? (usage.model ?? "n/a") : "n/a",
          usage.available ? formatDurationMs(usage.elapsed_ms) : "n/a",
          usage.available ? usage.turn_count : "n/a",
          usage.available ? formatInteger(usage.input_tokens) : "n/a",
          usage.available ? formatInteger(usage.cache_read_tokens) : "n/a",
          usage.available ? formatInteger(usage.context_tokens) : "n/a",
          usage.available ? formatInteger(usage.output_tokens) : "n/a",
          usage.available ? formatInteger(usage.reasoning_tokens) : "n/a",
          usage.available ? formatInteger(usage.total_tokens) : "n/a",
          usage.available ? formatUsd(usage.estimated_cost_usd) : "n/a",
          usage.available ? usage.tool_calls : "n/a",
        ].join(" | "),
      );
    }
  }
  const resourceComparisons = comparisons.filter(
    ({ comparison }) => comparison.resource_usage_delta != null,
  );
  if (resourceComparisons.length > 0) {
    lines.push(
      "",
      "## Resource Impact",
      "",
      "| PR | Control | Treatment | Elapsed Delta | Turn Delta | Input Token Delta | Cache Read Delta | Context Token Delta | Total Token Delta | Cost Delta | Tool Call Delta |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const { result, comparison } of resourceComparisons) {
      const delta = comparison.resource_usage_delta;
      lines.push(
        [
          result.pr_number,
          `\`${comparison.control_arm}\``,
          `\`${comparison.treatment_arm}\``,
          delta
            ? formatDeltaWithPct(
                delta.elapsed_ms_delta,
                delta.elapsed_pct_delta,
                {
                  scale: "duration",
                },
              )
            : "n/a",
          delta
            ? formatDeltaWithPct(delta.turn_delta, delta.turn_pct_delta)
            : "n/a",
          delta
            ? formatDeltaWithPct(
                delta.input_token_delta,
                delta.input_token_pct_delta,
              )
            : "n/a",
          delta
            ? formatDeltaWithPct(
                delta.cache_read_token_delta,
                delta.cache_read_token_pct_delta,
              )
            : "n/a",
          delta
            ? formatDeltaWithPct(
                delta.context_token_delta,
                delta.context_token_pct_delta,
              )
            : "n/a",
          delta
            ? formatDeltaWithPct(
                delta.total_token_delta,
                delta.total_token_pct_delta,
              )
            : "n/a",
          delta
            ? formatDeltaWithPct(
                delta.estimated_cost_usd_delta,
                delta.estimated_cost_pct_delta,
                { scale: "usd" },
              )
            : "n/a",
          delta
            ? formatDeltaWithPct(
                delta.tool_call_delta,
                delta.tool_call_pct_delta,
              )
            : "n/a",
        ].join(" | "),
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatDurationMs(value: number | null): string {
  if (value == null) return "n/a";
  return `${(value / 1000).toFixed(1)}s`;
}

function formatUsd(value: number | null): string {
  if (value == null) return "n/a";
  return `$${value.toFixed(4)}`;
}

function formatDeltaWithPct(
  value: number | null,
  pct: number | null,
  opts: { scale?: "number" | "duration" | "usd" } = {},
): string {
  if (value == null) return "n/a";
  const signedValue =
    opts.scale === "duration"
      ? `${formatSigned(value / 1000, 1)}s`
      : opts.scale === "usd"
        ? formatSignedUsd(value)
        : formatSigned(value, Number.isInteger(value) ? 0 : 2);
  if (pct == null) return signedValue;
  return `${signedValue} / ${formatSigned(pct, 1)}%`;
}

function formatSigned(value: number, digits: number): string {
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return value > 0 ? `+${formatted}` : formatted;
}

function formatSignedUsd(value: number): string {
  const abs = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
  if (value > 0) return `+$${abs}`;
  if (value < 0) return `-$${abs}`;
  return "$0.0000";
}

function formatNullableNumber(value: number | null): string {
  return value == null
    ? "n/a"
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(2);
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function safeReadText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function git(
  repoRoot: string,
  args: string[],
  opts: { maxBuffer?: number } = {},
): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf-8",
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prepDir: DEFAULT_PREP_DIR,
    repoRoot: DEFAULT_REPO_ROOT,
    worktreeRoot: DEFAULT_WORKTREE_ROOT,
    prNumbers: [],
    sessionIds: [],
    arms: ["none", "panop"],
    resultJson: path.join(DEFAULT_PREP_DIR, "judge-results.json"),
    reportMarkdown: path.join(DEFAULT_PREP_DIR, "judge-report.md"),
    judgeRunner: "codex",
    judgeModel: null,
    skipJudge: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prep-dir") {
      args.prepDir = readArgValue(argv, ++i, arg);
      if (
        args.resultJson === path.join(DEFAULT_PREP_DIR, "judge-results.json")
      ) {
        args.resultJson = path.join(args.prepDir, "judge-results.json");
      }
      if (
        args.reportMarkdown === path.join(DEFAULT_PREP_DIR, "judge-report.md")
      ) {
        args.reportMarkdown = path.join(args.prepDir, "judge-report.md");
      }
    } else if (arg === "--repo-root") {
      args.repoRoot = readArgValue(argv, ++i, arg);
    } else if (arg === "--worktree-root") {
      args.worktreeRoot = readArgValue(argv, ++i, arg);
    } else if (arg === "--pr-number" || arg === "--pr-numbers") {
      args.prNumbers.push(
        ...parseNumberList(readArgValue(argv, ++i, arg), arg),
      );
    } else if (arg === "--session-id") {
      args.sessionIds.push(readArgValue(argv, ++i, arg));
    } else if (arg === "--arms") {
      args.arms = readArgValue(argv, ++i, arg)
        .split(",")
        .map((arm) => arm.trim())
        .filter((arm) => arm.length > 0);
    } else if (arg === "--result-json") {
      args.resultJson = readArgValue(argv, ++i, arg);
    } else if (arg === "--report-markdown") {
      args.reportMarkdown = readArgValue(argv, ++i, arg);
    } else if (arg === "--judge-runner") {
      args.judgeRunner = parseJudgeRunner(readArgValue(argv, ++i, arg));
    } else if (arg === "--judge-model") {
      args.judgeModel = readArgValue(argv, ++i, arg);
    } else if (arg === "--skip-judge") {
      args.skipJudge = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg !== "--") {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.arms.length === 0) throw new Error("--arms cannot be empty");
  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm eval:judge-one-shot -- [options]

Judges already-executed one-shot replay worktrees with an LLM outcome rubric.

Options:
  --prep-dir PATH        One-shot prep directory
  --repo-root PATH       Panopticon git repo root for oracle patches
  --worktree-root PATH   Root containing pr-N-arm worktrees
  --pr-number N[,N...]   Restrict to PR number(s)
  --session-id ID        Restrict to a session id; repeatable
  --arms LIST            Comma-separated arm names (default: none,panop)
  --result-json PATH     Write raw judgment JSON
  --report-markdown PATH Write markdown summary
  --judge-runner R       claude or codex (default: codex)
  --judge-model M        Optional judge model
  --skip-judge           Collect deterministic diagnostics only
  --help, -h             Show this help`);
}

function parseJudgeRunner(value: string): JudgeRunner {
  if (value === "claude" || value === "codex") return value;
  throw new Error("--judge-runner expects claude or codex");
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} expects a value`);
  return value;
}

function parseNumberList(value: string, flag: string): number[] {
  return value.split(",").map((part) => parsePositiveInt(part.trim(), flag));
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer`);
  }
  return parsed;
}

function resolveDefaultRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
