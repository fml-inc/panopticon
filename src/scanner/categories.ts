/**
 * Default tool category fallback for unknown tool names.
 * Each target provides its own normalizeToolCategory with a full map;
 * this handles patterns shared across all targets.
 */
export function defaultToolCategory(toolName: string): string {
  if (toolName.startsWith("mcp__")) return "MCP";
  return "";
}
