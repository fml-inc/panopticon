import type { SummaryDelta } from "./store.js";

const MAX_DELTAS = 5;

export function shouldFlatten(deltas: SummaryDelta[]): boolean {
  return deltas.length >= MAX_DELTAS;
}

export function flattenDeltas(deltas: SummaryDelta[]): string {
  if (deltas.length === 0) return "";
  if (deltas.length === 1) return deltas[0].content;

  // Combine all deltas into a structured summary
  const totalTurns = deltas[deltas.length - 1].toTurn - deltas[0].fromTurn;

  // Extract unique tool mentions across all deltas
  const toolMentions = new Set<string>();
  const fileMentions = new Set<string>();
  let firstPrompt = "";

  for (const d of deltas) {
    // Extract tool names from "Tools: X(n), Y(m)" patterns
    const toolMatch = d.content.match(/Tools: ([^.]+)/);
    if (toolMatch) {
      for (const t of toolMatch[1].split(", ")) {
        const name = t.replace(/\(\d+\)/, "").trim();
        if (name) toolMentions.add(name);
      }
    }
    // Extract file names from "Files: ..." patterns
    const fileMatch = d.content.match(/Files: ([^.]+)/);
    if (fileMatch) {
      for (const f of fileMatch[1].split(", ")) {
        const name = f.replace(/\(\+\d+ more\)/, "").trim();
        if (name) fileMentions.add(name);
      }
    }
    // First prompt from first delta
    if (!firstPrompt) {
      const promptMatch = d.content.match(/Prompt: "([^"]+)"/);
      if (promptMatch) firstPrompt = promptMatch[1];
    }
  }

  const parts: string[] = [];
  if (firstPrompt) parts.push(`Started with: "${firstPrompt}"`);
  parts.push(`${totalTurns} turns across ${deltas.length} phases`);
  if (toolMentions.size > 0) {
    parts.push(`Tools: ${[...toolMentions].slice(0, 8).join(", ")}`);
  }
  if (fileMentions.size > 0) {
    parts.push(`Files: ${[...fileMentions].slice(0, 8).join(", ")}`);
  }

  return parts.join(". ");
}

export { MAX_DELTAS };
