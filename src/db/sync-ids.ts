import { createHash } from "node:crypto";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Build a deterministic sync identity for a message row.
 *
 * Prefer the source-provided UUID when available since it survives some parser
 * rewrites that can shift ordinals. Fall back to the per-session ordinal when
 * UUIDs are absent.
 */
export function buildMessageSyncId(
  sessionId: string,
  ordinal: number,
  uuid?: string | null,
): string {
  const normalizedUuid = uuid?.trim();
  if (normalizedUuid) {
    return sha256Hex(`msg|${sessionId}|uuid|${normalizedUuid}`);
  }
  return sha256Hex(`msg|${sessionId}|ord|${ordinal}`);
}

/**
 * Build a deterministic sync identity for a tool-call row.
 *
 * Prefer tool_use_id when present. Fall back to the tool's 0-based index
 * within the parent message when tool_use_id is absent.
 */
export function buildToolCallSyncId(
  messageSyncId: string,
  callIndex: number,
  toolUseId?: string | null,
): string {
  const normalizedToolUseId = toolUseId?.trim();
  if (normalizedToolUseId) {
    return sha256Hex(`tc|${messageSyncId}|tuid|${normalizedToolUseId}`);
  }
  return sha256Hex(`tc|${messageSyncId}|idx|${callIndex}`);
}

/**
 * Build a deterministic sync identity for a scanner turn row.
 *
 * Turns are naturally keyed within a session by source + turn_index.
 */
export function buildScannerTurnSyncId(
  sessionId: string,
  source: string,
  turnIndex: number,
): string {
  return sha256Hex(`turn|${sessionId}|${source}|${turnIndex}`);
}

/**
 * Build a deterministic sync identity for a scanner event row.
 *
 * Event rows are keyed by their stable ordinal within a session/source event
 * stream. This avoids collapsing repeated same-timestamp metadata events such
 * as file snapshots, attachments, or reasoning rows.
 */
export function buildScannerEventSyncId(
  sessionId: string,
  source: string,
  eventIndex: number,
): string {
  return sha256Hex(`evt|${sessionId}|${source}|idx|${eventIndex}`);
}
