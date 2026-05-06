export function extractHookToolResult(
  payload: Record<string, unknown>,
): string | undefined {
  const raw = payload.tool_result ?? payload.tool_response;
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

export function removeDuplicatedHookResultFields(
  payload: Record<string, unknown>,
  hasToolResult: boolean,
): Record<string, unknown> {
  if (
    !hasToolResult ||
    (!("tool_result" in payload) && !("tool_response" in payload))
  ) {
    return payload;
  }

  const normalized = { ...payload };
  delete normalized.tool_result;
  delete normalized.tool_response;
  return normalized;
}
