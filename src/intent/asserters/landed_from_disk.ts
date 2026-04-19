import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileSnapshotEvidenceKey } from "../../claims/keys.js";
import {
  assertClaim,
  deleteClaimsByAsserter,
  deleteClaimsByAsserterForSession,
} from "../../claims/store.js";
import { getDb } from "../../db/schema.js";
import { canUseLocalPathApis } from "../../paths.js";
import {
  type ActiveEdit,
  loadActiveEdits,
  loadActiveIntents,
} from "../claimViews.js";

const ASSERTER = "intent.landed_from_disk";
const VERSION = "2";

type LandedReason =
  | "present_in_file"
  | "overwritten_in_session"
  | "write_replaced"
  | "file_deleted"
  | "reverted_post_session";

export function reconcileLandedClaimsFromDisk(opts?: { sessionId?: string }): {
  checked: number;
} {
  if (opts?.sessionId) {
    deleteClaimsByAsserterForSession(ASSERTER, opts.sessionId);
  } else {
    deleteClaimsByAsserter(ASSERTER);
  }
  const edits = loadActiveEdits();
  const intents = loadActiveIntents();

  const editsBySession = new Map<string, ActiveEdit[]>();
  for (const edit of edits.values()) {
    if (!edit.filePath || !edit.intentKey) continue;
    const intent = intents.get(edit.intentKey);
    if (!intent?.sessionId) continue;
    if (opts?.sessionId && intent.sessionId !== opts.sessionId) continue;
    const list = editsBySession.get(intent.sessionId) ?? [];
    list.push(edit);
    editsBySession.set(intent.sessionId, list);
  }

  let checked = 0;
  for (const [_sessionId, sessionEdits] of editsBySession) {
    const ordered = [...sessionEdits].sort(
      (a, b) =>
        (a.timestampMs ?? 0) - (b.timestampMs ?? 0) ||
        a.editKey.localeCompare(b.editKey),
    );
    for (const edit of ordered) {
      const intent = edit.intentKey ? intents.get(edit.intentKey) : undefined;
      if (!intent?.closedAtMs) {
        continue;
      }
      const verdict = decideForEdit(edit, ordered);
      if (!verdict) {
        continue;
      }
      const observedAtMs = edit.timestampMs ?? intent.closedAtMs ?? Date.now();
      const content =
        verdict.reason === "file_deleted" ? null : readFileSafe(edit.filePath!);
      const evidence = content
        ? [
            {
              key: fileSnapshotEvidenceKey(edit.filePath!, content),
              role: "origin" as const,
            },
          ]
        : [];
      assertClaim({
        predicate: "edit/landed-status",
        subjectKind: "edit",
        subject: edit.editKey,
        value: verdict.status,
        observedAtMs,
        sourceType: "git_disk",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: !!opts?.sessionId,
      });
      assertClaim({
        predicate: "edit/landed-reason",
        subjectKind: "edit",
        subject: edit.editKey,
        value: verdict.reason,
        observedAtMs,
        sourceType: "git_disk",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: !!opts?.sessionId,
      });
      checked += 1;
    }
  }

  return { checked };
}

function decideForEdit(
  edit: ActiveEdit,
  allEditsForSession: ActiveEdit[],
): { status: "landed" | "churned"; reason: LandedReason } | null {
  const snippet = edit.newStringSnippet ?? "";
  const later = allEditsForSession.filter(
    (candidate) =>
      candidate.filePath === edit.filePath &&
      ((candidate.timestampMs ?? 0) > (edit.timestampMs ?? 0) ||
        ((candidate.timestampMs ?? 0) === (edit.timestampMs ?? 0) &&
          candidate.editKey > edit.editKey)),
  );

  for (const next of later) {
    if (next.toolName === "Write") {
      const writeContent = fetchEditNewString(next);
      if (writeContent !== null && snippet && !writeContent.includes(snippet)) {
        return { status: "churned", reason: "write_replaced" };
      }
    } else if (next.toolName === "Edit" || next.toolName === "MultiEdit") {
      const oldStrings = fetchOldStrings(next);
      if (
        snippet &&
        oldStrings.some((oldString) => oldString.includes(snippet))
      ) {
        return { status: "churned", reason: "overwritten_in_session" };
      }
    }
  }

  if (!canUseLocalPathApis(edit.filePath!)) {
    return null;
  }

  const fileContent = readFileSafe(edit.filePath!);
  if (fileContent === null) {
    return { status: "churned", reason: "file_deleted" };
  }
  if (!snippet || fileContent.includes(snippet)) {
    return { status: "landed", reason: "present_in_file" };
  }
  return { status: "churned", reason: "reverted_post_session" };
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function fetchEditNewString(edit: ActiveEdit): string | null {
  const payload = decodePayloadEvidence(
    edit.payloadEvidenceKey,
    edit.hookEventId,
  );
  const toolInput = payload?.toolInput;
  if (!toolInput) return null;

  if (edit.toolName === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : null;
  }
  if (edit.toolName === "Edit") {
    return typeof toolInput.new_string === "string"
      ? toolInput.new_string
      : null;
  }
  if (edit.toolName === "MultiEdit") {
    const edits = toolInput.edits;
    if (!Array.isArray(edits)) return null;
    const sub = edits[edit.multiEditIndex ?? 0] as
      | { new_string?: unknown }
      | undefined;
    return typeof sub?.new_string === "string" ? sub.new_string : null;
  }
  return null;
}

function fetchOldStrings(edit: ActiveEdit): string[] {
  const payload = decodePayloadEvidence(
    edit.payloadEvidenceKey,
    edit.hookEventId,
  );
  const toolInput = payload?.toolInput;
  if (!toolInput) return [];

  if (edit.toolName === "Edit") {
    return typeof toolInput.old_string === "string"
      ? [toolInput.old_string]
      : [];
  }
  if (edit.toolName === "MultiEdit") {
    const edits = toolInput.edits;
    if (!Array.isArray(edits)) return [];
    return (edits as Array<{ old_string?: unknown }>)
      .map((entry) => entry.old_string)
      .filter((value): value is string => typeof value === "string");
  }
  return [];
}

function decodePayloadEvidence(
  evidenceKey: string | null | undefined,
  hookEventId: number | null | undefined,
): {
  toolName: string | null;
  toolInput: Record<string, unknown> | undefined;
} | null {
  if (evidenceKey?.startsWith("tool:")) {
    const toolUseId = evidenceKey.slice("tool:".length);
    const db = getDb();
    const row = db
      .prepare(
        `SELECT tool_name, input_json
         FROM tool_calls
         WHERE tool_use_id = ?`,
      )
      .get(toolUseId) as
      | { tool_name: string; input_json: string | null }
      | undefined;
    if (!row?.input_json) return null;
    try {
      return {
        toolName: row.tool_name,
        toolInput: JSON.parse(row.input_json) as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }
  if (evidenceKey?.startsWith("tool_local:")) {
    const parsed = parseToolLocalEvidenceKey(evidenceKey);
    if (!parsed) return null;
    const db = getDb();
    const row = db
      .prepare(
        `SELECT tc.tool_name, tc.input_json
         FROM tool_calls tc
         JOIN messages m ON m.id = tc.message_id
         WHERE tc.session_id = ? AND m.ordinal = ?
         ORDER BY tc.id ASC
         LIMIT 1 OFFSET ?`,
      )
      .get(parsed.sessionId, parsed.messageOrdinal, parsed.toolCallIndex) as
      | { tool_name: string; input_json: string | null }
      | undefined;
    if (!row?.input_json) return null;
    try {
      return {
        toolName: row.tool_name,
        toolInput: JSON.parse(row.input_json) as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }
  if (typeof hookEventId !== "number") return null;
  const db = getDb();
  const row = db
    .prepare(`SELECT payload FROM hook_events WHERE id = ?`)
    .get(hookEventId) as { payload: Uint8Array } | undefined;
  if (!row) return null;
  try {
    const payload = JSON.parse(
      gunzipSync(row.payload).toString("utf8"),
    ) as Record<string, unknown>;
    return {
      toolName:
        typeof payload.tool_name === "string" ? payload.tool_name : null,
      toolInput: payload.tool_input as Record<string, unknown> | undefined,
    };
  } catch {
    return null;
  }
}

function parseToolLocalEvidenceKey(key: string): {
  sessionId: string;
  messageOrdinal: number;
  toolCallIndex: number;
} | null {
  const remainder = key.slice("tool_local:".length);
  const last = remainder.lastIndexOf(":");
  if (last <= 0) return null;
  const secondLast = remainder.lastIndexOf(":", last - 1);
  if (secondLast <= 0) return null;
  return {
    sessionId: remainder.slice(0, secondLast),
    messageOrdinal: Number(remainder.slice(secondLast + 1, last)),
    toolCallIndex: Number(remainder.slice(last + 1)),
  };
}
