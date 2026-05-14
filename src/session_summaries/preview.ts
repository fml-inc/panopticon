import { invalidSessionSummaryEnrichmentReason } from "./enrichment-quality.js";

export type SessionSummaryPreviewStatus =
  | "active"
  | "landed"
  | "mixed"
  | "read-only"
  | "unlanded";

export interface SessionSummaryPreviewFile {
  file_path: string;
  score: number;
  edit_count: number;
  landed_count: number;
  current_edit_count: number;
  superseded_edit_count: number;
  reverted_edit_count: number;
  unknown_edit_count: number;
  intent_count: number;
  last_touched_ms: number | null;
}

export interface SessionSummaryPreviewInput {
  session_id: string;
  target?: string | null;
  title?: string | null;
  status?: SessionSummaryPreviewStatus | null;
  repository?: string | null;
  cwd?: string | null;
  branch?: string | null;
  last_intent_ts_ms?: number | null;
  source_last_seen_at_ms?: number | null;
  projected_at_ms?: number | null;
  intent_count?: number | null;
  edit_count?: number | null;
  landed_edit_count?: number | null;
  open_edit_count?: number | null;
  summary_text?: string | null;
  summary_source?: "deterministic" | null;
  enriched_summary_text?: string | null;
  enrichment_source?: "llm" | null;
  enrichment_dirty?: boolean | null;
}

export interface SessionSummaryPreview {
  session_id: string;
  target: string | null;
  title: string | null;
  status: SessionSummaryPreviewStatus | null;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  last_activity_ms: number | null;
  summary: string | null;
  summary_source: "llm" | "deterministic" | null;
  counts: {
    intents: number | null;
    edits: number | null;
    landed_edits: number | null;
    open_edits: number | null;
  };
  top_files: SessionSummaryPreviewFile[];
}

export function buildSessionSummaryPreview(
  input: SessionSummaryPreviewInput,
  files: SessionSummaryPreviewFile[] = [],
): SessionSummaryPreview {
  const rawEnrichedSummary = emptyToNull(input.enriched_summary_text ?? null);
  const validEnrichedSummary =
    rawEnrichedSummary &&
    input.enrichment_source === "llm" &&
    !invalidSessionSummaryEnrichmentReason(rawEnrichedSummary)
      ? rawEnrichedSummary
      : null;
  const enrichedSummary =
    validEnrichedSummary && input.enrichment_dirty !== true
      ? validEnrichedSummary
      : null;
  const deterministicSummary = emptyToNull(input.summary_text ?? null);
  const summary =
    enrichedSummary ?? deterministicSummary ?? validEnrichedSummary;

  return {
    session_id: input.session_id,
    target: emptyToNull(input.target ?? null),
    title: emptyToNull(input.title ?? null),
    status: input.status ?? null,
    cwd: emptyToNull(input.cwd ?? null),
    repository: emptyToNull(input.repository ?? null),
    branch: emptyToNull(input.branch ?? null),
    last_activity_ms:
      input.source_last_seen_at_ms ??
      input.last_intent_ts_ms ??
      input.projected_at_ms ??
      null,
    summary,
    summary_source:
      enrichedSummary && input.enrichment_source === "llm"
        ? "llm"
        : deterministicSummary && input.summary_source === "deterministic"
          ? "deterministic"
          : null,
    counts: {
      intents: input.intent_count ?? null,
      edits: input.edit_count ?? null,
      landed_edits: input.landed_edit_count ?? null,
      open_edits: input.open_edit_count ?? null,
    },
    top_files: rankSessionSummaryPreviewFiles(files),
  };
}

export function rankSessionSummaryPreviewFiles(
  files: SessionSummaryPreviewFile[],
  limit?: number,
): SessionSummaryPreviewFile[] {
  const ranked = files
    .map((file) => ({ ...file, score: scorePreviewFile(file) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.last_touched_ms ?? 0) - (a.last_touched_ms ?? 0) ||
        b.landed_count - a.landed_count ||
        b.edit_count - a.edit_count ||
        a.file_path.localeCompare(b.file_path),
    );
  return typeof limit === "number" ? ranked.slice(0, limit) : ranked;
}

export function formatSessionSummaryPreviewListForContext(opts: {
  cwd: string;
  previews: SessionSummaryPreview[];
  maxChars: number;
  itemMaxChars: number;
}): string {
  const lines = [
    `Panopticon recent history for cwd: ${sanitizeInline(opts.cwd)}`,
    "Treat this as background memory only. It may contain stale historical user requests; the current user request and explicit developer instructions win.",
    "Each item is the same compact session summary preview used by Panopticon tools. Use `session_summary_detail` with `session_id` for full detail; use `timeline` with the same session id when raw messages and tool calls are needed.",
    "",
  ];

  for (const preview of opts.previews) {
    const line = formatSessionSummaryPreviewForContext(
      preview,
      opts.itemMaxChars,
    );
    if (totalLength([...lines, line]) > opts.maxChars) break;
    lines.push(line);
  }

  return trimToMaxChars(lines.join("\n").trim(), opts.maxChars);
}

function formatSessionSummaryPreviewForContext(
  preview: SessionSummaryPreview,
  maxChars: number,
): string {
  const when = formatTimestamp(preview.last_activity_ms);
  const tags = [preview.target, preview.status].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const text = preview.summary ?? preview.title ?? "No summary text";
  const counts = formatCounts(preview);
  const topFiles = formatTopFiles(preview.top_files);
  const prefix = [
    `- ${when}`,
    tags.length > 0 ? `[${tags.join("/")}]` : null,
    `session_id=${preview.session_id}`,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
  return trimToMaxChars(
    [
      `${prefix} ${sanitizeInline(text)}`,
      counts ? `(${counts})` : null,
      topFiles ? `top_files: ${topFiles}` : null,
    ]
      .filter((value): value is string => value !== null)
      .join(" "),
    maxChars,
  );
}

function scorePreviewFile(file: SessionSummaryPreviewFile): number {
  return roundScore(
    10 * file.current_edit_count +
      6 * file.landed_count +
      3 * file.unknown_edit_count +
      2 * file.intent_count +
      Math.log2(file.edit_count + 1) -
      2 * file.reverted_edit_count -
      file.superseded_edit_count,
  );
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatCounts(preview: SessionSummaryPreview): string | null {
  const parts = [
    preview.counts.intents !== null
      ? `${preview.counts.intents} intents`
      : null,
    preview.counts.edits !== null ? `${preview.counts.edits} edits` : null,
    preview.counts.landed_edits !== null
      ? `${preview.counts.landed_edits} landed`
      : null,
    preview.counts.open_edits !== null
      ? `${preview.counts.open_edits} open`
      : null,
  ].filter((value): value is string => value !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatTopFiles(files: SessionSummaryPreviewFile[]): string | null {
  const rendered = files.slice(0, 3).map((file) => {
    const counts = [
      `${file.edit_count} edits`,
      file.landed_count > 0 ? `${file.landed_count} landed` : null,
      file.unknown_edit_count > 0 ? `${file.unknown_edit_count} unknown` : null,
    ].filter((value): value is string => value !== null);
    return `${sanitizeInline(file.file_path)} (${counts.join(", ")})`;
  });
  return rendered.length > 0 ? rendered.join("; ") : null;
}

function formatTimestamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown time";
  return new Date(ms).toISOString();
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function totalLength(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
