import { createHash } from "node:crypto";
import path from "node:path";
import {
  SESSION_SUMMARY_PROJECTION_COMPONENT,
  targetDataVersion,
} from "../db/data-versions.js";
import {
  SESSION_SUMMARY_SEARCH_CORPUS,
  SESSION_SUMMARY_SEARCH_PRIORITY,
} from "./search-index.js";

export const SESSION_SUMMARY_ENRICHMENT_VERSION = 1;
const SESSION_SUMMARY_PROJECTION_DATA_VERSION = targetDataVersion(
  SESSION_SUMMARY_PROJECTION_COMPONENT,
);

const HOT_WINDOW_MS = 30 * 60 * 1000;
export const SESSION_SUMMARY_COLD_WINDOW_MS = 6 * 60 * 60 * 1000;
export const SESSION_SUMMARY_MESSAGE_THRESHOLD = 20;
export const SESSION_SUMMARY_PENDING_AGE_THRESHOLD_MS = 30 * 60 * 1000;
const DISPLAY_PATH_SEGMENTS = 4;

export interface SessionSummaryDeterministicInput {
  sessionSummaryKey: string;
  sessionId: string;
  title: string;
  status: "active" | "landed" | "mixed" | "read-only" | "unlanded";
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
  searchCorpusRows: SessionSummarySearchCorpusRow[];
  projectionHash: string;
  summaryInputHash: string;
}

export interface SessionSummarySearchCorpusRow {
  corpusKey: string;
  source: "deterministic";
  priority: number;
  searchText: string;
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
    lastActivityAgeMs > SESSION_SUMMARY_COLD_WINDOW_MS ||
    messageDelta >= SESSION_SUMMARY_MESSAGE_THRESHOLD ||
    pendingAgeMs >= SESSION_SUMMARY_PENDING_AGE_THRESHOLD_MS
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
  const displayTopFiles = topFiles.map((file) => ({
    ...file,
    displayPath: displayFilePath(file.filePath, input.repository, input.cwd),
  }));
  const prompts = normalizeItems(input.intents, 4);
  const tools = normalizeItems(input.tools, 6);
  const repositoryLabel = displayRepositoryLabel(input.repository);

  const statusLabel = `${input.status[0]?.toUpperCase() ?? ""}${input.status.slice(1)}`;
  const summaryTextParts = [
    input.title,
    `${statusLabel}: ${input.intentCount} ${pluralize("intent", input.intentCount)}, ${summarizeEditOutcome(input)}`,
  ];
  if (displayTopFiles.length > 0) {
    summaryTextParts.push(
      `Top files: ${displayTopFiles.map((file) => file.displayPath).join(", ")}`,
    );
  }
  const summaryText = `${summaryTextParts.join(". ")}.`;

  const searchFields = [
    `Title: ${input.title}`,
    `Status: ${input.status}`,
    repositoryLabel ? `Repository: ${repositoryLabel}` : null,
    input.branch ? `Branch: ${input.branch}` : null,
    `Counts: intents ${input.intentCount}; edits ${input.editCount}; landed ${input.landedEditCount}; open ${input.openEditCount}`,
    displayTopFiles.length > 0
      ? `Files: ${displayTopFiles
          .map(
            (file) =>
              `${file.displayPath} (${file.editCount} edits, ${file.landedCount} landed)`,
          )
          .join("; ")}`
      : null,
    tools.length > 0 ? `Tools: ${tools.join("; ")}` : null,
    prompts.length > 0 ? `Prompts: ${prompts.join(" | ")}` : null,
  ].filter((value): value is string => Boolean(value));

  const deterministicSearchText = searchFields.join("\n");
  const searchCorpusRows: SessionSummarySearchCorpusRow[] = [
    {
      corpusKey: SESSION_SUMMARY_SEARCH_CORPUS.deterministicSummary,
      source: "deterministic",
      priority: SESSION_SUMMARY_SEARCH_PRIORITY.deterministicSummary,
      searchText: summaryText,
    },
    {
      corpusKey: SESSION_SUMMARY_SEARCH_CORPUS.deterministicSearch,
      source: "deterministic",
      priority: SESSION_SUMMARY_SEARCH_PRIORITY.deterministicSearch,
      searchText: deterministicSearchText,
    },
  ];

  const projectionEnvelope = {
    projectionVersion: SESSION_SUMMARY_PROJECTION_DATA_VERSION,
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
    summaryText,
    searchCorpusRows,
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
    searchCorpusRows,
  };

  return {
    summaryText,
    searchCorpusRows,
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
    ? materialChangeTimestamp(existing, input, hasEnrichedSummary, nowMs)
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
    if (lastActivityAgeMs > SESSION_SUMMARY_COLD_WINDOW_MS) {
      reasons.push("session_cold");
    } else if (messageDelta >= SESSION_SUMMARY_MESSAGE_THRESHOLD) {
      reasons.push("message_threshold_reached");
    } else if (pendingAgeMs >= SESSION_SUMMARY_PENDING_AGE_THRESHOLD_MS) {
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
    ? materialChangeTimestamp(existing, input, hasEnrichedSummary, nowMs)
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

export function shouldResetSessionSummaryRetryState(
  existing: Pick<
    SessionSummaryEnrichmentRow,
    | "summary_source"
    | "summary_text"
    | "summary_input_hash"
    | "summary_policy_hash"
    | "enriched_input_hash"
    | "summary_version"
  > | null,
  nextDocs: Pick<SessionSummaryDeterministicDocs, "summaryInputHash">,
  policyHash: string,
): boolean {
  if (!existing) return false;
  const hasEnrichedSummary =
    existing.summary_source === "llm" && !!existing.summary_text;
  if (!hasEnrichedSummary) {
    return existing.summary_input_hash !== nextDocs.summaryInputHash;
  }
  return (
    existing.enriched_input_hash !== nextDocs.summaryInputHash ||
    existing.summary_policy_hash !== policyHash ||
    existing.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION
  );
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function summarizeEditOutcome(
  input: Pick<
    SessionSummaryDeterministicInput,
    "editCount" | "landedEditCount" | "openEditCount"
  >,
): string {
  if (input.editCount === 0) return "no edits recorded";
  if (input.openEditCount > 0) {
    return `${input.landedEditCount}/${input.editCount} edits landed, ${input.openEditCount} open`;
  }
  if (input.landedEditCount === input.editCount) {
    return `all ${input.editCount} ${pluralize("edit", input.editCount)} landed`;
  }
  if (input.landedEditCount === 0) {
    return `${input.editCount} ${pluralize("edit", input.editCount)} recorded, none landed`;
  }
  return `${input.landedEditCount}/${input.editCount} edits landed`;
}

function materialChangeTimestamp(
  existing: Pick<
    SessionSummaryEnrichmentRow,
    "last_material_change_at_ms"
  > | null,
  input: Pick<SessionSummaryDeterministicInput, "lastActivityMs">,
  hasEnrichedSummary: boolean,
  nowMs: number,
): number {
  if (!hasEnrichedSummary) {
    return (
      input.lastActivityMs ?? existing?.last_material_change_at_ms ?? nowMs
    );
  }
  return existing?.last_material_change_at_ms ?? input.lastActivityMs ?? nowMs;
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

function displayRepositoryLabel(repository: string | null): string | null {
  if (!repository) return null;
  const normalized = normalizePathForDisplay(repository);
  return isAbsolutePathLike(repository)
    ? trailingPathSegments(normalized, 1)
    : normalized;
}

function displayFilePath(
  filePath: string,
  repository: string | null,
  cwd: string | null,
): string {
  const normalized = normalizePathForDisplay(filePath);
  if (!isAbsolutePathLike(filePath)) return normalized;

  for (const basePath of [repository, cwd]) {
    if (!basePath || !isAbsolutePathLike(basePath)) continue;
    const relativePath = normalizePathForDisplay(
      path.relative(basePath, filePath),
    );
    if (!isUsableRelativePath(relativePath)) continue;
    return trimEphemeralWorktreePrefix(relativePath);
  }

  return trailingPathSegments(normalized, DISPLAY_PATH_SEGMENTS);
}

function normalizePathForDisplay(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function trailingPathSegments(value: string, count: number): string {
  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0) return value;
  return segments.slice(-Math.min(count, segments.length)).join("/");
}

function trimEphemeralWorktreePrefix(value: string): string {
  const segments = value.split("/").filter(Boolean);
  if (segments[0] === ".worktrees" && segments.length > 2) {
    return segments.slice(2).join("/");
  }
  if (
    segments[0] === ".claude" &&
    segments[1] === "worktrees" &&
    segments.length > 3
  ) {
    return segments.slice(3).join("/");
  }
  return value;
}

function isUsableRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../") &&
    !path.isAbsolute(value)
  );
}

function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}
