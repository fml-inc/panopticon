/**
 * Default tool category fallback for unknown tool names.
 * Each target provides its own normalizeToolCategory with a full map;
 * this is the final fallback when no target-specific match is found.
 */
export function defaultToolCategory(_toolName: string): string {
  return "";
}
