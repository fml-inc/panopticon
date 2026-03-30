import { invokeLlm } from "./llm.js";
import type { SummaryDelta } from "./store.js";

const MAX_DELTAS = 5;

export function shouldFlatten(deltas: SummaryDelta[]): boolean {
  return deltas.length >= MAX_DELTAS;
}

function flattenDeltasDeterministic(deltas: SummaryDelta[]): string {
  if (deltas.length === 0) return "";
  if (deltas.length === 1) return deltas[0].content;

  const totalTurns = deltas[deltas.length - 1].toTurn - deltas[0].fromTurn;

  const toolMentions = new Set<string>();
  const fileMentions = new Set<string>();
  let firstPrompt = "";

  for (const d of deltas) {
    const toolMatch = d.content.match(/Tools: ([^.]+)/);
    if (toolMatch) {
      for (const t of toolMatch[1].split(", ")) {
        const name = t.replace(/\(\d+\)/, "").trim();
        if (name) toolMentions.add(name);
      }
    }
    const fileMatch = d.content.match(/Files: ([^.]+)/);
    if (fileMatch) {
      for (const f of fileMatch[1].split(", ")) {
        const name = f.replace(/\(\+\d+ more\)/, "").trim();
        if (name) fileMentions.add(name);
      }
    }
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

function buildFlattenPrompt(deltas: SummaryDelta[]): string {
  const totalTurns = deltas[deltas.length - 1].toTurn - deltas[0].fromTurn;
  const lines: string[] = [
    `Combine these ${deltas.length} session phase summaries into one coherent 2-3 sentence overview of what was accomplished across ${totalTurns} turns.`,
    "",
  ];

  for (const d of deltas) {
    lines.push(
      `Phase ${d.deltaIndex + 1} (turns ${d.fromTurn}-${d.toTurn - 1}): ${d.content}`,
    );
  }

  lines.push("", "Output plain text only, no markdown or bullet points.");
  return lines.join("\n");
}

export function flattenDeltas(deltas: SummaryDelta[]): string {
  if (deltas.length === 0) return "";
  if (deltas.length === 1) return deltas[0].content;

  // Try LLM first
  const llmResult = invokeLlm(buildFlattenPrompt(deltas));
  if (llmResult) return llmResult;

  // Deterministic fallback
  return flattenDeltasDeterministic(deltas);
}

export { MAX_DELTAS };
