#!/usr/bin/env node

// Real-traffic reduction proxy for PreToolUse(Read) context injection.
//
// This is intentionally shaped like eval-reduction-proxy's SessionStart
// measurement: for captured pre-edit discovery reads, report how many reads
// and read-result tokens were addressable because read-time file context
// would have been injected.

import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { closeDb, getDb } from "../src/db/schema.js";
import { buildPreToolUseReadFileContext } from "../src/hooks/session-context.js";

const DEFAULT_LIMIT = 500;
const DEFAULT_REPOSITORY = "fml-inc/panopticon";
const CHARS_PER_TOKEN = 4;
const MIN_TOKENS_PER_READ = 10;
const EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);

interface Args {
  limit: number;
  repository: string | null;
  includeAllRepositories: boolean;
  includeAfterFirstEdit: boolean;
  fixtureFile: string | null;
  json: boolean;
  verbose: boolean;
}

interface ReadEventRow {
  id: number;
  session_id: string;
  timestamp_ms: number;
  cwd: string | null;
  repository: string | null;
  file_path: string;
  target: string | null;
  result_len: number | null;
}

interface SessionMeasurement {
  session_id: string;
  injected_paths: number;
  discovery_reads: number;
  addressable_reads: number;
  injection_only_addressable_reads: number;
  discovery_tokens: number;
  addressable_tokens: number;
  injection_only_addressable_tokens: number;
  context_tokens: number;
  duplicate_addressable_reads: number;
  blocked_by_target_guard: number;
}

interface Measurement {
  args: Args;
  sessions: SessionMeasurement[];
  summary: {
    session_count: number;
    read_events: number;
    injected_paths: number;
    discovery_reads: number;
    addressable_reads: number;
    injection_only_addressable_reads: number;
    discovery_tokens: number;
    addressable_tokens: number;
    injection_only_addressable_tokens: number;
    context_tokens: number;
    duplicate_addressable_reads: number;
    blocked_by_target_guard: number;
    addressable_read_rate: number;
    addressable_token_rate: number;
    context_roi: number | null;
    injection_only_context_roi: number | null;
    targets: Record<string, number>;
  };
  latency_ms: {
    p50: number;
    p95: number;
    max: number;
  };
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
  const rows = loadReadEvents(args);
  const measurement = measure(rows, args);
  if (args.json) {
    console.log(JSON.stringify(measurement, null, 2));
    return;
  }
  printMeasurement(measurement);
}

function loadReadEvents(args: Args): ReadEventRow[] {
  const db = getDb();
  const sessionIds = args.fixtureFile
    ? loadFixtureSessionIds(args.fixtureFile)
    : [];
  const where = [
    "pre.event_type = 'PreToolUse'",
    "pre.tool_name = 'Read'",
    "pre.file_path IS NOT NULL",
    "TRIM(pre.file_path) != ''",
  ];
  const params: Record<string, unknown> = { limit: args.limit };
  if (!args.includeAllRepositories && args.repository) {
    where.push("pre.repository = @repository");
    params.repository = args.repository;
  }
  if (!args.includeAfterFirstEdit) {
    where.push("pre.timestamp_ms < fe.first_edit_ts");
  }
  if (sessionIds.length > 0) {
    const keys = sessionIds.map((_, index) => `@session_${index}`);
    where.push(`pre.session_id IN (${keys.join(", ")})`);
    for (const [index, sessionId] of sessionIds.entries()) {
      params[`session_${index}`] = sessionId;
    }
  }

  return db
    .prepare(
      `WITH first_edit AS (
         SELECT session_id, MIN(timestamp_ms) AS first_edit_ts
         FROM hook_events
         WHERE event_type = 'PostToolUse'
           AND tool_name IN (${sqlStringList(EDIT_TOOLS)})
         GROUP BY session_id
       )
       SELECT id,
              session_id,
              timestamp_ms,
              cwd,
              repository,
              file_path,
              target,
              result_len
       FROM (
         SELECT pre.id AS id,
                pre.session_id AS session_id,
                pre.timestamp_ms AS timestamp_ms,
                pre.cwd AS cwd,
                pre.repository AS repository,
                pre.file_path AS file_path,
                pre.target AS target,
                (
                  SELECT LENGTH(post.tool_result)
                  FROM hook_events post
                  WHERE post.session_id = pre.session_id
                    AND post.event_type = 'PostToolUse'
                    AND post.tool_name = 'Read'
                    AND post.file_path = pre.file_path
                    AND post.timestamp_ms >= pre.timestamp_ms
                  ORDER BY post.timestamp_ms ASC, post.id ASC
                  LIMIT 1
                ) AS result_len
         FROM hook_events pre
         JOIN first_edit fe ON fe.session_id = pre.session_id
         WHERE ${where.join(" AND ")}
         ORDER BY pre.timestamp_ms DESC, pre.id DESC
         LIMIT @limit
       )
       ORDER BY timestamp_ms ASC, id ASC`,
    )
    .all(params) as ReadEventRow[];
}

function loadFixtureSessionIds(filePath: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Fixture must be an array: ${filePath}`);
  }
  const ids = parsed
    .map((item) => {
      if (typeof item === "string") return item;
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { session_id?: unknown }).session_id === "string"
      ) {
        return (item as { session_id: string }).session_id;
      }
      return null;
    })
    .filter((value): value is string => typeof value === "string");
  return [...new Set(ids)];
}

function measure(rows: ReadEventRow[], args: Args): Measurement {
  const bySession = new Map<string, ReadEventRow[]>();
  const targets: Record<string, number> = {};
  for (const row of rows) {
    const sessionRows = bySession.get(row.session_id) ?? [];
    sessionRows.push(row);
    bySession.set(row.session_id, sessionRows);
    const targetKey = row.target ?? "(null)";
    targets[targetKey] = (targets[targetKey] ?? 0) + 1;
  }

  const durations: number[] = [];
  const sessions = [...bySession.entries()].map(([sessionId, sessionRows]) =>
    measureSession(sessionId, sessionRows, durations, args.verbose),
  );

  const summary = {
    session_count: sessions.length,
    read_events: rows.length,
    injected_paths: sum(sessions, (m) => m.injected_paths),
    discovery_reads: sum(sessions, (m) => m.discovery_reads),
    addressable_reads: sum(sessions, (m) => m.addressable_reads),
    injection_only_addressable_reads: sum(
      sessions,
      (m) => m.injection_only_addressable_reads,
    ),
    discovery_tokens: sum(sessions, (m) => m.discovery_tokens),
    addressable_tokens: sum(sessions, (m) => m.addressable_tokens),
    injection_only_addressable_tokens: sum(
      sessions,
      (m) => m.injection_only_addressable_tokens,
    ),
    context_tokens: sum(sessions, (m) => m.context_tokens),
    duplicate_addressable_reads: sum(
      sessions,
      (m) => m.duplicate_addressable_reads,
    ),
    blocked_by_target_guard: sum(sessions, (m) => m.blocked_by_target_guard),
    addressable_read_rate: 0,
    addressable_token_rate: 0,
    context_roi: null as number | null,
    injection_only_context_roi: null as number | null,
    targets,
  };
  summary.addressable_read_rate = safeRatio(
    summary.addressable_reads,
    summary.discovery_reads,
  );
  summary.addressable_token_rate = safeRatio(
    summary.addressable_tokens,
    summary.discovery_tokens,
  );
  summary.context_roi =
    summary.context_tokens > 0
      ? summary.addressable_tokens / summary.context_tokens
      : null;
  summary.injection_only_context_roi =
    summary.context_tokens > 0
      ? summary.injection_only_addressable_tokens / summary.context_tokens
      : null;

  return {
    args,
    sessions,
    summary,
    latency_ms: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length > 0 ? Math.max(...durations) : 0,
    },
  };
}

function measureSession(
  sessionId: string,
  rows: ReadEventRow[],
  durations: number[],
  verbose: boolean,
): SessionMeasurement {
  const injectedPaths = new Set<string>();
  const seenReadPaths = new Set<string>();
  let discoveryReads = 0;
  let addressableReads = 0;
  let injectionOnlyAddressableReads = 0;
  let discoveryTokens = 0;
  let addressableTokens = 0;
  let injectionOnlyAddressableTokens = 0;
  let contextTokens = 0;
  let duplicateAddressableReads = 0;
  let blockedByTargetGuard = 0;

  for (const row of rows) {
    const readKey = pathKey(row.file_path);
    const duplicateRead = seenReadPaths.has(readKey);
    seenReadPaths.add(readKey);

    const tokens = Math.max(
      MIN_TOKENS_PER_READ,
      Math.ceil((row.result_len ?? 0) / CHARS_PER_TOKEN),
    );
    discoveryReads += 1;
    discoveryTokens += tokens;

    const started = performance.now();
    const context = buildPreToolUseReadFileContext({
      session_id: row.session_id,
      cwd: row.cwd ?? undefined,
      repository: row.repository ?? undefined,
      now_ms: row.timestamp_ms,
      tool_input: { file_path: row.file_path },
    });
    durations.push(performance.now() - started);

    const canInject = targetAllowsLiveInjection(row.target);
    const firstInjectionForPath = context && !injectedPaths.has(readKey);
    if (firstInjectionForPath) {
      if (canInject) {
        injectedPaths.add(readKey);
        contextTokens += estimateTokens(context);
        if (verbose) {
          console.log(
            `${sessionId} inject ${row.file_path} context_tokens=${estimateTokens(
              context,
            )}`,
          );
        }
      } else {
        blockedByTargetGuard += 1;
      }
    }

    const coveredByInjection = canInject && context !== null;
    const injectionOnlyAddressable = coveredByInjection && !duplicateRead;
    const addressable = coveredByInjection || duplicateRead;
    if (addressable) {
      addressableReads += 1;
      addressableTokens += tokens;
      if (duplicateRead && !coveredByInjection) duplicateAddressableReads += 1;
    }
    if (injectionOnlyAddressable) {
      injectionOnlyAddressableReads += 1;
      injectionOnlyAddressableTokens += tokens;
    }
  }

  return {
    session_id: sessionId,
    injected_paths: injectedPaths.size,
    discovery_reads: discoveryReads,
    addressable_reads: addressableReads,
    injection_only_addressable_reads: injectionOnlyAddressableReads,
    discovery_tokens: discoveryTokens,
    addressable_tokens: addressableTokens,
    injection_only_addressable_tokens: injectionOnlyAddressableTokens,
    context_tokens: contextTokens,
    duplicate_addressable_reads: duplicateAddressableReads,
    blocked_by_target_guard: blockedByTargetGuard,
  };
}

function targetAllowsLiveInjection(target: string | null): boolean {
  return target == null || target === "unknown" || target === "claude";
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

function pathKey(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function sqlStringList(values: Iterable<string>): string {
  return [...values].map((value) => `'${value.replace(/'/g, "''")}'`).join(",");
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function printMeasurement(m: Measurement): void {
  for (const session of m.sessions) {
    const pct =
      session.discovery_tokens > 0
        ? (
            (session.addressable_tokens / session.discovery_tokens) *
            100
          ).toFixed(0)
        : "0";
    console.log(
      `${session.session_id}  injected_paths=${session.injected_paths} ` +
        `discovery_reads=${session.discovery_reads} ` +
        `addressable=${session.addressable_reads} ` +
        `tokens ${session.addressable_tokens}/${session.discovery_tokens} (${pct}%) ` +
        `context_tokens=${session.context_tokens}`,
    );
  }

  const readPct = formatPercent(m.summary.addressable_read_rate);
  const tokenPct = formatPercent(m.summary.addressable_token_rate);

  console.log("");
  console.log(
    `PreToolUse(Read) reduction proxy: ${m.summary.session_count} sessions`,
  );
  console.log(
    `  discovery reads: ${m.summary.addressable_reads}/${m.summary.discovery_reads} ` +
      `addressable (${readPct})`,
  );
  console.log(
    `  discovery tokens: ${m.summary.addressable_tokens}/${m.summary.discovery_tokens} ` +
      `addressable (${tokenPct})`,
  );
  console.log(
    `  injected context: ${m.summary.injected_paths} path(s), ` +
      `${m.summary.context_tokens} token(s)` +
      (m.summary.context_roi == null
        ? ""
        : `, roi=${m.summary.context_roi.toFixed(2)}x`),
  );
  console.log(
    `  injection-only tokens: ${m.summary.injection_only_addressable_tokens}/${m.summary.discovery_tokens}` +
      (m.summary.injection_only_context_roi == null
        ? ""
        : `, roi=${m.summary.injection_only_context_roi.toFixed(2)}x`),
  );
  console.log(
    `  target guard blocked: ${m.summary.blocked_by_target_guard}; targets=${formatTargets(
      m.summary.targets,
    )}`,
  );
  console.log(
    `  build latency: p50=${m.latency_ms.p50.toFixed(1)}ms ` +
      `p95=${m.latency_ms.p95.toFixed(1)}ms max=${m.latency_ms.max.toFixed(1)}ms`,
  );
  console.log(
    "  NOTE: modeled upper bound — context was available before the read, " +
      "not proof the lookup would be skipped.",
  );
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTargets(targets: Record<string, number>): string {
  const parts = Object.entries(targets)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([target, count]) => `${target}:${count}`);
  return parts.length > 0 ? parts.join(", ") : "(none)";
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    limit: DEFAULT_LIMIT,
    repository: DEFAULT_REPOSITORY,
    includeAllRepositories: false,
    includeAfterFirstEdit: false,
    fixtureFile: null,
    json: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      parsed.limit = parsePositiveInt(argv[++i], "--limit");
    } else if (arg === "--repository") {
      parsed.repository = readArgValue(argv, ++i, "--repository");
    } else if (arg === "--all-repositories") {
      parsed.includeAllRepositories = true;
      parsed.repository = null;
    } else if (arg === "--include-after-first-edit") {
      parsed.includeAfterFirstEdit = true;
    } else if (arg === "--fixture-file") {
      parsed.fixtureFile = readArgValue(argv, ++i, "--fixture-file");
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--") {
      // pnpm passes a bare separator through; ignore it.
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
  console.log(`Usage: pnpm exec tsup scripts/eval-pretooluse-read-realtime.ts --format esm --platform node --target node24 --out-dir .tmp/eval-build --silent --no-dts
node .tmp/eval-build/eval-pretooluse-read-realtime.js [options]

Options:
  --limit N                   Most recent Read hook rows to replay (default: ${DEFAULT_LIMIT})
  --repository SLUG           Repository filter (default: ${DEFAULT_REPOSITORY})
  --all-repositories          Include all repositories
  --fixture-file PATH         Restrict to session_id values from a fixture JSON
  --include-after-first-edit  Include reads after the first edit boundary
  --json                      Emit JSON
  --verbose                   Print injected-path debug lines
  --help, -h                  Show this help

Modeled upper-bound estimate of discovery the PreToolUse(Read) injection
would have made unnecessary. Deterministic; no agent execution.`);
}
