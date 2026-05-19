#!/usr/bin/env node

// Phase B: counterfactual session replay (ground-truth reduction A/B).
//
// For a historical session it reconstructs the repo at the commit the
// session started from (session_repositories.head_sha — the replay anchor
// added for exactly this), then replays the session's user prompts through
// a headless agent TWICE in isolated git worktrees:
//
//   Arm A (control)   — Panopticon injection DISABLED
//   Arm B (treatment) — Panopticon injection ENABLED (default)
//
// It captures wall-clock and token usage per arm, and an LLM judge decides
// whether each arm accomplished the same goal as the historical session
// (the outcome oracle — token/time deltas are meaningless without it).
// Aggregates only over scenarios where BOTH arms are judged accomplished.
//
// COST: each scenario spawns two full agent runs. This is a manual
// benchmark, NOT CI. Default is --dry-run: it selects the corpus,
// resolves anchors, creates/cleans worktrees, and prints the exact arm
// commands + judge plan WITHOUT spawning agents, so the mechanics are
// verifiable for free. Pass --execute to actually run.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "../src/db/schema.js";
import { invokeLlmAsync } from "../src/summary/llm.js";

const DEFAULT_LIMIT = 4;
const DEFAULT_REPOSITORY = "fml-inc/panopticon";
const DEFAULT_REPO_ROOT = "/Users/gus/workspace/panopticon";
const DEFAULT_FIXTURE_DIR = path.join(".tmp", "evals", "replay-counterfactual");
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

// Arm B keeps Panopticon defaults (injection on). Arm A turns every
// injection surface off so the only difference between arms is injection.
const INJECTION_OFF_ENV = {
  PANOPTICON_ENABLE_SESSION_START_HISTORY_INJECTION: "0",
  PANOPTICON_ENABLE_USER_PROMPT_SUBMIT_CONTEXT_INJECTION: "0",
  PANOPTICON_ENABLE_PRE_TOOL_USE_FILE_CONTEXT_INJECTION: "0",
};

interface Args {
  limit: number;
  repository: string;
  repoRoot: string;
  fixtureDir: string;
  execute: boolean;
  judgeModel: string | null;
  agentTimeoutMs: number;
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
  // Set when the scenario is anchored to a merged PR (the strong oracle):
  // the judge scores each arm's diff against the PR's actual change.
  pr_number?: number;
  merge_commit?: string;
  branch?: string;
  pr_title?: string;
  expected_diffstat?: string;
}

interface ArmResult {
  arm: "control" | "treatment";
  durationMs: number;
  totalTokens: number | null;
  exitOk: boolean;
  diffSummary: string;
}

interface ScenarioResult {
  session_id: string;
  control: ArmResult | null;
  treatment: ArmResult | null;
  controlAccomplished: boolean | null;
  treatmentAccomplished: boolean | null;
  judgeNotes: string;
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
  const scenarios = loadOrCreateFixture(args);

  if (scenarios.length === 0) {
    console.log(
      "No replayable scenarios: need sessions with a captured " +
        "session_repositories.head_sha, user prompts, and edits. " +
        "(head_sha capture is recent — older sessions are excluded.)",
    );
    return;
  }

  console.log(
    `Phase B counterfactual: ${scenarios.length} scenario(s) ` +
      `[${args.execute ? "EXECUTE" : "DRY-RUN"}]\n`,
  );

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    console.log(
      `=== ${s.session_id} @ ${s.head_sha.slice(0, 12)} ` +
        `[${s.anchor}${s.pr_number ? ` PR#${s.pr_number}` : ""}] ` +
        `(${s.prompts.length} prompt(s)) ===`,
    );
    console.log(`  goal: ${oneLine(s.first_prompt, 140)}`);
    results.push(await runScenario(s, args));
  }

  report(results, args);
}

async function runScenario(s: Scenario, args: Args): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    session_id: s.session_id,
    control: null,
    treatment: null,
    controlAccomplished: null,
    treatmentAccomplished: null,
    judgeNotes: "",
  };

  for (const arm of ["control", "treatment"] as const) {
    const env = arm === "control" ? INJECTION_OFF_ENV : {};
    const worktree = path.join(
      os.tmpdir(),
      `pano-replay-${s.session_id.slice(0, 8)}-${arm}`,
    );
    const plan = buildArmPlan(s, args, env, worktree);

    if (!args.execute) {
      console.log(`  [dry-run] ${arm}: worktree ${worktree}`);
      console.log(
        `    env: ${Object.keys(env).length ? JSON.stringify(env) : "(panopticon defaults)"}`,
      );
      console.log(`    ${plan.command} ${plan.args.join(" ")}`);
      continue;
    }

    result[arm] = await executeArm(s, args, env, worktree, arm);
  }

  if (args.execute && result.control && result.treatment) {
    const verdict = await judge(s, result.control, result.treatment, args);
    result.controlAccomplished = verdict.control;
    result.treatmentAccomplished = verdict.treatment;
    result.judgeNotes = verdict.notes;
  }

  return result;
}

function buildArmPlan(
  s: Scenario,
  _args: Args,
  _env: Record<string, string>,
  worktree: string,
): { command: string; args: string[] } {
  // Prompts are replayed as a single batched task instruction so one
  // headless invocation drives the whole session; SessionStart /
  // UserPromptSubmit / PreToolUse hooks fire under that process and inject
  // (treatment) or not (control).
  const task = [
    "Replay of a historical coding session. Carry out the following",
    "user request(s) in order, making the actual code changes:",
    "",
    ...s.prompts.map((p, i) => `(${i + 1}) ${p}`),
  ].join("\n");
  return {
    command: "claude",
    args: [
      "-p",
      task,
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      worktree,
    ],
  };
}

async function executeArm(
  s: Scenario,
  args: Args,
  env: Record<string, string>,
  worktree: string,
  arm: "control" | "treatment",
): Promise<ArmResult> {
  removeWorktree(args.repoRoot, worktree);
  execFileSync(
    "git",
    ["-C", args.repoRoot, "worktree", "add", "--detach", worktree, s.head_sha],
    { stdio: "ignore" },
  );
  try {
    const plan = buildArmPlan(s, args, env, worktree);
    const start = Date.now();
    let exitOk = true;
    let stdout = "";
    try {
      stdout = execFileSync(plan.command, plan.args, {
        cwd: worktree,
        env: { ...process.env, ...env },
        timeout: args.agentTimeoutMs,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      exitOk = false;
      stdout =
        (err as { stdout?: string }).stdout ??
        (err instanceof Error ? err.message : String(err));
    }
    const durationMs = Date.now() - start;
    const diffSummary = execFileSync(
      "git",
      ["-C", worktree, "diff", "--stat"],
      { encoding: "utf-8" },
    ).trim();
    console.log(
      `  ${arm}: ${exitOk ? "ok" : "FAILED"} ${durationMs}ms ` +
        `tokens=${extractTokens(stdout) ?? "?"}`,
    );
    return {
      arm,
      durationMs,
      totalTokens: extractTokens(stdout),
      exitOk,
      diffSummary,
    };
  } finally {
    removeWorktree(args.repoRoot, worktree);
  }
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

async function judge(
  s: Scenario,
  control: ArmResult,
  treatment: ArmResult,
  args: Args,
): Promise<{ control: boolean; treatment: boolean; notes: string }> {
  // PR-anchored scenarios have a ground-truth outcome (the merged diff);
  // judge each arm against THAT. Otherwise fall back to goal-equivalence
  // against the historical prompts.
  const oracle = s.expected_diffstat
    ? `Ground truth — the change the historical session actually merged as PR #${s.pr_number} ("${s.pr_title}"). Resulting git diff --stat of the real merged PR:
${s.expected_diffstat}`
    : `Historical goal (first user prompt):
${s.first_prompt}

All historical user prompts:
${s.prompts.map((p, i) => `(${i + 1}) ${p}`).join("\n")}`;

  const prompt = `You are judging whether two automated attempts accomplished the SAME work as a historical coding session.

${oracle}

Attempt A (control) resulting git diff --stat:
${control.diffSummary || "(no changes)"}

Attempt B (treatment) resulting git diff --stat:
${treatment.diffSummary || "(no changes)"}

For EACH attempt, decide if it plausibly accomplished the same change as the ground truth above (same files/area and shape of change — NOT a literal match). Respond as strict JSON:
{"control":"accomplished|partial|failed","treatment":"accomplished|partial|failed","notes":"one sentence"}`;

  const raw = await invokeLlmAsync(prompt, {
    model: args.judgeModel,
    timeoutMs: 120_000,
  });
  try {
    const fence = raw?.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(fence ? fence[0] : (raw ?? "{}")) as {
      control?: string;
      treatment?: string;
      notes?: string;
    };
    return {
      control: parsed.control === "accomplished",
      treatment: parsed.treatment === "accomplished",
      notes: parsed.notes ?? "",
    };
  } catch {
    return { control: false, treatment: false, notes: "judge parse failed" };
  }
}

function report(results: ScenarioResult[], args: Args): void {
  console.log("");
  if (!args.execute) {
    console.log(
      `DRY-RUN complete: ${results.length} scenario(s) planned. ` +
        "Pass --execute to run the dual-arm agents (expensive).",
    );
    return;
  }
  const comparable = results.filter(
    (r) => r.controlAccomplished && r.treatmentAccomplished,
  );
  console.log(
    `Phase B: ${results.length} scenarios, ${comparable.length} ` +
      "comparable (both arms accomplished the goal)",
  );
  for (const r of comparable) {
    const c = r.control as ArmResult;
    const t = r.treatment as ArmResult;
    const tokDelta =
      c.totalTokens != null && t.totalTokens != null
        ? `${(((c.totalTokens - t.totalTokens) / c.totalTokens) * 100).toFixed(0)}%`
        : "n/a";
    console.log(
      `  ${r.session_id}: tokens ctl=${c.totalTokens} trt=${t.totalTokens} ` +
        `(treatment saves ${tokDelta}); time ctl=${c.durationMs}ms ` +
        `trt=${t.durationMs}ms`,
    );
  }
  console.log(
    "  NOTE: small-N manual benchmark; agent runs are stochastic — " +
      "treat as directional, not precise.",
  );
}

function loadOrCreateFixture(args: Args): Scenario[] {
  const filePath = path.join(args.fixtureDir, "scenarios.json");
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Scenario[];
  }
  const scenarios = sampleScenarios(args);
  fs.mkdirSync(args.fixtureDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(scenarios, null, 2)}\n`);
  return scenarios;
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

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    limit: DEFAULT_LIMIT,
    repository: DEFAULT_REPOSITORY,
    repoRoot: DEFAULT_REPO_ROOT,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    execute: false,
    judgeModel: null,
    agentTimeoutMs: AGENT_TIMEOUT_MS,
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
    } else if (arg === "--judge-model") {
      parsed.judgeModel = argv[++i];
    } else if (arg === "--timeout-ms") {
      parsed.agentTimeoutMs = Number(argv[++i]);
    } else if (arg === "--execute") {
      parsed.execute = true;
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
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: pnpm eval:replay -- [options]

Reconstructs each session at its captured head_sha and replays its
prompts through a headless agent twice (injection off vs on), then an
LLM judge decides goal-equivalence.

Options:
  --limit N          Scenarios sampled (default: ${DEFAULT_LIMIT})
  --repository SLUG   Repository filter (default: ${DEFAULT_REPOSITORY})
  --repo-root PATH    Local git repo to make worktrees from
  --fixture-dir PATH  Scenario fixture directory
  --judge-model M     Model for the LLM judge
  --execute           Actually spawn the dual-arm agents (EXPENSIVE).
                      Default is a dry-run (plan only, no agent spawn).
  --help, -h          Show this help

Manual benchmark — not CI. Agent runs are stochastic and token-costly.`);
}
