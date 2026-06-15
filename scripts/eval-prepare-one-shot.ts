#!/usr/bin/env node

// Prepare, but do not execute, one-shot replay inputs.
//
// This is the reproducible prep stage for small PR/session experiments. It
// selects candidate PR rows, validates solution-free goal prompts supplied by
// humans/agents, and writes:
// - a replay scenario fixture for later execution
// - one prompt file per selected PR
// - a manifest with oracle metadata kept separate from prompts
// - shell commands for manual interactive or non-interactive Codex runs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CANDIDATE_FILE = path.join(
  ".tmp",
  "evals",
  "replay-counterfactual",
  "candidates.all-pr-pairs.json",
);
const DEFAULT_OUTPUT_DIR = path.join(".tmp", "evals", "replay-one-shot-prep");
const DEFAULT_REPO_ROOT = resolveDefaultRepoRoot();

interface Args {
  candidateFile: string;
  outputDir: string;
  repoRoot: string;
  promptInputFile: string | null;
  prNumbers: number[];
  sessionIds: string[];
  limit: number;
  maxFiles: number | null;
  maxTotal: number | null;
}

interface CandidateRow {
  date?: string;
  session_id: string;
  pr_number: number;
  merge_commit: string;
  branch?: string;
  title?: string;
  files?: number;
  plus?: number;
  minus?: number;
  total?: number;
  session_pr_count?: number;
}

interface PromptInput {
  pr_number?: number;
  session_id?: string;
  prompt: string;
}

interface PreparedScenario {
  session_id: string;
  head_sha: string;
  anchor: "exact";
  started_at_ms: number;
  first_prompt: string;
  prompts: string[];
  pr_number: number;
  merge_commit: string;
  branch?: string;
  pr_title?: string;
  expected_diffstat: string;
}

interface PreparedManifestRow {
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
  leakage_warnings: string[];
}

if (isDirectRun()) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(entry).href : false;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const candidates = selectCandidates(
    extractCandidateRows(
      JSON.parse(fs.readFileSync(args.candidateFile, "utf-8")) as unknown,
    ),
    args,
  );
  if (candidates.length === 0) {
    throw new Error("No candidates matched the preparation filters");
  }
  const promptInputs = loadPromptInputs(args.promptInputFile);
  const prepared = prepareCandidates(candidates, promptInputs, args);
  writePreparedArtifacts(prepared, args);
}

export function selectCandidates(
  candidates: CandidateRow[],
  args: Pick<
    Args,
    "prNumbers" | "sessionIds" | "limit" | "maxFiles" | "maxTotal"
  >,
): CandidateRow[] {
  let rows = candidates;
  if (args.prNumbers.length > 0) {
    const wanted = new Set(args.prNumbers);
    rows = rows.filter((row) => wanted.has(row.pr_number));
  }
  if (args.sessionIds.length > 0) {
    const wanted = new Set(args.sessionIds);
    rows = rows.filter((row) => wanted.has(row.session_id));
  }
  if (args.maxFiles != null) {
    rows = rows.filter(
      (row) => (row.files ?? Number.MAX_SAFE_INTEGER) <= args.maxFiles!,
    );
  }
  if (args.maxTotal != null) {
    rows = rows.filter(
      (row) => (row.total ?? Number.MAX_SAFE_INTEGER) <= args.maxTotal!,
    );
  }

  const order = new Map(args.prNumbers.map((pr, index) => [pr, index]));
  return [...rows]
    .sort((a, b) => {
      const orderA = order.get(a.pr_number);
      const orderB = order.get(b.pr_number);
      if (orderA != null || orderB != null) {
        return (
          (orderA ?? Number.MAX_SAFE_INTEGER) -
          (orderB ?? Number.MAX_SAFE_INTEGER)
        );
      }
      return (
        (a.files ?? Number.MAX_SAFE_INTEGER) -
          (b.files ?? Number.MAX_SAFE_INTEGER) ||
        (a.total ?? Number.MAX_SAFE_INTEGER) -
          (b.total ?? Number.MAX_SAFE_INTEGER) ||
        a.pr_number - b.pr_number
      );
    })
    .slice(0, args.limit);
}

function prepareCandidates(
  candidates: CandidateRow[],
  promptInputs: PromptInput[],
  args: Pick<Args, "repoRoot" | "outputDir">,
): PreparedManifestRow[] {
  return candidates.map((candidate) => {
    const baseCommit = git(args.repoRoot, [
      "rev-parse",
      `${candidate.merge_commit}^1`,
    ]);
    const diffstat = git(args.repoRoot, [
      "show",
      "--stat",
      "--format=",
      "--find-renames",
      candidate.merge_commit,
    ]);
    const expectedFiles = parseDiffstatFiles(diffstat);
    const startedAtMs = candidate.date
      ? Date.parse(`${candidate.date}T00:00:00Z`)
      : Date.now();
    const prompt =
      findPromptInput(promptInputs, candidate)?.prompt ??
      buildFallbackGoalPrompt(candidate);
    const leakageWarnings = validateSolutionFreePrompt(
      prompt,
      candidate,
      expectedFiles,
    );
    const stem = scenarioStem(candidate);
    const promptPath = path.join(args.outputDir, "prompts", `${stem}.goal.md`);
    const diffstatPath = path.join(
      args.outputDir,
      "oracles",
      `${stem}.diffstat.txt`,
    );
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.mkdirSync(path.dirname(diffstatPath), { recursive: true });
    fs.writeFileSync(promptPath, `${prompt.trim()}\n`);
    fs.writeFileSync(diffstatPath, `${diffstat.trim()}\n`);
    return {
      date: candidate.date,
      session_id: candidate.session_id,
      pr_number: candidate.pr_number,
      merge_commit: candidate.merge_commit,
      branch: candidate.branch,
      title: candidate.title,
      base_commit: baseCommit,
      started_at_ms: startedAtMs,
      prompt_path: promptPath,
      expected_files: expectedFiles,
      expected_file_count: expectedFiles.length,
      diffstat_path: diffstatPath,
      leakage_warnings: leakageWarnings,
    };
  });
}

function writePreparedArtifacts(rows: PreparedManifestRow[], args: Args): void {
  fs.mkdirSync(args.outputDir, { recursive: true });
  const scenarios: PreparedScenario[] = rows.map((row) => ({
    session_id: row.session_id,
    head_sha: row.base_commit,
    anchor: "exact",
    started_at_ms: row.started_at_ms,
    first_prompt: fs.readFileSync(row.prompt_path, "utf-8").trim(),
    prompts: [fs.readFileSync(row.prompt_path, "utf-8").trim()],
    pr_number: row.pr_number,
    merge_commit: row.merge_commit,
    branch: row.branch,
    pr_title: row.title,
    expected_diffstat: fs.readFileSync(row.diffstat_path, "utf-8").trim(),
  }));
  fs.writeFileSync(
    path.join(args.outputDir, "scenarios.json"),
    `${JSON.stringify(scenarios, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(args.outputDir, "manifest.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        candidate_file: args.candidateFile,
        prompt_input_file: args.promptInputFile,
        repo_root: args.repoRoot,
        scenario_fixture: path.join(args.outputDir, "scenarios.json"),
        rows,
      },
      null,
      2,
    )}\n`,
  );
  writeCodexCommandScript({
    rows,
    args,
    scriptName: "codex-interactive-commands.sh",
    mode: "interactive",
  });
  writeCodexCommandScript({
    rows,
    args,
    scriptName: "codex-exec-commands.sh",
    mode: "exec",
  });
  console.log(
    `Prepared ${rows.length} one-shot scenario(s) in ${args.outputDir}`,
  );
  const leaked = rows.filter((row) => row.leakage_warnings.length > 0);
  if (leaked.length > 0) {
    console.warn(
      `WARNING: ${leaked.length} prompt(s) have leakage warnings; inspect manifest.json before executing.`,
    );
  }
}

function writeCodexCommandScript(input: {
  rows: PreparedManifestRow[];
  args: Args;
  scriptName: string;
  mode: "interactive" | "exec";
}): void {
  const scriptPath = path.join(input.args.outputDir, input.scriptName);
  const worktreeRoot = path.join(os.tmpdir(), "pano-one-shot-worktrees");
  const outputRoot = path.join(
    path.resolve(input.args.outputDir),
    "codex-output",
    input.mode,
  );
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Manual execution only. Prep generated these commands; it does not run them.",
    `REPO_ROOT=${shQuote(input.args.repoRoot)}`,
    `WORKTREE_ROOT=${shQuote(worktreeRoot)}`,
    `OUTPUT_ROOT=${shQuote(outputRoot)}`,
    'mkdir -p "$WORKTREE_ROOT" "$OUTPUT_ROOT"',
    "",
  ];
  for (const row of input.rows) {
    for (const arm of ["none", "panop"] as const) {
      const worktree = `$WORKTREE_ROOT/pr-${row.pr_number}-${arm}`;
      const lastMessagePath = `$OUTPUT_ROOT/pr-${row.pr_number}-${arm}.last-message.txt`;
      lines.push(
        `# PR #${row.pr_number} ${arm}`,
        `git -C "$REPO_ROOT" worktree remove --force "${worktree}" 2>/dev/null || true`,
        `git -C "$REPO_ROOT" worktree add --detach "${worktree}" ${shQuote(row.base_commit)}`,
        formatCodexCommand({
          mode: input.mode,
          arm,
          worktree,
          promptPath: path.resolve(row.prompt_path),
          sessionId: row.session_id,
          replayNowMs: row.started_at_ms - 1,
          lastMessagePath,
        }),
        "",
      );
    }
  }
  fs.writeFileSync(scriptPath, `${lines.join("\n")}\n`);
  fs.chmodSync(scriptPath, 0o755);
}

function formatCodexCommand(input: {
  mode: "interactive" | "exec";
  arm: "none" | "panop";
  worktree: string;
  promptPath: string;
  sessionId: string;
  replayNowMs: number;
  lastMessagePath: string;
}): string {
  const envPrefix = [
    formatPanopticonEnv(input.arm),
    `PANOPTICON_REPLAY_NOW_MS=${input.replayNowMs}`,
    `PANOPTICON_REPLAY_EXCLUDE_SESSION_IDS=${shQuote(input.sessionId)}`,
  ].join(" ");
  const promptArg = `"$(cat ${shQuote(input.promptPath)})"`;
  if (input.mode === "interactive") {
    return [
      envPrefix,
      "codex",
      `--cd "${input.worktree}"`,
      "--dangerously-bypass-approvals-and-sandbox",
      promptArg,
    ].join(" ");
  }
  return [
    envPrefix,
    "codex",
    "exec",
    `--cd "${input.worktree}"`,
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message",
    `"${input.lastMessagePath}"`,
    promptArg,
  ].join(" ");
}

function formatPanopticonEnv(arm: "none" | "panop"): string {
  const on = arm === "panop";
  return [
    `PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION=${on ? "1" : "0"}`,
    `PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION=${on ? "1" : "0"}`,
    `PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION=${on ? "1" : "0"}`,
    `PANOPTICON_ENABLE_PRE_TOOL_USE_READ_CONTEXT_INJECTION=${on ? "1" : "0"}`,
  ].join(" ");
}

function buildFallbackGoalPrompt(candidate: CandidateRow): string {
  return [
    "You are working in the Panopticon repository at a historical base commit.",
    `Goal: ${candidate.title ?? `complete the intended change for PR #${candidate.pr_number}`}.`,
    "Make the smallest appropriate code change to satisfy the goal.",
    "Do not push, create a PR, tag a release, or modify files outside this checkout.",
    "Run focused verification if the repository provides an obvious command for this change.",
  ].join("\n");
}

export function validateSolutionFreePrompt(
  prompt: string,
  candidate: CandidateRow,
  expectedFiles: string[],
): string[] {
  const warnings: string[] = [];
  const haystack = prompt.toLowerCase();
  for (const file of expectedFiles) {
    if (haystack.includes(file.toLowerCase())) {
      warnings.push(`mentions changed file path: ${file}`);
    }
  }
  for (const value of [candidate.branch, candidate.merge_commit]) {
    if (value && haystack.includes(value.toLowerCase())) {
      warnings.push(`mentions oracle metadata: ${value}`);
    }
  }
  if (/```/.test(prompt)) warnings.push("contains code fence");
  if (
    /\b(change|edit|modify|update)\s+[`'"]?[\w./-]+\.(?:ts|tsx|js|json|ya?ml|md|sh)\b/i.test(
      prompt,
    )
  ) {
    warnings.push("appears to direct edits to a specific file");
  }
  return warnings;
}

function findPromptInput(
  inputs: PromptInput[],
  candidate: CandidateRow,
): PromptInput | null {
  return (
    inputs.find((input) => input.pr_number === candidate.pr_number) ??
    inputs.find((input) => input.session_id === candidate.session_id) ??
    null
  );
}

function loadPromptInputs(filePath: string | null): PromptInput[] {
  if (!filePath) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  const rows = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.prompts)
      ? raw.prompts
      : [];
  return rows.filter(isPromptInput);
}

function isPromptInput(value: unknown): value is PromptInput {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    value.prompt.trim().length > 0 &&
    (typeof value.pr_number === "number" ||
      typeof value.session_id === "string")
  );
}

export function extractCandidateRows(raw: unknown): CandidateRow[] {
  const rows = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.candidates)
      ? raw.candidates
      : [];
  return rows.filter(isCandidateRow);
}

function isCandidateRow(value: unknown): value is CandidateRow {
  return (
    isRecord(value) &&
    typeof value.session_id === "string" &&
    typeof value.pr_number === "number" &&
    typeof value.merge_commit === "string"
  );
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

function parseArgs(argv: string[]): Args {
  const args: Args = {
    candidateFile: DEFAULT_CANDIDATE_FILE,
    outputDir: DEFAULT_OUTPUT_DIR,
    repoRoot: DEFAULT_REPO_ROOT,
    promptInputFile: null,
    prNumbers: [],
    sessionIds: [],
    limit: 5,
    maxFiles: null,
    maxTotal: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--candidate-file") {
      args.candidateFile = readArgValue(argv, ++i, arg);
    } else if (arg === "--output-dir") {
      args.outputDir = readArgValue(argv, ++i, arg);
    } else if (arg === "--repo-root") {
      args.repoRoot = readArgValue(argv, ++i, arg);
    } else if (arg === "--prompt-input-file") {
      args.promptInputFile = readArgValue(argv, ++i, arg);
    } else if (arg === "--pr-number" || arg === "--pr-numbers") {
      args.prNumbers.push(
        ...parseNumberList(readArgValue(argv, ++i, arg), arg),
      );
    } else if (arg === "--session-id") {
      args.sessionIds.push(readArgValue(argv, ++i, arg));
    } else if (arg === "--limit") {
      args.limit = parsePositiveInt(readArgValue(argv, ++i, arg), arg);
    } else if (arg === "--max-files") {
      args.maxFiles = parsePositiveInt(readArgValue(argv, ++i, arg), arg);
    } else if (arg === "--max-total") {
      args.maxTotal = parsePositiveInt(readArgValue(argv, ++i, arg), arg);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg !== "--") {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm eval:prepare-one-shot -- [options]

Prepares reproducible one-shot replay inputs without running agents.

Options:
  --candidate-file PATH     PR/session candidate JSON
  --output-dir PATH         Directory for manifest, prompts, and commands
  --repo-root PATH          Panopticon git repo root
  --prompt-input-file PATH  Agent/human-authored prompt JSON
  --pr-number N[,N...]      Restrict to PR number(s)
  --session-id ID           Restrict to a session id; repeatable
  --limit N                 Max selected candidates (default: 5)
  --max-files N             Keep candidates touching at most N files
  --max-total N             Keep candidates with at most N total +/- lines
  --help, -h                Show this help`);
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
    return git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  } catch {
    return process.cwd();
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function scenarioStem(candidate: CandidateRow): string {
  return `pr-${candidate.pr_number}-${candidate.session_id.slice(0, 8)}`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
