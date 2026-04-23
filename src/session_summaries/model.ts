export interface SessionSummaryDeterministicInput {
  title: string;
  status: "active" | "landed" | "mixed" | "abandoned";
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  intentCount: number;
  editCount: number;
  landedEditCount: number;
  openEditCount: number;
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

  return {
    summaryText: `${summaryTextParts.join(". ")}.`,
    summarySearchText: searchFields.join("\n"),
  };
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
