export interface TurnSummary {
  summary: string;
  method: "deterministic" | "llm";
}

function firstSentence(text: string, maxLen: number): string {
  const periodIdx = text.indexOf(".");
  const newlineIdx = text.indexOf("\n");

  let end = text.length;
  if (periodIdx !== -1 && periodIdx < end) end = periodIdx + 1;
  if (newlineIdx !== -1 && newlineIdx < end) end = newlineIdx;

  const sentence = text.slice(0, end).trim();
  if (sentence.length > maxLen) {
    return `${sentence.slice(0, maxLen - 3)}...`;
  }
  return sentence;
}

export function summarizeTurn(turn: {
  role: string | null;
  contentPreview: string | null;
  eventType?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
}): TurnSummary {
  if (turn.role === "user") {
    const summary = turn.contentPreview
      ? firstSentence(turn.contentPreview, 120)
      : "User message";
    return { summary, method: "deterministic" };
  }

  // Assistant or other roles
  const summary = turn.contentPreview
    ? firstSentence(turn.contentPreview, 120)
    : "Assistant response";
  return { summary, method: "deterministic" };
}
