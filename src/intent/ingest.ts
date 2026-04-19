/**
 * Intent ingest: turn UserPromptSubmit + Edit/Write/MultiEdit events into
 * intent_units / intent_edits rows.
 *
 * Hook into processHookEvent AFTER insertHookEvent so we can link to the
 * just-inserted hook_events.id.
 */
import {
  closeOpenIntentUnits,
  getOpenIntentUnit,
  insertIntentEdit,
  openIntentUnit,
} from "./store.js";

const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit"]);

export interface RecordIntentInput {
  session_id: string;
  event_type: string;
  hook_event_id: number;
  timestamp_ms: number;
  cwd?: string | null;
  repository?: string | null;
  payload: Record<string, unknown>;
}

interface MultiEditEntry {
  old_string?: unknown;
  new_string?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Extract the string content this tool call inserted into the file.
 * Returns one entry per logical edit (MultiEdit fans out into N).
 *
 * Returns [] if the tool isn't an edit tool, or if we can't find the
 * expected fields in tool_input.
 */
function extractEditPayloads(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): Array<{ file_path: string; new_string: string; index: number }> {
  if (!toolInput) return [];
  const filePath = toolInput.file_path;
  if (!isString(filePath)) return [];

  if (toolName === "Edit") {
    const ns = toolInput.new_string;
    return isString(ns)
      ? [{ file_path: filePath, new_string: ns, index: 0 }]
      : [];
  }

  if (toolName === "Write") {
    const content = toolInput.content;
    return isString(content)
      ? [{ file_path: filePath, new_string: content, index: 0 }]
      : [];
  }

  if (toolName === "MultiEdit") {
    const edits = toolInput.edits;
    if (!Array.isArray(edits)) return [];
    const out: Array<{ file_path: string; new_string: string; index: number }> =
      [];
    edits.forEach((e: MultiEditEntry, i: number) => {
      if (isString(e?.new_string)) {
        out.push({ file_path: filePath, new_string: e.new_string, index: i });
      }
    });
    return out;
  }

  return [];
}

/**
 * Process a hook event for the intent index. Idempotent on no-op events
 * (anything that isn't a UserPromptSubmit or an edit-tool PostToolUse).
 *
 * Behaviour:
 *   - UserPromptSubmit: open a new intent_unit (closes the prior open one)
 *   - PostToolUse for Edit/Write/MultiEdit: append intent_edit rows to the
 *     currently-open intent_unit. If no open unit (edit happened before any
 *     prompt — e.g. agent-driven), silently skip.
 *   - Stop / SessionEnd: close any still-open units so they don't leak past
 *     the session boundary.
 */
export function recordIntent(input: RecordIntentInput): void {
  const { event_type, payload, session_id, timestamp_ms } = input;

  if (event_type === "UserPromptSubmit") {
    const promptRaw = payload.prompt ?? payload.user_prompt;
    const promptText = isString(promptRaw) ? promptRaw : null;
    if (!promptText) return;
    openIntentUnit({
      session_id,
      prompt_event_id: input.hook_event_id,
      prompt_text: promptText,
      prompt_ts_ms: timestamp_ms,
      cwd: input.cwd,
      repository: input.repository,
    });
    return;
  }

  if (event_type === "Stop" || event_type === "SessionEnd") {
    closeOpenIntentUnits(session_id, timestamp_ms);
    return;
  }

  if (event_type !== "PostToolUse") return;
  const toolName = payload.tool_name;
  if (!isString(toolName) || !EDIT_TOOL_NAMES.has(toolName)) return;

  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  const edits = extractEditPayloads(toolName, toolInput);
  if (edits.length === 0) return;

  const open = getOpenIntentUnit(session_id);
  if (!open) return; // edit with no preceding prompt — skip

  for (const e of edits) {
    insertIntentEdit({
      intent_unit_id: open.id,
      session_id,
      hook_event_id: input.hook_event_id,
      multi_edit_index: e.index,
      timestamp_ms,
      file_path: e.file_path,
      tool_name: toolName,
      new_string: e.new_string,
    });
  }
}
