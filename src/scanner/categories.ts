/**
 * Normalize tool names to standard categories for analytics grouping.
 * Matches agentsview's NormalizeToolCategory logic.
 */

const CATEGORY_MAP: Record<string, string> = {
  // File read
  Read: "Read",
  read_file: "Read",
  ReadNotebook: "Read",

  // File write
  Edit: "Edit",
  StrReplace: "Edit",
  MultiEdit: "Edit",

  // File create
  Write: "Write",
  create_file: "Write",
  NotebookEdit: "Write",

  // Shell
  Bash: "Bash",
  shell_command: "Bash",
  run_command: "Bash",

  // Search
  Grep: "Grep",
  grep_search: "Grep",
  finder: "Grep",

  // File patterns
  Glob: "Glob",
  glob: "Glob",
  list_dir: "Glob",

  // Task / Agent
  Task: "Task",
  Agent: "Task",
  spawn_agent: "Task",
  TaskCreate: "Task",
  TaskUpdate: "Task",

  // Skills
  Skill: "Tool",

  // Web
  WebSearch: "Web",
  WebFetch: "Web",
  ToolSearch: "Web",
};

export function normalizeToolCategory(toolName: string): string {
  const mapped = CATEGORY_MAP[toolName];
  if (mapped) return mapped;

  // MCP tools use prefix__name pattern
  if (toolName.startsWith("mcp__")) return "MCP";

  // Subagent-related
  if (toolName.toLowerCase().includes("subagent")) return "Task";

  return "Other";
}
