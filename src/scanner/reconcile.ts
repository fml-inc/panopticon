import { getDb } from "../db/schema.js";

export interface SessionComparison {
  sessionId: string;
  source: string;
  hookEvents: number;
  hookTarget: string | null;
  // OTLP token breakdown
  otelInput: number;
  otelOutput: number;
  otelCacheRead: number;
  otelCacheCreation: number;
  // Scanner token breakdown
  scannerTurns: number;
  scannerInput: number;
  scannerOutput: number;
  scannerCacheRead: number;
  scannerCacheCreation: number;
  scannerReasoning: number;
  coverage: "both" | "hooks_only" | "scanner_only";
}

export interface ReconcileReport {
  sessions: SessionComparison[];
  summary: {
    total: number;
    both: number;
    hooksOnly: number;
    scannerOnly: number;
    otel: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
    };
    scanner: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      reasoning: number;
    };
  };
}

const RECONCILE_SQL = `
  WITH hook_summary AS (
    SELECT session_id,
      COUNT(*) as hook_count,
      MAX(target) as target
    FROM hook_events
    GROUP BY session_id
  ),
  otel_by_type AS (
    SELECT session_id,
      COALESCE(SUM(CASE WHEN json_extract(attributes, '$.type') = 'input' THEN value END), 0) as input_tok,
      COALESCE(SUM(CASE WHEN json_extract(attributes, '$.type') = 'output' THEN value END), 0) as output_tok,
      COALESCE(SUM(CASE WHEN json_extract(attributes, '$.type') = 'cacheRead' THEN value END), 0) as cache_read_tok,
      COALESCE(SUM(CASE WHEN json_extract(attributes, '$.type') = 'cacheCreation' THEN value END), 0) as cache_creation_tok
    FROM otel_metrics
    WHERE name LIKE '%token%'
    GROUP BY session_id
  ),
  scanner_summary AS (
    SELECT session_id, target as source, turn_count,
      total_input_tokens, total_output_tokens,
      total_cache_read_tokens, total_cache_creation_tokens, total_reasoning_tokens
    FROM sessions
    WHERE scanner_file_path IS NOT NULL
  ),
  all_sessions AS (
    SELECT session_id FROM hook_summary
    UNION
    SELECT session_id FROM scanner_summary
  )
  SELECT
    a.session_id,
    COALESCE(sc.source, h.target, 'unknown') as source,
    COALESCE(h.hook_count, 0) as hook_events,
    h.target as hook_target,
    COALESCE(o.input_tok, 0) as otel_input,
    COALESCE(o.output_tok, 0) as otel_output,
    COALESCE(o.cache_read_tok, 0) as otel_cache_read,
    COALESCE(o.cache_creation_tok, 0) as otel_cache_creation,
    COALESCE(sc.turn_count, 0) as scanner_turns,
    COALESCE(sc.total_input_tokens, 0) as scanner_input,
    COALESCE(sc.total_output_tokens, 0) as scanner_output,
    COALESCE(sc.total_cache_read_tokens, 0) as scanner_cache_read,
    COALESCE(sc.total_cache_creation_tokens, 0) as scanner_cache_creation,
    COALESCE(sc.total_reasoning_tokens, 0) as scanner_reasoning,
    CASE
      WHEN h.hook_count > 0 AND sc.session_id IS NOT NULL THEN 'both'
      WHEN h.hook_count > 0 THEN 'hooks_only'
      ELSE 'scanner_only'
    END as coverage
  FROM all_sessions a
  LEFT JOIN hook_summary h ON a.session_id = h.session_id
  LEFT JOIN otel_by_type o ON a.session_id = o.session_id
  LEFT JOIN scanner_summary sc ON a.session_id = sc.session_id
  ORDER BY coverage, a.session_id
`;

export function reconcile(): ReconcileReport {
  const db = getDb();
  const rows = db.prepare(RECONCILE_SQL).all() as Array<{
    session_id: string;
    source: string;
    hook_events: number;
    hook_target: string | null;
    otel_input: number;
    otel_output: number;
    otel_cache_read: number;
    otel_cache_creation: number;
    scanner_turns: number;
    scanner_input: number;
    scanner_output: number;
    scanner_cache_read: number;
    scanner_cache_creation: number;
    scanner_reasoning: number;
    coverage: "both" | "hooks_only" | "scanner_only";
  }>;

  const sessions: SessionComparison[] = rows.map((r) => ({
    sessionId: r.session_id,
    source: r.source,
    hookEvents: r.hook_events,
    hookTarget: r.hook_target,
    otelInput: r.otel_input,
    otelOutput: r.otel_output,
    otelCacheRead: r.otel_cache_read,
    otelCacheCreation: r.otel_cache_creation,
    scannerTurns: r.scanner_turns,
    scannerInput: r.scanner_input,
    scannerOutput: r.scanner_output,
    scannerCacheRead: r.scanner_cache_read,
    scannerCacheCreation: r.scanner_cache_creation,
    scannerReasoning: r.scanner_reasoning,
    coverage: r.coverage,
  }));

  const both = sessions.filter((s) => s.coverage === "both");
  const sum = (
    arr: SessionComparison[],
    fn: (s: SessionComparison) => number,
  ) => arr.reduce((a, s) => a + fn(s), 0);

  return {
    sessions,
    summary: {
      total: sessions.length,
      both: both.length,
      hooksOnly: sessions.filter((s) => s.coverage === "hooks_only").length,
      scannerOnly: sessions.filter((s) => s.coverage === "scanner_only").length,
      // Only aggregate overlapping sessions for a fair comparison
      otel: {
        input: sum(both, (s) => s.otelInput),
        output: sum(both, (s) => s.otelOutput),
        cacheRead: sum(both, (s) => s.otelCacheRead),
        cacheCreation: sum(both, (s) => s.otelCacheCreation),
      },
      scanner: {
        input: sum(both, (s) => s.scannerInput),
        output: sum(both, (s) => s.scannerOutput),
        cacheRead: sum(both, (s) => s.scannerCacheRead),
        cacheCreation: sum(both, (s) => s.scannerCacheCreation),
        reasoning: sum(both, (s) => s.scannerReasoning),
      },
    },
  };
}

function num(n: number): string {
  return n.toLocaleString();
}

function delta(otel: number, scanner: number): string {
  if (scanner === 0 && otel === 0) return "-";
  const d = otel - scanner;
  const pct =
    scanner > 0 ? Math.round((d / scanner) * 100) : otel > 0 ? Infinity : 0;
  const sign = d >= 0 ? "+" : "";
  return `${sign}${num(d)} (${sign}${pct}%)`;
}

export function formatReconcileReport(report: ReconcileReport): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push("=== Session Coverage ===");
  lines.push(`  Total sessions:  ${summary.total}`);
  lines.push(`  Both sources:    ${summary.both}`);
  lines.push(`  Hooks/OTLP only: ${summary.hooksOnly}`);
  lines.push(`  Scanner only:    ${summary.scannerOnly}`);
  lines.push("");

  lines.push(`=== Token Comparison (${summary.both} overlapping sessions) ===`);
  lines.push(
    `  ${"".padEnd(18)}${"OTLP".padStart(14)}${"Scanner".padStart(14)}${"Delta".padStart(20)}`,
  );
  lines.push(`  ${"-".repeat(64)}`);
  lines.push(
    `  ${"Input".padEnd(18)}${num(summary.otel.input).padStart(14)}${num(summary.scanner.input).padStart(14)}${delta(summary.otel.input, summary.scanner.input).padStart(20)}`,
  );
  lines.push(
    `  ${"Output".padEnd(18)}${num(summary.otel.output).padStart(14)}${num(summary.scanner.output).padStart(14)}${delta(summary.otel.output, summary.scanner.output).padStart(20)}`,
  );
  lines.push(
    `  ${"Cache Read".padEnd(18)}${num(summary.otel.cacheRead).padStart(14)}${num(summary.scanner.cacheRead).padStart(14)}${delta(summary.otel.cacheRead, summary.scanner.cacheRead).padStart(20)}`,
  );
  lines.push(
    `  ${"Cache Creation".padEnd(18)}${num(summary.otel.cacheCreation).padStart(14)}${num(summary.scanner.cacheCreation).padStart(14)}${delta(summary.otel.cacheCreation, summary.scanner.cacheCreation).padStart(20)}`,
  );
  lines.push(
    `  ${"Reasoning".padEnd(18)}${"n/a".padStart(14)}${num(summary.scanner.reasoning).padStart(14)}${"(scanner only)".padStart(20)}`,
  );
  lines.push("");

  // Per-session breakdown for sessions in both sources
  const both = report.sessions.filter((s) => s.coverage === "both");
  if (both.length > 0) {
    lines.push("=== Per-Session Comparison (both sources) ===");
    for (const s of both) {
      lines.push(
        `  ${s.sessionId.slice(0, 8)}  [${s.source}]  hooks=${s.hookEvents}  turns=${s.scannerTurns}`,
      );
      lines.push(
        `    input:  otel=${num(s.otelInput)}  scanner=${num(s.scannerInput)}  ${delta(s.otelInput, s.scannerInput)}`,
      );
      lines.push(
        `    output: otel=${num(s.otelOutput)}  scanner=${num(s.scannerOutput)}  ${delta(s.otelOutput, s.scannerOutput)}`,
      );
      lines.push(
        `    cache:  otel=${num(s.otelCacheRead)}  scanner=${num(s.scannerCacheRead)}  ${delta(s.otelCacheRead, s.scannerCacheRead)}`,
      );
      if (s.scannerReasoning > 0) {
        lines.push(`    reasoning: ${num(s.scannerReasoning)} (scanner only)`);
      }
    }
    lines.push("");
  }

  // Coverage summary for non-overlapping sessions
  const hooksOnly = report.sessions.filter((s) => s.coverage === "hooks_only");
  const scanOnly = report.sessions.filter((s) => s.coverage === "scanner_only");
  if (hooksOnly.length > 0 || scanOnly.length > 0) {
    lines.push("=== Non-overlapping Sessions ===");
    if (hooksOnly.length > 0)
      lines.push(`  Hooks/OTLP only: ${hooksOnly.length} sessions`);
    if (scanOnly.length > 0)
      lines.push(`  Scanner only:    ${scanOnly.length} sessions`);
  }

  return lines.join("\n");
}
