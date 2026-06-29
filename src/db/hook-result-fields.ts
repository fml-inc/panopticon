export interface ProjectedToolResultFields {
  tool_result_stdout: string | null;
  tool_result_stderr: string | null;
  tool_result_interrupted: number | null;
  tool_result_exit_code: number | null;
  tool_result_status: string | null;
  tool_result_is_error: number | null;
  tool_result_error: string | null;
}

const EMPTY_TOOL_RESULT_FIELDS: ProjectedToolResultFields = {
  tool_result_stdout: null,
  tool_result_stderr: null,
  tool_result_interrupted: null,
  tool_result_exit_code: null,
  tool_result_status: null,
  tool_result_is_error: null,
  tool_result_error: null,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readRawField(
  source: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function rawText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

function rawBooleanBit(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}

function rawInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return null;
}

export function projectToolResultFields(
  payload: unknown,
): ProjectedToolResultFields {
  const data = asRecord(payload);
  if (!data) return { ...EMPTY_TOOL_RESULT_FIELDS };

  const toolResult = asRecord(data.tool_result) ?? asRecord(data.tool_response);
  if (!toolResult) return { ...EMPTY_TOOL_RESULT_FIELDS };

  return {
    tool_result_stdout: rawText(readRawField(toolResult, ["stdout"])),
    tool_result_stderr: rawText(readRawField(toolResult, ["stderr"])),
    tool_result_interrupted: rawBooleanBit(
      readRawField(toolResult, ["interrupted"]),
    ),
    tool_result_exit_code: rawInteger(
      readRawField(toolResult, ["exit_code", "exitCode"]),
    ),
    tool_result_status: rawText(readRawField(toolResult, ["status"])),
    tool_result_is_error: rawBooleanBit(
      readRawField(toolResult, ["is_error", "isError"]),
    ),
    tool_result_error: rawText(
      readRawField(toolResult, ["error", "error_message", "errorMessage"]),
    ),
  };
}
