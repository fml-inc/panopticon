export const EDIT_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "edit_file",
  "write_file",
  "create_file",
  "apply_patch",
]);

export interface ParsedEditEntry {
  filePath: string;
  newString: string;
  oldStrings: string[];
  multiEditIndex: number;
  deletedFile: boolean;
}

export function isEditToolName(toolName: string): boolean {
  return EDIT_TOOL_NAMES.has(toolName);
}

export function parseEditEntries(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): ParsedEditEntry[] {
  if (!toolInput || !EDIT_TOOL_NAMES.has(toolName)) return [];

  if (toolName === "Edit" || toolName === "edit_file") {
    const filePath = readToolInputFilePath(toolInput);
    return filePath && typeof toolInput.new_string === "string"
      ? [
          {
            filePath,
            newString: toolInput.new_string,
            oldStrings:
              typeof toolInput.old_string === "string"
                ? [toolInput.old_string]
                : [],
            multiEditIndex: 0,
            deletedFile: false,
          },
        ]
      : [];
  }

  if (
    toolName === "Write" ||
    toolName === "write_file" ||
    toolName === "create_file"
  ) {
    const filePath = readToolInputFilePath(toolInput);
    return filePath && typeof toolInput.content === "string"
      ? [
          {
            filePath,
            newString: toolInput.content,
            oldStrings: [],
            multiEditIndex: 0,
            deletedFile: false,
          },
        ]
      : [];
  }

  if (toolName === "MultiEdit") {
    const filePath = readToolInputFilePath(toolInput);
    if (!filePath || !Array.isArray(toolInput.edits)) return [];
    return toolInput.edits.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const newString = (entry as { new_string?: unknown }).new_string;
      if (typeof newString !== "string") return [];
      const oldString = (entry as { old_string?: unknown }).old_string;
      return [
        {
          filePath,
          newString,
          oldStrings: typeof oldString === "string" ? [oldString] : [],
          multiEditIndex: index,
          deletedFile: false,
        },
      ];
    });
  }

  if (toolName === "apply_patch") {
    const patch = toolInput.input;
    return typeof patch === "string" ? parseApplyPatchEntries(patch) : [];
  }

  return [];
}

export function parseEditEntriesFromJson(
  toolName: string,
  inputJson: string | null,
): ParsedEditEntry[] {
  if (!inputJson || !EDIT_TOOL_NAMES.has(toolName)) return [];
  try {
    return parseEditEntries(
      toolName,
      JSON.parse(inputJson) as Record<string, unknown>,
    );
  } catch {
    return [];
  }
}

function readToolInputFilePath(
  toolInput: Record<string, unknown>,
): string | null {
  if (
    typeof toolInput.file_path === "string" &&
    toolInput.file_path.length > 0
  ) {
    return toolInput.file_path;
  }
  if (typeof toolInput.path === "string" && toolInput.path.length > 0) {
    return toolInput.path;
  }
  return null;
}

function parseApplyPatchEntries(patch: string): ParsedEditEntry[] {
  const entries: ParsedEditEntry[] = [];
  const lines = patch.split(/\r?\n/);
  let currentFilePath: string | null = null;
  let renamedFromPath: string | null = null;
  let addedLines: string[] = [];
  let removedLines: string[] = [];
  let deletedFile = false;

  const flushEntry = () => {
    if (!currentFilePath) return;
    if (!deletedFile && addedLines.length === 0 && removedLines.length === 0) {
      if (renamedFromPath && renamedFromPath !== currentFilePath) {
        entries.push({
          filePath: renamedFromPath,
          newString: "",
          oldStrings: [],
          multiEditIndex: entries.length,
          deletedFile: true,
        });
        entries.push({
          filePath: currentFilePath,
          newString: "",
          oldStrings: [],
          multiEditIndex: entries.length,
          deletedFile: false,
        });
      }
      renamedFromPath = null;
      return;
    }
    entries.push({
      filePath: currentFilePath,
      newString: addedLines.join("\n"),
      oldStrings: removedLines.length > 0 ? [removedLines.join("\n")] : [],
      multiEditIndex: entries.length,
      deletedFile,
    });
    addedLines = [];
    removedLines = [];
    deletedFile = false;
    renamedFromPath = null;
  };

  const startFile = (filePath: string, isDeletedFile = false) => {
    flushEntry();
    currentFilePath = filePath;
    deletedFile = isDeletedFile;
    renamedFromPath = null;
  };

  for (const line of lines) {
    if (line.startsWith("*** Update File: ")) {
      startFile(line.slice("*** Update File: ".length));
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      startFile(line.slice("*** Add File: ".length));
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      startFile(line.slice("*** Delete File: ".length), true);
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      renamedFromPath = currentFilePath;
      currentFilePath = line.slice("*** Move to: ".length);
      continue;
    }
    if (line === "*** End Patch") {
      break;
    }
    if (!currentFilePath) continue;
    if (line.startsWith("@@") || line.startsWith("*** ")) {
      flushEntry();
      continue;
    }
    if (line.startsWith("+")) {
      addedLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      removedLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      flushEntry();
    }
  }

  flushEntry();
  return entries.map((entry, index) => ({
    ...entry,
    multiEditIndex: index,
  }));
}
