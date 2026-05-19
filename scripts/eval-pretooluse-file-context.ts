#!/usr/bin/env node

// File-scoped PreToolUse context eval (Phase 1).
//
// The userprompt eval is prompt-scoped; the PreToolUse injector fires far
// more often and is a different surface, so it needs its own precision
// floor. This is deterministic: a file with real provenance MUST surface
// context; a never-touched path MUST stay silent. Regressions exit non-zero.

import fs from "node:fs";
import path from "node:path";
import { closeDb, getDb } from "../src/db/schema.js";
import { buildPreToolUseFileContext } from "../src/hooks/session-context.js";

const DEFAULT_LIMIT = 25;
const DEFAULT_FIXTURE_DIR = path.join(
  ".tmp",
  "evals",
  "pretooluse-file-context",
);

interface Args {
  limit: number;
  fixtureDir: string;
  refresh: boolean;
  verbose: boolean;
}

type ExpectedOutcome = "surface" | "silent";

interface EvalCase {
  file_path: string;
  repository: string | null;
  expected: ExpectedOutcome;
  edit_count: number;
  intent_count: number;
}

interface CaseResult {
  case: EvalCase;
  surfaced: boolean;
  context: string | null;
  ok: boolean;
  reason: string;
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = loadOrCreateFixture(args);
  const results = cases.map((c) => evaluateCase(c));

  const surfaceCases = results.filter((r) => r.case.expected === "surface");
  const silentCases = results.filter((r) => r.case.expected === "silent");
  const surfaceFails = surfaceCases.filter((r) => !r.ok);
  const silentFails = silentCases.filter((r) => !r.ok);

  for (const r of results) {
    const tag = r.ok ? "ok" : "FAIL";
    console.log(
      `[${tag}] expected=${r.case.expected} surfaced=${r.surfaced} ` +
        `edits=${r.case.edit_count} intents=${r.case.intent_count} ` +
        `reason=${r.reason}\n  ${r.case.file_path}`,
    );
    if (args.verbose && r.context) {
      console.log(
        r.context
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
  }

  console.log("");
  console.log(
    `PreToolUse file context: ${results.length} cases ` +
      `(${fixturePath(args.fixtureDir)})`,
  );
  console.log(
    `  surface=${surfaceCases.length} surfaced_ok=${
      surfaceCases.length - surfaceFails.length
    }/${surfaceCases.length}`,
  );
  console.log(
    `  silent=${silentCases.length} silent_ok=${
      silentCases.length - silentFails.length
    }/${silentCases.length}`,
  );

  const failures: string[] = [];
  if (surfaceFails.length > 0) {
    failures.push(
      `${surfaceFails.length} file(s) with provenance returned no context`,
    );
  }
  if (silentFails.length > 0) {
    failures.push(`${silentFails.length} never-touched path(s) leaked context`);
  }

  console.log(
    failures.length === 0
      ? "  GATE: PASS"
      : `  GATE: FAIL — ${failures.join("; ")}`,
  );
  if (failures.length > 0) {
    console.error(`\nPrecision gate FAILED:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  }
}

function evaluateCase(c: EvalCase): CaseResult {
  let context: string | null = null;
  try {
    context = buildPreToolUseFileContext({
      tool_input: { file_path: c.file_path },
      repository: c.repository ?? undefined,
    });
  } catch (err) {
    return {
      case: c,
      surfaced: false,
      context: null,
      ok: false,
      reason: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const surfaced = context !== null;

  if (c.expected === "surface") {
    if (!surfaced) {
      return { case: c, surfaced, context, ok: false, reason: "no_context" };
    }
    // Surfaced context must actually be about this file and carry the
    // provenance line — the honesty payload, not an empty shell.
    const base = path.basename(c.file_path);
    const hasPath = context.includes(base);
    const hasHistory = context.includes("History:");
    if (!hasPath || !hasHistory) {
      return {
        case: c,
        surfaced,
        context,
        ok: false,
        reason: `malformed(path=${hasPath},history=${hasHistory})`,
      };
    }
    return { case: c, surfaced, context, ok: true, reason: "surfaced" };
  }

  // expected === "silent"
  return {
    case: c,
    surfaced,
    context,
    ok: !surfaced,
    reason: surfaced ? "unexpected_context" : "correctly_silent",
  };
}

function loadOrCreateFixture(args: Args): EvalCase[] {
  const filePath = fixturePath(args.fixtureDir);
  if (!args.refresh && fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as EvalCase[];
  }
  const cases = sampleCases(args.limit);
  fs.mkdirSync(args.fixtureDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(cases, null, 2)}\n`);
  return cases;
}

function fixturePath(dir: string): string {
  return path.join(dir, "cases.json");
}

function sampleCases(limit: number): EvalCase[] {
  const db = getDb();
  // Files with the richest provenance make the strongest surface cases:
  // multiple edits across multiple intents is unambiguous history.
  const rows = db
    .prepare(
      `SELECT e.file_path AS file_path,
              MAX(u.repository) AS repository,
              COUNT(*) AS edit_count,
              COUNT(DISTINCT e.intent_unit_id) AS intent_count
       FROM intent_edits e
       JOIN intent_units u ON u.id = e.intent_unit_id
       WHERE e.file_path IS NOT NULL AND TRIM(e.file_path) != ''
       GROUP BY e.file_path
       HAVING edit_count >= 2
       ORDER BY edit_count DESC, intent_count DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    file_path: string;
    repository: string | null;
    edit_count: number;
    intent_count: number;
  }>;

  const surface: EvalCase[] = rows.map((r) => ({
    file_path: r.file_path,
    repository: r.repository,
    expected: "surface",
    edit_count: r.edit_count,
    intent_count: r.intent_count,
  }));

  // Negative corpus: plausible-looking paths that have never been touched
  // must stay silent (the precision gate / hot-path fast return).
  const silent: EvalCase[] = [
    "src/never/touched-by-anyone.ts",
    "lib/phantom/module.tsx",
    "/tmp/panopticon-eval/does-not-exist.py",
    "docs/UNWRITTEN-PLAN.md",
  ].map((p) => ({
    file_path: p,
    repository: null,
    expected: "silent",
    edit_count: 0,
    intent_count: 0,
  }));

  return [...surface, ...silent];
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    limit: DEFAULT_LIMIT,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    refresh: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      parsed.limit = parsePositiveInt(argv[++i], "--limit");
    } else if (arg === "--fixture-dir") {
      parsed.fixtureDir = readArgValue(argv, ++i, "--fixture-dir");
    } else if (arg === "--refresh") {
      parsed.refresh = true;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--") {
      // pnpm passes a bare `--` separator through; ignore it.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} expects a positive integer`);
  }
  return n;
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: pnpm eval:pretooluse -- [options]

Options:
  --limit N           Surface cases sampled from the local DB (default: ${DEFAULT_LIMIT})
  --fixture-dir PATH  Fixture directory (default: ${DEFAULT_FIXTURE_DIR})
  --refresh           Resample cases from the local DB
  --verbose           Print surfaced context lines
  --help, -h          Show this help

Deterministic: files with provenance must surface; never-touched paths
must stay silent. Exits non-zero on any gate failure.`);
}
