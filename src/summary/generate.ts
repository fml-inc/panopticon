import { getDb } from "../db/schema.js";
import { invokeLlm } from "./llm.js";
import type { SummaryDelta } from "./store.js";

const DELTA_INTERVAL = 10; // generate a delta every 10 turns

interface TurnRow {
  role: string | null;
  content_preview: string | null;
  model: string | null;
}

interface EventRow {
  event_type: string;
  tool_name: string | null;
  tool_input: string | null;
}

function gatherTurnsAndEvents(
  sessionId: string,
  fromTurn: number,
  toTurn: number,
): {
  turns: TurnRow[];
  toolCounts: Record<string, number>;
  filesModified: string[];
  events: EventRow[];
} {
  const db = getDb();

  const turns = db
    .prepare(
      `SELECT role, content_preview, model
       FROM scanner_turns
       WHERE session_id = ? AND turn_index >= ? AND turn_index < ?
       ORDER BY turn_index`,
    )
    .all(sessionId, fromTurn, toTurn) as TurnRow[];

  const toolCounts: Record<string, number> = {};
  const filesModified: string[] = [];
  let events: EventRow[] = [];

  const turnTimestamps = db
    .prepare(
      `SELECT MIN(timestamp_ms) as min_ts, MAX(timestamp_ms) as max_ts
       FROM scanner_turns
       WHERE session_id = ? AND turn_index >= ? AND turn_index < ?`,
    )
    .get(sessionId, fromTurn, toTurn) as {
    min_ts: number | null;
    max_ts: number | null;
  };

  if (turnTimestamps.min_ts && turnTimestamps.max_ts) {
    events = db
      .prepare(
        `SELECT event_type, tool_name, tool_input
         FROM scanner_events
         WHERE session_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?`,
      )
      .all(
        sessionId,
        turnTimestamps.min_ts,
        turnTimestamps.max_ts,
      ) as EventRow[];

    for (const e of events) {
      if (e.tool_name) {
        toolCounts[e.tool_name] = (toolCounts[e.tool_name] || 0) + 1;
      }
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

  return { turns, toolCounts, filesModified, events };
}

function buildDeterministicContent(
  turns: TurnRow[],
  toolCounts: Record<string, number>,
  filesModified: string[],
  fromTurn: number,
  toTurn: number,
): string {
  const summaryParts: string[] = [];

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

  const uniqueFiles = [...new Set(filesModified)];
  if (uniqueFiles.length > 0) {
    const fileList = uniqueFiles
      .slice(0, 5)
      .map((f) => {
        const segments = f.split("/");
        return segments[segments.length - 1];
      })
      .join(", ");
    summaryParts.push(
      `Files: ${fileList}${uniqueFiles.length > 5 ? ` (+${uniqueFiles.length - 5} more)` : ""}`,
    );
  }

  return summaryParts.join(". ");
}

function buildLlmPrompt(
  turns: TurnRow[],
  toolCounts: Record<string, number>,
  filesModified: string[],
  fromTurn: number,
  toTurn: number,
): string {
  const lines: string[] = [
    `Summarize this coding session segment in 1-2 sentences. Focus on what was accomplished, not the mechanics.`,
    "",
    `Turns ${fromTurn}-${toTurn - 1}:`,
  ];

  for (const t of turns) {
    if (t.role === "user" && t.content_preview) {
      lines.push(`[User] ${t.content_preview.slice(0, 200)}`);
    } else if (t.role === "assistant" && t.content_preview) {
      lines.push(`[Assistant] ${t.content_preview.slice(0, 200)}`);
    }
  }

  if (Object.keys(toolCounts).length > 0) {
    const tools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}(${count})`)
      .join(", ");
    lines.push("", `Tools used: ${tools}`);
  }

  const uniqueFiles = [...new Set(filesModified)];
  if (uniqueFiles.length > 0) {
    lines.push(`Files modified: ${uniqueFiles.slice(0, 10).join(", ")}`);
  }

  lines.push("", "Output plain text only, no markdown or bullet points.");

  return lines.join("\n");
}

export function generateDelta(
  sessionId: string,
  fromTurn: number,
  toTurn: number,
): SummaryDelta | null {
  const { turns, toolCounts, filesModified } = gatherTurnsAndEvents(
    sessionId,
    fromTurn,
    toTurn,
  );

  if (turns.length === 0) return null;

  const db = getDb();
  const deltaCount = db
    .prepare(
      "SELECT COUNT(*) as c FROM session_summary_deltas WHERE session_id = ?",
    )
    .get(sessionId) as { c: number };

  // Try LLM first, fall back to deterministic
  const llmPrompt = buildLlmPrompt(
    turns,
    toolCounts,
    filesModified,
    fromTurn,
    toTurn,
  );
  const llmResult = invokeLlm(llmPrompt);

  if (llmResult) {
    return {
      sessionId,
      deltaIndex: deltaCount.c,
      createdAtMs: Date.now(),
      fromTurn,
      toTurn,
      content: llmResult,
      method: "llm",
    };
  }

  // Deterministic fallback
  return {
    sessionId,
    deltaIndex: deltaCount.c,
    createdAtMs: Date.now(),
    fromTurn,
    toTurn,
    content: buildDeterministicContent(
      turns,
      toolCounts,
      filesModified,
      fromTurn,
      toTurn,
    ),
    method: "deterministic",
  };
}

export { DELTA_INTERVAL };
