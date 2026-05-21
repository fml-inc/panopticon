#!/usr/bin/env node

// Hydrate PR candidate rows into replay scenarios by fetching historical user
// prompts from the production Convex mirror via the FML cq helper.
//
// This is a manual eval utility, not CI. It requires access to the FML repo and
// its encrypted production env file.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_REPO_ROOT = resolveDefaultRepoRoot();
const DEFAULT_CONVEX_ROOT = path.resolve(DEFAULT_REPO_ROOT, "..", "fml");
const DEFAULT_ENV_FILE = ".env.production";

interface Args {
  candidateFile: string;
  outputFile: string;
  repoRoot: string;
  convexRoot: string;
  envFile: string;
  limit: number | null;
}

interface CandidateRow {
  date?: string;
  session_id: string;
  pr_number: number;
  merge_commit: string;
  branch?: string;
  title?: string;
}

interface ConvexMessageRow {
  content?: unknown;
  isSystem?: unknown;
}

const noisePrompt =
  /^<local-command-caveat|^<command-message>|^Caveat:|^<command-name>|^Reply with exactly OK|^\[Request interrupted/;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const candidates = extractCandidateRows(
    JSON.parse(fs.readFileSync(args.candidateFile, "utf-8")) as unknown,
  );
  const selected =
    args.limit == null ? candidates : candidates.slice(0, args.limit);
  const scenarios = selected.map((candidate, index) => {
    console.log(
      `[${index + 1}/${selected.length}] PR#${candidate.pr_number} ${candidate.session_id}`,
    );
    const prompts = loadConvexPrompts(candidate.session_id, args);
    const headSha = git(args.repoRoot, [
      "rev-parse",
      `${candidate.merge_commit}^1`,
    ]);
    const diffstat = git(args.repoRoot, [
      "show",
      "--stat",
      "--format=",
      candidate.merge_commit,
    ]);
    return {
      session_id: candidate.session_id,
      head_sha: headSha,
      anchor: "exact" as const,
      started_at_ms: candidate.date
        ? Date.parse(`${candidate.date}T00:00:00Z`)
        : Date.now(),
      first_prompt: prompts[0] ?? "",
      prompts,
      pr_number: candidate.pr_number,
      merge_commit: candidate.merge_commit,
      branch: candidate.branch,
      pr_title: candidate.title,
      expected_diffstat: diffstat.split("\n").slice(0, 40).join("\n"),
    };
  });

  fs.mkdirSync(path.dirname(args.outputFile), { recursive: true });
  fs.writeFileSync(args.outputFile, `${JSON.stringify(scenarios, null, 2)}\n`);
  console.log(`wrote ${scenarios.length} scenarios to ${args.outputFile}`);
}

function resolveDefaultRepoRoot(): string {
  let current = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(process.cwd());
    current = parent;
  }
}

function extractCandidateRows(raw: unknown): CandidateRow[] {
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

function loadConvexPrompts(sessionId: string, args: Args): string[] {
  const rows = queryConvex(
    {
      table: "panopticon_v2_messages",
      indexName: "by_session",
      indexRange: [{ field: "sessionId", op: "eq", value: sessionId }],
      filter: [{ field: "role", op: "eq", value: "user" }],
      fields: ["content", "ordinal", "isSystem"],
      pageSize: 500,
      order: "asc",
    },
    args,
  ).rows as ConvexMessageRow[];
  return rows
    .filter((row) => !row.isSystem)
    .map((row) => String(row.content ?? "").trim())
    .filter((text) => text.length > 0 && !noisePrompt.test(text));
}

function queryConvex(
  spec: Record<string, unknown>,
  args: Args,
): { rows: unknown[] } {
  const output = execFileSync(
    "pnpm",
    [
      "-s",
      "exec",
      "dotenvx",
      "run",
      "-f",
      args.envFile,
      "--",
      "pnpm",
      "-s",
      "cq",
      JSON.stringify(spec),
    ],
    {
      cwd: args.convexRoot,
      timeout: 60_000,
      maxBuffer: 128 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const jsonStart = output.lastIndexOf("\n{\n");
  const parsed = JSON.parse(output.slice(jsonStart >= 0 ? jsonStart + 1 : 0));
  if (!isRecord(parsed) || !Array.isArray(parsed.rows)) {
    throw new Error("Convex cq response did not include a rows array");
  }
  return { rows: parsed.rows };
}

function git(repoRoot: string, gitArgs: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...gitArgs], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function parseArgs(argv: string[]): Args {
  const positionalArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const args: Args = {
    candidateFile: positionalArgv[0] ?? "",
    outputFile: positionalArgv[1] ?? "",
    repoRoot: DEFAULT_REPO_ROOT,
    convexRoot: DEFAULT_CONVEX_ROOT,
    envFile: DEFAULT_ENV_FILE,
    limit: null,
  };
  for (let i = 2; i < positionalArgv.length; i++) {
    const arg = positionalArgv[i];
    if (arg === "--repo-root") {
      args.repoRoot = requireValue(positionalArgv[++i], arg);
    } else if (arg === "--convex-root") {
      args.convexRoot = requireValue(positionalArgv[++i], arg);
    } else if (arg === "--env-file") {
      args.envFile = requireValue(positionalArgv[++i], arg);
    } else if (arg === "--limit") {
      args.limit = parsePositiveInt(
        requireValue(positionalArgv[++i], arg),
        arg,
      );
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.candidateFile || !args.outputFile) {
    printHelp();
    throw new Error("candidate file and output file are required");
  }
  return args;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} expects a value`);
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printHelp(): void {
  console.log(`Usage:
  pnpm exec tsup scripts/eval-hydrate-pr-scenarios.ts --format esm --platform node --target node24 --out-dir .tmp/eval-build --silent --no-dts
  node .tmp/eval-build/eval-hydrate-pr-scenarios.js CANDIDATES_JSON OUTPUT_JSON [options]

Options:
  --repo-root PATH    Panopticon git repo root (default: ${DEFAULT_REPO_ROOT})
  --convex-root PATH  FML repo with pnpm cq and env files (default: ${DEFAULT_CONVEX_ROOT})
  --env-file PATH     Env file relative to --convex-root (default: ${DEFAULT_ENV_FILE})
  --limit N           Hydrate only the first N candidate rows
  --help, -h          Show this help`);
}

main();
