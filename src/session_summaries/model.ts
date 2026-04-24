import { createHash } from "node:crypto";

export const SESSION_SUMMARY_ENRICHMENT_VERSION = 1;

const HOT_WINDOW_MS = 30 * 60 * 1000;
const COLD_WINDOW_MS = 6 * 60 * 60 * 1000;
const MESSAGE_THRESHOLD = 20;
const PENDING_AGE_THRESHOLD_MS = 30 * 60 * 1000;

export interface SessionSummaryDeterministicInput {
  sessionSummaryKey: string;
  sessionId: string;
  title: string;
  status: "active" | "landed" | "mixed" | "abandoned";
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  intentCount: number;
  editCount: number;
  landedEditCount: number;
  openEditCount: number;
  messageCount: number;
  lastActivityMs: number | null;
  intents: string[];
  files: Array<{
    filePath: string;
    editCount: number;
    landedCount: number;
  }>;
  tools: string[];
}

export interface SessionSummaryDeterministicDocs {
  summaryText: string;
  summarySearchText: string;
  projectionHash: string;
  summaryInputHash: string;
}

export interface SessionSummaryEnrichmentRow {
  session_summary_key: string;
  session_id: string;
  summary_text: string | null;
  summary_source: string | null;
  summary_runner: string | null;
  summary_model: string | null;
  summary_version: number;
  summary_generated_at_ms: number | null;
  projection_hash: string | null;
  summary_input_hash: string | null;
  summary_policy_hash: string | null;
  enriched_input_hash: string | null;
  enriched_message_count: number | null;
  dirty: number;
  dirty_reason_json: string | null;
  last_material_change_at_ms: number | null;
  last_attempted_at_ms: number | null;
  failure_count: number;
  last_error: string | null;
}

export function shouldRefreshSessionSummaryNow(
  existing: Pick<
    SessionSummaryEnrichmentRow,
    "enriched_message_count" | "last_material_change_at_ms"
  > | null,
  input: Pick<
    SessionSummaryDeterministicInput,
    "messageCount" | "lastActivityMs"
  >,
  nowMs: number,
): boolean {
  const messageDelta = Math.max(
    0,
    input.messageCount - (existing?.enriched_message_count ?? 0),
  );
  const pendingSinceMs = existing?.last_material_change_at_ms ?? nowMs;
  const pendingAgeMs = nowMs - pendingSinceMs;
  const lastActivityAgeMs =
    input.lastActivityMs === null
      ? Number.POSITIVE_INFINITY
      : nowMs - input.lastActivityMs;

  return (
    lastActivityAgeMs > COLD_WINDOW_MS ||
    messageDelta >= MESSAGE_THRESHOLD ||
    pendingAgeMs >= PENDING_AGE_THRESHOLD_MS
  );
}

export function buildDeterministicSessionSummaryDocs(
  input: SessionSummaryDeterministicInput,
): SessionSummaryDeterministicDocs {
  const topFiles = input.files
    .slice()
    .sort(
      (a, b) =>
        b.editCount - a.editCount || a.filePath.localeCompare(b.filePath),
    )
    .slice(0, 5);
  const prompts = normalizeItems(input.intents, 4);
  const tools = normalizeItems(input.tools, 6);

  const summaryTextParts = [
    input.title,
    `Status: ${input.status}`,
    `${input.intentCount} intents, ${input.editCount} edits, ${input.landedEditCount} landed, ${input.openEditCount} open`,
  ];
  if (topFiles.length > 0) {
    summaryTextParts.push(
      `Top files: ${topFiles.map((file) => file.filePath).join(", ")}`,
    );
  }
  const summaryText = `${summaryTextParts.join(". ")}.`;

  const searchFields = [
    `Title: ${input.title}`,
    `Status: ${input.status}`,
    input.repository ? `Repository: ${input.repository}` : null,
    input.branch ? `Branch: ${input.branch}` : null,
    input.cwd ? `Cwd: ${input.cwd}` : null,
    `Counts: intents ${input.intentCount}; edits ${input.editCount}; landed ${input.landedEditCount}; open ${input.openEditCount}`,
    topFiles.length > 0
      ? `Files: ${topFiles
          .map(
            (file) =>
              `${file.filePath} (${file.editCount} edits, ${file.landedCount} landed)`,
          )
          .join("; ")}`
      : null,
    tools.length > 0 ? `Tools: ${tools.join("; ")}` : null,
    prompts.length > 0 ? `Prompts: ${prompts.join(" | ")}` : null,
  ].filter((value): value is string => Boolean(value));

  const projectionEnvelope = {
    sessionSummaryKey: input.sessionSummaryKey,
    sessionId: input.sessionId,
    title: input.title,
    status: input.status,
    repository: input.repository,
    cwd: input.cwd,
    branch: input.branch,
    intentCount: input.intentCount,
    editCount: input.editCount,
    landedEditCount: input.landedEditCount,
    openEditCount: input.openEditCount,
    topFiles,
  };

  const summaryInputEnvelope = {
    title: input.title,
    status: input.status,
    repository: input.repository,
    branch: input.branch,
    intentCount: input.intentCount,
    editCount: input.editCount,
    landedEditCount: input.landedEditCount,
    openEditCount: input.openEditCount,
    prompts,
    topFiles,
    tools,
  };

  return {
    summaryText,
    summarySearchText: searchFields.join("\n"),
    projectionHash: hashStable(projectionEnvelope),
    summaryInputHash: hashStable(summaryInputEnvelope),
  };
}

export function summaryDirtyReasons(
  existing: Pick<
    SessionSummaryEnrichmentRow,
    | "summary_version"
    | "summary_source"
    | "summary_policy_hash"
    | "enriched_input_hash"
    | "enriched_message_count"
    | "summary_text"
    | "last_material_change_at_ms"
  > | null,
  nextDocs: Pick<SessionSummaryDeterministicDocs, "summaryInputHash">,
  input: Pick<
    SessionSummaryDeterministicInput,
    "messageCount" | "lastActivityMs"
  >,
  policyHash: string,
  nowMs: number,
): string[] {
  const reasons: string[] = [];
  if (!existing) reasons.push("missing");
  const hasEnrichedSummary =
    existing?.summary_source === "llm" && !!existing.summary_text;
  const messageDelta = Math.max(
    0,
    input.messageCount - (existing?.enriched_message_count ?? 0),
  );
  const inputChanged =
    !hasEnrichedSummary ||
    existing?.enriched_input_hash !== nextDocs.summaryInputHash;
  const policyChanged =
    !hasEnrichedSummary || existing?.summary_policy_hash !== policyHash;
  const versionChanged =
    !hasEnrichedSummary ||
    existing?.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION;
  const stale =
    inputChanged || policyChanged || versionChanged || messageDelta > 0;
  const pendingSinceMs = stale
    ? (existing?.last_material_change_at_ms ?? nowMs)
    : null;
  const pendingAgeMs = pendingSinceMs === null ? 0 : nowMs - pendingSinceMs;
  const lastActivityAgeMs =
    input.lastActivityMs === null
      ? Number.POSITIVE_INFINITY
      : nowMs - input.lastActivityMs;

  if (existing && !hasEnrichedSummary) {
    reasons.push("missing_enriched_summary");
  }
  if (
    hasEnrichedSummary &&
    existing.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION
  ) {
    reasons.push("summary_version_changed");
  }
  if (
    hasEnrichedSummary &&
    existing.enriched_input_hash !== nextDocs.summaryInputHash
  ) {
    reasons.push("summary_input_changed");
  }
  if (hasEnrichedSummary && existing.summary_policy_hash !== policyHash) {
    reasons.push("summary_policy_changed");
  }
  if (stale) {
    if (lastActivityAgeMs > COLD_WINDOW_MS) {
      reasons.push("session_cold");
    } else if (messageDelta >= MESSAGE_THRESHOLD) {
      reasons.push("message_threshold_reached");
    } else if (pendingAgeMs >= PENDING_AGE_THRESHOLD_MS) {
      reasons.push("pending_age_threshold_reached");
    } else if (lastActivityAgeMs <= HOT_WINDOW_MS) {
      reasons.push("session_hot");
    } else {
      reasons.push("session_warm");
    }
  }
  if (stale) {
    reasons.push("refresh_pending");
  }
  return reasons;
}

export function mergeSessionSummaryEnrichment(
  existing: SessionSummaryEnrichmentRow | null,
  input: SessionSummaryDeterministicInput,
  policyHash: string,
  nowMs: number,
): Omit<
  SessionSummaryEnrichmentRow,
  "last_attempted_at_ms" | "failure_count" | "last_error"
> & {
  last_attempted_at_ms: number | null;
  failure_count: number;
  last_error: string | null;
} {
  const docs = buildDeterministicSessionSummaryDocs(input);
  const hasEnrichedSummary =
    existing?.summary_source === "llm" && !!existing.summary_text;
  const messageDelta = Math.max(
    0,
    input.messageCount - (existing?.enriched_message_count ?? 0),
  );
  const inputChanged =
    !hasEnrichedSummary ||
    existing?.enriched_input_hash !== docs.summaryInputHash;
  const policyChanged =
    !hasEnrichedSummary || existing?.summary_policy_hash !== policyHash;
  const versionChanged =
    !hasEnrichedSummary ||
    existing?.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION;
  const stale =
    inputChanged || policyChanged || versionChanged || messageDelta > 0;
  const materialChange = inputChanged || policyChanged || versionChanged;
  const pendingSinceMs = stale
    ? (existing?.last_material_change_at_ms ?? nowMs)
    : null;
  const reasons = summaryDirtyReasons(existing, docs, input, policyHash, nowMs);
  const dirtyReasonJson =
    reasons.length > 0 ? JSON.stringify({ reasons }) : null;

  return {
    session_summary_key: input.sessionSummaryKey,
    session_id: input.sessionId,
    summary_text: hasEnrichedSummary ? existing.summary_text : null,
    summary_source: hasEnrichedSummary ? "llm" : "deterministic",
    summary_runner: hasEnrichedSummary ? existing.summary_runner : null,
    summary_model: hasEnrichedSummary ? existing.summary_model : null,
    summary_version: hasEnrichedSummary
      ? existing.summary_version
      : SESSION_SUMMARY_ENRICHMENT_VERSION,
    summary_generated_at_ms: hasEnrichedSummary
      ? (existing.summary_generated_at_ms ?? nowMs)
      : null,
    projection_hash: docs.projectionHash,
    summary_input_hash: docs.summaryInputHash,
    summary_policy_hash: hasEnrichedSummary
      ? existing.summary_policy_hash
      : null,
    enriched_input_hash: hasEnrichedSummary
      ? existing.enriched_input_hash
      : null,
    enriched_message_count: hasEnrichedSummary
      ? existing.enriched_message_count
      : null,
    dirty: stale ? 1 : 0,
    dirty_reason_json: dirtyReasonJson,
    last_material_change_at_ms: pendingSinceMs,
    last_attempted_at_ms: materialChange
      ? null
      : (existing?.last_attempted_at_ms ?? null),
    failure_count: materialChange ? 0 : (existing?.failure_count ?? 0),
    last_error: materialChange ? null : (existing?.last_error ?? null),
  };
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeItems(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    normalized.push(compact);
    if (normalized.length >= limit) break;
  }
  return normalized;
}
