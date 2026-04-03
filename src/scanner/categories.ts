/**
 * Default tool category fallback for unknown tool names.
 * Each target provides its own normalizeToolCategory with a full map;
 * this handles the common patterns shared across all targets.
 */
export function defaultToolCategory(toolName: string): string {
  if (toolName.startsWith("mcp__")) return "MCP";
  if (toolName.toLowerCase().includes("subagent")) return "Task";
  return "Other";
}
