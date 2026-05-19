#!/usr/bin/env node

// Phase A: modeled discovery-reduction proxy.
//
// Estimates — deterministically, from already-stored data, with no agent
// execution — how much pre-task discovery the SessionStart history
// injection would have made unnecessary.
//
// For each historical session it reconstructs the context that WOULD have
// been injected, point-in-time at the session's start (untilMs = start, so
// no future leakage — same discipline as the userprompt eval), then walks
// the session's real discovery phase (the Read/Grep/Glob calls before its
// first edit) and marks a step "addressable" when either:
//   - its target file was already surfaced by the injected context, or
//   - it is a redundant repeat-read of a file already read this phase.
//
// HONEST FRAMING: this is an UPPER BOUND. It measures that the answer was
// available in injected context, not that the agent would have skipped the
// lookup. It is "addressable discovery", not "measured savings". Phase B
// (worktree dual-arm replay) is what produces ground truth. This is the
// cheap, zero-variance, CI-able estimate.

import fs from "node:fs";
import path from "node:path";
import { closeDb, getDb } from "../src/db/schema.js";
import { listRecentSessionSummaryPreviewsForCwd } from "../src/session_summaries/query.js";

const DEFAULT_LIMIT = 30;
const DEFAULT_REPOSITORY = "fml-inc/panopticon";
const DEFAULT_FIXTURE_DIR = path.join(".tmp", "evals", "reduction-proxy");
const RECENT_HISTORY_LIMIT = 5;
const RECENT_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);
// Read-only shell verbs: codex and Bash-heavy Claude flows do discovery
// here, not via the Read tool. A command counts as discovery only if every
// pipeline/compound segment's head verb is in this set (no writers/runners).
const READ_SHELL_VERBS = new Set([
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "sed",
  "awk",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "ack",
  "ls",
  "find",
  "fd",
  "wc",
  "stat",
  "file",
  "tree",
  "jq",
  "nl",
  "column",
  "od",
  "xxd",
  "hexdump",
  "realpath",
  "readlink",
  "dirname",
  "basename",
  "echo",
  "pwd",
  "true",
]);
const READ_GIT_SUBCMDS = new Set([
  "show",
  "log",
  "diff",
  "blame",
  "status",
  "cat-file",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "describe",
  "branch",
  "remote",
]);
const CHARS_PER_TOKEN = 4;
const MIN_TOKENS_PER_READ = 10;

interface Args {
  limit: number;
  repository: string;
  fixtureDir: string;
  refresh: boolean;
  verbose: boolean;
}

interface ScenarioSession {
  session_id: string;
  cwd: string;
  started_at_ms: number;
}

interface SessionMeasurement {
  session_id: string;
  injected_paths: number;
  discovery_reads: number;
  addressable_reads: number;
  discovery_tokens: number;
  addressable_tokens: number;
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
  const sessions = loadOrCreateFixture(args);
  const measurements = sessions
    .map((s) => measureSession(s))
    .filter((m): m is SessionMeasurement => m !== null);

  for (const m of measurements) {
    const pct =
      m.discovery_tokens > 0
        ? ((m.addressable_tokens / m.discovery_tokens) * 100).toFixed(0)
        : "0";
    console.log(
      `${m.session_id}  injected_paths=${m.injected_paths} ` +
        `discovery_reads=${m.discovery_reads} ` +
        `addressable=${m.addressable_reads} ` +
        `tokens ${m.addressable_tokens}/${m.discovery_tokens} (${pct}%)`,
    );
  }

  const totalDiscoveryReads = sum(measurements, (m) => m.discovery_reads);
  const totalAddressableReads = sum(measurements, (m) => m.addressable_reads);
  const totalDiscoveryTokens = sum(measurements, (m) => m.discovery_tokens);
  const totalAddressableTokens = sum(measurements, (m) => m.addressable_tokens);
  const tokenPct =
    totalDiscoveryTokens > 0
      ? ((totalAddressableTokens / totalDiscoveryTokens) * 100).toFixed(1)
      : "0.0";
  const readPct =
    totalDiscoveryReads > 0
      ? ((totalAddressableReads / totalDiscoveryReads) * 100).toFixed(1)
      : "0.0";

  console.log("");
  console.log(
    `Reduction proxy: ${measurements.length} sessions (${fixturePath(
      args.fixtureDir,
    )})`,
  );
  console.log(
    `  discovery reads: ${totalAddressableReads}/${totalDiscoveryReads} ` +
      `addressable (${readPct}%)`,
  );
  console.log(
    `  discovery tokens: ${totalAddressableTokens}/${totalDiscoveryTokens} ` +
      `addressable (${tokenPct}%)`,
  );
  console.log(
    "  NOTE: modeled upper bound — answer was available in injected " +
      "context, not proof the lookup would be skipped. See Phase B for " +
      "ground truth.",
  );
}

function measureSession(s: ScenarioSession): SessionMeasurement | null {
  const db = getDb();

  // 1. The exact paths SessionStart would have injected, point-in-time.
  const previews = listRecentSessionSummaryPreviewsForCwd({
    cwdCandidates: [s.cwd],
    currentSessionId: s.session_id,
    sinceMs: s.started_at_ms - RECENT_HISTORY_MAX_AGE_MS,
    untilMs: s.started_at_ms,
    limit: RECENT_HISTORY_LIMIT,
  });
  const injectedSuffixes = new Set<string>();
  for (const p of previews) {
    for (const f of p.top_files) {
      injectedSuffixes.add(basenameKey(f.file_path));
    }
  }

  // 2. The discovery phase: every PostToolUse before the first edit, then
  // classified — a Read/Grep/Glob tool call, or a read-only Bash command.
  const firstEdit = db
    .prepare(
      `SELECT MIN(timestamp_ms) AS ts
       FROM hook_events
       WHERE session_id = ? AND event_type = 'PostToolUse'
         AND tool_name IN (${placeholders(EDIT_TOOLS.size)})`,
    )
    .get(s.session_id, ...EDIT_TOOLS) as { ts: number | null };
  if (firstEdit.ts == null) return null; // no task boundary — skip

  const events = db
    .prepare(
      `SELECT tool_name, file_path, command,
              LENGTH(tool_result) AS result_len
       FROM hook_events
       WHERE session_id = ? AND event_type = 'PostToolUse'
         AND timestamp_ms < ?
       ORDER BY timestamp_ms ASC, id ASC`,
    )
    .all(s.session_id, firstEdit.ts) as Array<{
    tool_name: string | null;
    file_path: string | null;
    command: string | null;
    result_len: number | null;
  }>;

  // 3. Mark addressable: injected-covered, or a redundant repeat-lookup.
  const seenFiles = new Set<string>();
  const seenCommands = new Set<string>();
  let discoveryReads = 0;
  let addressableReads = 0;
  let discoveryTokens = 0;
  let addressableTokens = 0;

  for (const e of events) {
    const targets: string[] = [];
    let isDiscovery = false;
    let repeatKey: string | null = null;

    if (e.tool_name && READ_TOOLS.has(e.tool_name)) {
      isDiscovery = true;
      if (e.file_path) targets.push(e.file_path);
      repeatKey = e.file_path ? `f:${basenameKey(e.file_path)}` : null;
    } else if (e.tool_name === "Bash" && isReadOnlyCommand(e.command)) {
      isDiscovery = true;
      targets.push(...extractCommandPaths(e.command ?? ""));
      repeatKey = `c:${normalizeCommand(e.command ?? "")}`;
    }
    if (!isDiscovery) continue;

    const tokens = Math.max(
      MIN_TOKENS_PER_READ,
      Math.ceil((e.result_len ?? 0) / CHARS_PER_TOKEN),
    );
    discoveryReads += 1;
    discoveryTokens += tokens;

    const fileKeys = targets.map(basenameKey);
    const coveredByInjection = fileKeys.some((k) => injectedSuffixes.has(k));
    const repeatFile = fileKeys.some((k) => seenFiles.has(k));
    const repeatCommand = repeatKey?.startsWith("c:")
      ? seenCommands.has(repeatKey)
      : false;

    for (const k of fileKeys) seenFiles.add(k);
    if (repeatKey?.startsWith("c:")) seenCommands.add(repeatKey);

    if (coveredByInjection || repeatFile || repeatCommand) {
      addressableReads += 1;
      addressableTokens += tokens;
    }
  }

  if (discoveryReads === 0) return null;

  return {
    session_id: s.session_id,
    injected_paths: injectedSuffixes.size,
    discovery_reads: discoveryReads,
    addressable_reads: addressableReads,
    discovery_tokens: discoveryTokens,
    addressable_tokens: addressableTokens,
  };
}

function basenameKey(filePath: string): string {
  return path.basename(filePath.replace(/['"]/g, "")).toLowerCase();
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

// A command is discovery iff every pipeline/compound segment is a pure
// read verb (or a read-only `git` subcommand) and nothing writes output.
export function isReadOnlyCommand(command: string | null): boolean {
  if (!command) return false;
  const cmd = command.trim();
  if (cmd.length === 0) return false;
  // Any output redirection or in-place writer disqualifies it.
  if (/[^>]>>?[^>]|\btee\b|\bsponge\b/.test(cmd)) return false;
  const segments = cmd.split(/\||&&|\|\||;/).map((seg) => seg.trim());
  for (const seg of segments) {
    if (seg.length === 0) continue;
    // Drop leading env assignments (FOO=bar cmd ...).
    const tokens = seg
      .split(/\s+/)
      .filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    let head = tokens[0];
    if (!head) return false;
    if (head === "sudo" || head === "xargs" || head === "env") return false;
    if (head === "cd") {
      // `cd x && cat y` — the cd itself reads nothing; keep scanning.
      const next = tokens.find((t, i) => i > 1 && !t.startsWith("-"));
      if (!next) continue;
      head = next;
    }
    if (head === "git") {
      const sub = tokens.find((t, i) => i > 0 && !t.startsWith("-"));
      if (!sub || !READ_GIT_SUBCMDS.has(sub)) return false;
      continue;
    }
    if (!READ_SHELL_VERBS.has(head)) return false;
  }
  return true;
}

export function extractCommandPaths(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/\s+/)) {
    const t = raw.replace(/^['"]|['"]$/g, "");
    if (t.length === 0 || t.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    // Path-like: has a slash, or a file extension, and isn't a glob/regex.
    const looksLikePath =
      (t.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(t)) &&
      !/[*?{}()|^$]/.test(t);
    if (looksLikePath) out.push(t);
  }
  return out;
}

function placeholders(n: number): string {
  return Array(n).fill("?").join(", ");
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}

function loadOrCreateFixture(args: Args): ScenarioSession[] {
  const filePath = fixturePath(args.fixtureDir);
  if (!args.refresh && fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ScenarioSession[];
  }
  const sessions = sampleSessions(args.limit, args.repository);
  fs.mkdirSync(args.fixtureDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(sessions, null, 2)}\n`);
  return sessions;
}

function fixturePath(dir: string): string {
  return path.join(dir, "sessions.json");
}

function sampleSessions(limit: number, repository: string): ScenarioSession[] {
  const db = getDb();
  // Interactive sessions in the target repo that have a discovery->edit
  // shape: at least one Read before at least one Edit.
  // cwd lives in session_cwds (sessions.cwd is unpopulated); the earliest
  // cwd is the one SessionStart would have injected against. Corpus is any
  // non-automated session with an edit boundary and prior tool activity —
  // discovery is classified per-event in JS (Read tool *or* read-only Bash)
  // so codex/Bash-heavy flows are included, not just the Read tool.
  const rows = db
    .prepare(
      `SELECT s.session_id AS session_id,
              (SELECT sc.cwd FROM session_cwds sc
               WHERE sc.session_id = s.session_id
               ORDER BY sc.first_seen_ms ASC LIMIT 1) AS cwd,
              s.started_at_ms AS started_at_ms
       FROM sessions s
       JOIN session_repositories sr ON sr.session_id = s.session_id
       WHERE sr.repository = ?
         AND COALESCE(s.is_automated, 0) != 1
         AND s.started_at_ms IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM session_cwds sc WHERE sc.session_id = s.session_id
         )
         AND EXISTS (
           SELECT 1 FROM hook_events e
           WHERE e.session_id = s.session_id
             AND e.event_type = 'PostToolUse'
             AND e.tool_name IN (${placeholders(EDIT_TOOLS.size)})
         )
       ORDER BY s.started_at_ms DESC
       LIMIT ?`,
    )
    .all(repository, ...EDIT_TOOLS, limit) as ScenarioSession[];
  return rows;
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    limit: DEFAULT_LIMIT,
    repository: DEFAULT_REPOSITORY,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    refresh: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      parsed.limit = parsePositiveInt(argv[++i], "--limit");
    } else if (arg === "--repository") {
      parsed.repository = readArgValue(argv, ++i, "--repository");
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
  console.log(`Usage: pnpm eval:reduction -- [options]

Options:
  --limit N           Sessions sampled from the local DB (default: ${DEFAULT_LIMIT})
  --repository SLUG   Repository filter (default: ${DEFAULT_REPOSITORY})
  --fixture-dir PATH  Fixture directory (default: ${DEFAULT_FIXTURE_DIR})
  --refresh           Resample sessions from the local DB
  --verbose           (reserved)
  --help, -h          Show this help

Modeled upper-bound estimate of discovery the SessionStart injection
would have made unnecessary. Deterministic; no agent execution.`);
}
