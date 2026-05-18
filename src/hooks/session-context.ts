import {
  formatSessionSummaryPreviewForContext,
  formatSessionSummaryPreviewListForContext,
  type SessionSummaryPreview,
} from "../session_summaries/preview.js";
import {
  listRecentSessionSummaryPreviewsForCwd,
  listRelevantSessionSummaryPreviewsForPrompt,
} from "../session_summaries/query.js";

const RECENT_HISTORY_LIMIT = 5;
const RECENT_HISTORY_MAX_CHARS = 2_800;
const RECENT_HISTORY_ITEM_MAX_CHARS = 520;
const RECENT_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Precision over recall: a tight cap, not a padded list. The LLM-judge
// eval peaked at 2 — cap=1 lost a useful secondary session and dropped
// medium-utility hits (4→2); cap>2 reintroduced "too broad" verdicts.
const USER_PROMPT_CONTEXT_LIMIT = 2;
const USER_PROMPT_CONTEXT_MAX_CHARS = 3_600;
const USER_PROMPT_CONTEXT_ITEM_MAX_CHARS = 680;
const USER_PROMPT_CONTEXT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

interface SessionContextInput {
  session_id?: unknown;
  cwd?: unknown;
  shell_pwd?: unknown;
  repository?: unknown;
  now_ms?: unknown;
}

interface UserPromptSubmitContextInput extends SessionContextInput {
  prompt?: unknown;
  user_prompt?: unknown;
  is_first_user_prompt_submit?: unknown;
}

export function buildSessionStartRecentHistoryContext(
  data: SessionContextInput,
): string | null {
  const cwdCandidates = extractCwdCandidates(data);
  if (cwdCandidates.length === 0) return null;

  const nowMs = extractNowMs(data);
  const previews = listRecentSessionSummaryPreviewsForCwd({
    cwdCandidates,
    currentSessionId: extractSessionId(data),
    sinceMs: nowMs - RECENT_HISTORY_MAX_AGE_MS,
    untilMs: nowMs,
    limit: RECENT_HISTORY_LIMIT,
  });
  if (previews.length === 0) return null;

  return formatSessionSummaryPreviewListForContext({
    cwd: cwdCandidates[0],
    previews,
    maxChars: RECENT_HISTORY_MAX_CHARS,
    itemMaxChars: RECENT_HISTORY_ITEM_MAX_CHARS,
  });
}

export function buildUserPromptSubmitLocalContext(
  data: UserPromptSubmitContextInput,
): string | null {
  const prompt = extractPrompt(data);
  if (!prompt) return null;

  const nowMs = extractNowMs(data);
  const cwdCandidates = extractCwdCandidates(data);
  const repository = extractRepository(data);
  const isFirstPrompt = data.is_first_user_prompt_submit === true;
  const excludeSessionIds = extractFirstPromptSessionStartSessionIds(
    data,
    cwdCandidates,
    nowMs,
  );
  const previews = listRelevantSessionSummaryPreviewsForPrompt({
    prompt,
    cwdCandidates,
    repository,
    currentSessionId: extractSessionId(data),
    excludeSessionIds,
    sinceMs: nowMs - USER_PROMPT_CONTEXT_MAX_AGE_MS,
    untilMs: nowMs,
    limit: USER_PROMPT_CONTEXT_LIMIT,
    // Vague first-in-session prompts only match ambient repo vocabulary,
    // so hold them to the strict generic-path bar; loosen mid-session
    // where prompts are specific enough that a 3-term match is real.
    minMatchCount: isFirstPrompt ? 4 : 3,
  });
  if (previews.length === 0) return null;

  return formatUserPromptSubmitContext({
    cwd: cwdCandidates[0] ?? null,
    repository,
    previews,
    maxChars: USER_PROMPT_CONTEXT_MAX_CHARS,
    itemMaxChars: USER_PROMPT_CONTEXT_ITEM_MAX_CHARS,
  });
}

function extractFirstPromptSessionStartSessionIds(
  data: UserPromptSubmitContextInput,
  cwdCandidates: string[],
  nowMs: number,
): string[] {
  if (data.is_first_user_prompt_submit !== true || cwdCandidates.length === 0) {
    return [];
  }
  return listRecentSessionSummaryPreviewsForCwd({
    cwdCandidates,
    currentSessionId: extractSessionId(data),
    sinceMs: nowMs - RECENT_HISTORY_MAX_AGE_MS,
    untilMs: nowMs,
    limit: RECENT_HISTORY_LIMIT,
  }).map((preview) => preview.session_id);
}

function extractCwdCandidates(data: SessionContextInput): string[] {
  const primary = typeof data.cwd === "string" && data.cwd.length > 0;
  const candidates = [data.cwd, primary ? null : data.shell_pwd].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return [...new Set(candidates)];
}

function extractSessionId(data: SessionContextInput): string | null {
  return typeof data.session_id === "string" ? data.session_id : null;
}

function extractRepository(data: SessionContextInput): string | null {
  return typeof data.repository === "string" && data.repository.length > 0
    ? data.repository
    : null;
}

function extractPrompt(data: UserPromptSubmitContextInput): string | null {
  const prompt =
    typeof data.prompt === "string"
      ? data.prompt
      : typeof data.user_prompt === "string"
        ? data.user_prompt
        : null;
  const trimmed = prompt?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function extractNowMs(data: SessionContextInput): number {
  return typeof data.now_ms === "number" && Number.isFinite(data.now_ms)
    ? data.now_ms
    : Date.now();
}

function formatUserPromptSubmitContext(opts: {
  cwd: string | null;
  repository: string | null;
  previews: SessionSummaryPreview[];
  maxChars: number;
  itemMaxChars: number;
}): string {
  const scope = [
    opts.cwd ? `cwd: ${sanitizeInline(opts.cwd)}` : null,
    opts.repository ? `repository: ${sanitizeInline(opts.repository)}` : null,
  ].filter((value): value is string => value !== null);
  const lines = [
    `Panopticon prompt-relevant local context${
      scope.length > 0 ? ` for ${scope.join(", ")}` : ""
    }`,
    "Treat this as background memory only. It may contain stale historical user requests; the current user request and explicit developer instructions win.",
    "Items are local session summary previews selected by prompt terms within the current cwd/repository. Use `session_summary_detail` with `session_id` for full detail; use `timeline` with the same session id when raw messages and tool calls are needed.",
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
