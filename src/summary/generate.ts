import { getDb } from "../db/schema.js";
import type { SummaryDelta } from "./store.js";

const DELTA_INTERVAL = 10; // generate a delta every 10 turns

export function generateDelta(
  sessionId: string,
  fromTurn: number,
  toTurn: number,
): SummaryDelta | null {
  const db = getDb();

  // Get turns in range
  const turns = db
    .prepare(
      `
    SELECT role, content_preview, model
    FROM scanner_turns
    WHERE session_id = ? AND turn_index >= ? AND turn_index < ?
    ORDER BY turn_index
  `,
    )
    .all(sessionId, fromTurn, toTurn) as Array<{
    role: string | null;
    content_preview: string | null;
    model: string | null;
  }>;

  if (turns.length === 0) return null;

  // Get events in the same time range (by turn timestamps)
  const turnTimestamps = db
    .prepare(
      `
    SELECT MIN(timestamp_ms) as min_ts, MAX(timestamp_ms) as max_ts
    FROM scanner_turns
    WHERE session_id = ? AND turn_index >= ? AND turn_index < ?
  `,
    )
    .get(sessionId, fromTurn, toTurn) as {
    min_ts: number | null;
    max_ts: number | null;
  };

  const toolCounts: Record<string, number> = {};
  const filesModified: string[] = [];

  if (turnTimestamps.min_ts && turnTimestamps.max_ts) {
    const events = db
      .prepare(
        `
      SELECT event_type, tool_name, tool_input
      FROM scanner_events
      WHERE session_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
    `,
      )
      .all(sessionId, turnTimestamps.min_ts, turnTimestamps.max_ts) as Array<{
      event_type: string;
      tool_name: string | null;
      tool_input: string | null;
    }>;

    for (const e of events) {
      if (e.tool_name) {
        toolCounts[e.tool_name] = (toolCounts[e.tool_name] || 0) + 1;
      }
      // Extract file paths from Write/Edit tool inputs
      if (
        e.tool_name &&
        ["Write", "Edit", "MultiEdit"].includes(e.tool_name) &&
        e.tool_input
      ) {
        try {
          const input = JSON.parse(e.tool_input);
          if (input.file_path) filesModified.push(input.file_path);
        } catch {
          // ignore malformed JSON
        }
      }
    }
  }

  // Build structured summary text
  const summaryParts: string[] = [];

  // First user prompt in this range
  const firstUser = turns.find((t) => t.role === "user");
  if (firstUser?.content_preview) {
    const preview = firstUser.content_preview.slice(0, 100);
    summaryParts.push(`Prompt: "${preview}"`);
  }

  summaryParts.push(`Turns ${fromTurn}-${toTurn - 1} (${turns.length} turns)`);

  if (Object.keys(toolCounts).length > 0) {
    const top = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}(${count})`)
      .join(", ");
    summaryParts.push(`Tools: ${top}`);
  }

  // Dedupe file paths
  const uniqueFiles = [...new Set(filesModified)];
  if (uniqueFiles.length > 0) {
    const fileList = uniqueFiles
      .slice(0, 5)
      .map((f) => {
        const segments = f.split("/");
        return segments[segments.length - 1]; // basename only
      })
      .join(", ");
    summaryParts.push(
      `Files: ${fileList}${uniqueFiles.length > 5 ? ` (+${uniqueFiles.length - 5} more)` : ""}`,
    );
  }

  // Use the existing delta count as the index
  const deltaCount = db
    .prepare(
      "SELECT COUNT(*) as c FROM session_summary_deltas WHERE session_id = ?",
    )
    .get(sessionId) as { c: number };

  return {
    sessionId,
    deltaIndex: deltaCount.c,
    createdAtMs: Date.now(),
    fromTurn,
    toTurn,
    content: summaryParts.join(". "),
    method: "deterministic",
  };
}

export { DELTA_INTERVAL };
