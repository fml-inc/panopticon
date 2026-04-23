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
  summary_search_text: string | null;
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
    | "summary_input_hash"
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
  nowMs: number,
): string[] {
  const reasons: string[] = [];
  if (!existing) reasons.push("missing");
  const inputChanged =
    !existing || existing.summary_input_hash !== nextDocs.summaryInputHash;
  const versionChanged =
    !existing ||
    existing.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION;
  const baselineCurrent =
    !!existing &&
    existing.enriched_input_hash === nextDocs.summaryInputHash &&
    existing.summary_version === SESSION_SUMMARY_ENRICHMENT_VERSION;
  const pendingSinceMs = baselineCurrent
    ? null
    : (existing?.last_material_change_at_ms ?? nowMs);
  const messageDelta = Math.max(
    0,
    input.messageCount - (existing?.enriched_message_count ?? 0),
  );
  const pendingAgeMs = pendingSinceMs === null ? 0 : nowMs - pendingSinceMs;
  const lastActivityAgeMs =
    input.lastActivityMs === null
      ? Number.POSITIVE_INFINITY
      : nowMs - input.lastActivityMs;

  if (
    existing &&
    existing.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION
  ) {
    reasons.push("summary_version_changed");
  }
  if (existing && existing.summary_input_hash !== nextDocs.summaryInputHash) {
    reasons.push("summary_input_changed");
  }
  if (existing && !existing.summary_text) reasons.push("missing_summary_text");
  if (!baselineCurrent) {
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
  if (inputChanged || versionChanged) {
    reasons.push("refresh_pending");
  }
  return reasons;
}

export function mergeSessionSummaryEnrichment(
  existing: SessionSummaryEnrichmentRow | null,
  input: SessionSummaryDeterministicInput,
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
  const inputChanged =
    !existing || existing.summary_input_hash !== docs.summaryInputHash;
  const missingSummaryText = !existing?.summary_text;
  const baselineCurrent =
    !!existing &&
    existing.enriched_input_hash === docs.summaryInputHash &&
    existing.summary_version === SESSION_SUMMARY_ENRICHMENT_VERSION;
  const pendingSinceMs = baselineCurrent
    ? null
    : (existing?.last_material_change_at_ms ?? nowMs);
  const messageDelta = Math.max(
    0,
    input.messageCount - (existing?.enriched_message_count ?? 0),
  );
  const pendingAgeMs = pendingSinceMs === null ? 0 : nowMs - pendingSinceMs;
  const lastActivityAgeMs =
    input.lastActivityMs === null
      ? Number.POSITIVE_INFINITY
      : nowMs - input.lastActivityMs;
  const shouldRefreshNow =
    !baselineCurrent &&
    (lastActivityAgeMs > COLD_WINDOW_MS ||
      messageDelta >= MESSAGE_THRESHOLD ||
      pendingAgeMs >= PENDING_AGE_THRESHOLD_MS);
  const reasons = summaryDirtyReasons(existing, docs, input, nowMs);
  const dirtyReasonJson =
    reasons.length > 0 ? JSON.stringify({ reasons }) : null;

  if (!existing || inputChanged || missingSummaryText) {
    return {
      session_summary_key: input.sessionSummaryKey,
      session_id: input.sessionId,
      summary_text: docs.summaryText,
      summary_search_text: docs.summarySearchText,
      summary_source: "deterministic",
      summary_runner: null,
      summary_model: null,
      summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
      summary_generated_at_ms: nowMs,
      projection_hash: docs.projectionHash,
      summary_input_hash: docs.summaryInputHash,
      summary_policy_hash: existing?.summary_policy_hash ?? null,
      enriched_input_hash: existing?.enriched_input_hash ?? null,
      enriched_message_count: existing?.enriched_message_count ?? null,
      dirty: shouldRefreshNow ? 1 : 0,
      dirty_reason_json: dirtyReasonJson,
      last_material_change_at_ms: pendingSinceMs,
      last_attempted_at_ms: existing?.last_attempted_at_ms ?? null,
      failure_count: existing?.failure_count ?? 0,
      last_error: existing?.last_error ?? null,
    };
  }

  return {
    session_summary_key: input.sessionSummaryKey,
    session_id: input.sessionId,
    summary_text: existing.summary_text,
    summary_search_text: docs.summarySearchText,
    summary_source: existing.summary_source ?? "deterministic",
    summary_runner: existing.summary_runner,
    summary_model: existing.summary_model,
    summary_version: existing.summary_version,
    summary_generated_at_ms: existing.summary_generated_at_ms ?? nowMs,
    projection_hash: docs.projectionHash,
    summary_input_hash: docs.summaryInputHash,
    summary_policy_hash: existing.summary_policy_hash,
    enriched_input_hash: existing.enriched_input_hash,
    enriched_message_count: existing.enriched_message_count,
    dirty: shouldRefreshNow ? 1 : 0,
    dirty_reason_json: dirtyReasonJson,
    last_material_change_at_ms: pendingSinceMs,
    last_attempted_at_ms: existing.last_attempted_at_ms,
    failure_count: existing.failure_count,
    last_error: existing.last_error,
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
