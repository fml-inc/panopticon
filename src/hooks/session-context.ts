import { formatSessionSummaryPreviewListForContext } from "../session_summaries/preview.js";
import { listRecentSessionSummaryPreviewsForCwd } from "../session_summaries/query.js";

const RECENT_HISTORY_LIMIT = 5;
const RECENT_HISTORY_MAX_CHARS = 2_800;
const RECENT_HISTORY_ITEM_MAX_CHARS = 520;

interface SessionStartContextInput {
  session_id?: unknown;
  cwd?: unknown;
  shell_pwd?: unknown;
}

export function buildSessionStartRecentHistoryContext(
  data: SessionStartContextInput,
): string | null {
  const cwdCandidates = extractCwdCandidates(data);
  if (cwdCandidates.length === 0) return null;

  const previews = listRecentSessionSummaryPreviewsForCwd({
    cwdCandidates,
    currentSessionId:
      typeof data.session_id === "string" ? data.session_id : null,
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

function extractCwdCandidates(data: SessionStartContextInput): string[] {
  const primary = typeof data.cwd === "string" && data.cwd.length > 0;
  const candidates = [data.cwd, primary ? null : data.shell_pwd].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return [...new Set(candidates)];
}
