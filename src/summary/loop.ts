import { getDb } from "../db/schema.js";
import { detectAgent, invokeLlm } from "./llm.js";

/** Minimum messages before a session is worth summarizing. */
const MIN_MESSAGES = 3;
/** Re-summarize when message count has grown by this much. */
const SUMMARY_THRESHOLD = 20;
/** Max sessions to summarize per idle cycle. */
const MAX_PER_CYCLE = 5;
/** Timeout for agent-based summary (longer than simple LLM call). */
const AGENT_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = `You are summarizing a coding session for search and retrieval. You have access to panopticon MCP tools to explore the session data.

Instructions:
1. Use the "timeline" tool to read the session's messages and tool calls
2. If needed, use "get" to read full message content or "query" for specific data
3. Produce a summary optimized for AI consumption and full-text search
4. Include: what was accomplished, key decisions made, specific file/function/package names, problems encountered and how they were resolved
5. Use concrete names rather than generic descriptions (e.g. "added FTS5 index on messages table" not "improved search")
6. Format as 2-4 concise sentences
7. Output ONLY the summary text, nothing else`;

/**
 * Generate a summary for a single session.
 * Uses Claude CLI with panopticon MCP if available, falls back to deterministic.
 */
function summarizeSession(
  sessionId: string,
  log: (msg: string) => void,
): string | null {
  // Try agent-based summary first
  if (detectAgent()) {
    const prompt = `Summarize session ${sessionId}. Start by calling the timeline tool with sessionId "${sessionId}" and limit 50.`;
    const result = invokeLlm(prompt, {
      timeoutMs: AGENT_TIMEOUT_MS,
      withMcp: true,
      systemPrompt: SYSTEM_PROMPT,
      model: "haiku",
    });
    if (result) return result;
    log(`LLM summary failed for ${sessionId}, falling back to deterministic`);
  }

  // Deterministic fallback
  return buildDeterministicSummary(sessionId);
}

/**
 * Build a deterministic summary from messages and tool_calls.
 */
function buildDeterministicSummary(sessionId: string): string | null {
  const db = getDb();

  const firstUser = db
    .prepare(
      "SELECT SUBSTR(content, 1, 200) as content FROM messages WHERE session_id = ? AND role = 'user' AND is_system = 0 ORDER BY ordinal ASC LIMIT 1",
    )
    .get(sessionId) as { content: string } | undefined;

  const counts = db
    .prepare(
      "SELECT COUNT(*) as msg_count, SUM(CASE WHEN role = 'user' AND is_system = 0 THEN 1 ELSE 0 END) as user_count FROM messages WHERE session_id = ?",
    )
    .get(sessionId) as { msg_count: number; user_count: number };

  const tools = db
    .prepare(
      "SELECT tool_name, COUNT(*) as cnt FROM tool_calls WHERE session_id = ? GROUP BY tool_name ORDER BY cnt DESC LIMIT 5",
    )
    .all(sessionId) as Array<{ tool_name: string; cnt: number }>;

  const files = db
    .prepare(
      "SELECT DISTINCT json_extract(input_json, '$.file_path') as fp FROM tool_calls WHERE session_id = ? AND tool_name IN ('Write', 'Edit') AND input_json IS NOT NULL LIMIT 10",
    )
    .all(sessionId) as Array<{ fp: string | null }>;

  if (!firstUser && counts.msg_count === 0) return null;

  const parts: string[] = [];
  if (firstUser) parts.push(`Prompt: "${firstUser.content}"`);
  parts.push(`${counts.msg_count} messages (${counts.user_count} user)`);
  if (tools.length > 0) {
    parts.push(
      `Tools: ${tools.map((t) => `${t.tool_name}(${t.cnt})`).join(", ")}`,
    );
  }
  const filePaths = files.map((f) => f.fp).filter(Boolean) as string[];
  if (filePaths.length > 0) {
    parts.push(`Files: ${filePaths.join(", ")}`);
  }

  return parts.join(". ");
}

/**
 * Generate summaries for sessions that need them.
 * Called when the scanner is idle.
 */
export function generateSummariesOnce(log: (msg: string) => void = () => {}): {
  updated: number;
} {
  const db = getDb();
  let updated = 0;

  // Find sessions needing summary:
  // 1. Never summarized + enough messages
  // 2. Stale by message count (grown by THRESHOLD since last summary)
  // 3. Session ended after last summary
  const sessions = db
    .prepare(
      `
    SELECT s.session_id, s.message_count, s.summary_version, s.ended_at_ms,
           EXISTS(SELECT 1 FROM session_repositories WHERE session_id = s.session_id) as has_repo
    FROM sessions s
    WHERE s.message_count >= ?
      AND (
        s.summary IS NULL
        OR (s.message_count - COALESCE(s.summary_version, 0)) >= ?
        OR (s.ended_at_ms IS NOT NULL AND s.ended_at_ms > COALESCE(
          (SELECT MAX(created_at_ms) FROM session_summary_deltas WHERE session_id = s.session_id),
          0
        ))
      )
    ORDER BY s.started_at_ms DESC
    LIMIT ?
  `,
    )
    .all(MIN_MESSAGES, SUMMARY_THRESHOLD, MAX_PER_CYCLE) as Array<{
    session_id: string;
    message_count: number;
    summary_version: number | null;
    ended_at_ms: number | null;
    has_repo: number;
  }>;

  for (const sess of sessions) {
    try {
      // Use AI summaries for sessions with repo attribution,
      // deterministic for everything else
      const summary = sess.has_repo
        ? summarizeSession(sess.session_id, log)
        : buildDeterministicSummary(sess.session_id);
      if (!summary) continue;

      db.prepare(
        "UPDATE sessions SET summary = ?, summary_version = ?, sync_dirty = 1 WHERE session_id = ?",
      ).run(summary, sess.message_count, sess.session_id);

      updated++;
      log(`Summarized ${sess.session_id} (${sess.message_count} messages)`);
    } catch (err) {
      log(
        `Summary error for ${sess.session_id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { updated };
}
