import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileSnapshotEvidenceKey } from "../../claims/keys.js";
import { assertClaim, deleteClaimsByAsserter } from "../../claims/store.js";
import { getDb } from "../../db/schema.js";
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
  deleteClaimsByAsserter(ASSERTER);
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
        canonicalize: false,
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
        canonicalize: false,
      });
      checked += 1;
    }
  }

  return { checked };
}

function decideForEdit(
  edit: ActiveEdit,
  allEditsForSession: ActiveEdit[],
): { status: "landed" | "churned"; reason: LandedReason } {
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
  const payload = decodeHookPayload(edit.hookEventId);
  if (!payload) return null;
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
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
  const payload = decodeHookPayload(edit.hookEventId);
  if (!payload) return [];
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
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

function decodeHookPayload(
  hookEventId: number | null | undefined,
): Record<string, unknown> | null {
  if (typeof hookEventId !== "number") return null;
  const db = getDb();
  const row = db
    .prepare(`SELECT payload FROM hook_events WHERE id = ?`)
    .get(hookEventId) as { payload: Uint8Array } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(gunzipSync(row.payload).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}
