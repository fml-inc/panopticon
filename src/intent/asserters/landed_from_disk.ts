import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import {
  fileSnapshotEvidenceRef,
  loadEvidenceRefById,
} from "../../claims/evidence-refs.js";
import {
  assertClaim,
  deleteClaimsByAsserter,
  deleteClaimsByAsserterForSession,
} from "../../claims/store.js";
import {
  LANDED_FROM_DISK_COMPONENT,
  targetDataVersion,
} from "../../db/data-versions.js";
import { getDb } from "../../db/schema.js";
import { canUseLocalPathApis } from "../../paths.js";
import {
  type ActiveEdit,
  loadActiveEdits,
  loadActiveIntents,
} from "../claimViews.js";
import { type ParsedEditEntry, parseEditEntries } from "../editParsing.js";

const ASSERTER = LANDED_FROM_DISK_COMPONENT;
const VERSION = targetDataVersion(ASSERTER);

type LandedReason =
  | "present_in_file"
  | "overwritten_in_session"
  | "write_replaced"
  | "file_deleted"
  | "reverted_post_session";

interface PreparedEdit {
  edit: ActiveEdit;
  closedAtMs: number;
  parsedEntry: ParsedEditEntry | null;
  fileOrderIndex: number;
}

interface LandedVerdict {
  status: "landed" | "churned";
  reason: LandedReason;
  fileContent: string | null;
}

interface ParsedPayloadEvidence {
  toolName: string | null;
  parsedEntries: ParsedEditEntry[];
}

export function reconcileLandedClaimsFromDisk(opts?: { sessionId?: string }): {
  checked: number;
  activeIntentsLoaded: number;
  activeEditsLoaded: number;
  activeLoadMs: number;
} {
  if (opts?.sessionId) {
    deleteClaimsByAsserterForSession(ASSERTER, opts.sessionId);
  } else {
    deleteClaimsByAsserter(ASSERTER);
  }
  const loadStartedAt = performance.now();
  const edits = loadActiveEdits(opts);
  const intents = loadActiveIntents(opts);
  const activeLoadMs = performance.now() - loadStartedAt;

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
  const payloadCache = new Map<string, ParsedPayloadEvidence | null>();
  const fileContentCache = new Map<string, string | null>();
  for (const [_sessionId, sessionEdits] of editsBySession) {
    const ordered = [...sessionEdits].sort(
      (a, b) =>
        (a.timestampMs ?? 0) - (b.timestampMs ?? 0) ||
        a.editKey.localeCompare(b.editKey),
    );
    const prepared: PreparedEdit[] = [];
    const editsByFile = new Map<string, PreparedEdit[]>();
    for (const edit of ordered) {
      const intent = edit.intentKey ? intents.get(edit.intentKey) : undefined;
      if (!intent?.closedAtMs || !edit.filePath) {
        continue;
      }
      const fileEdits = editsByFile.get(edit.filePath) ?? [];
      const preparedEdit: PreparedEdit = {
        edit,
        closedAtMs: intent.closedAtMs,
        parsedEntry: getParsedEditEntry(edit, payloadCache),
        fileOrderIndex: fileEdits.length,
      };
      fileEdits.push(preparedEdit);
      editsByFile.set(edit.filePath, fileEdits);
      prepared.push(preparedEdit);
    }

    for (const preparedEdit of prepared) {
      const sameFileEdits = editsByFile.get(preparedEdit.edit.filePath!) ?? [];
      const verdict = decideForEdit(
        preparedEdit,
        sameFileEdits,
        fileContentCache,
      );
      if (!verdict) {
        continue;
      }
      const observedAtMs =
        preparedEdit.edit.timestampMs ?? preparedEdit.closedAtMs ?? Date.now();
      const intent = preparedEdit.edit.intentKey
        ? intents.get(preparedEdit.edit.intentKey)
        : undefined;
      const evidence = verdict.fileContent
        ? [
            {
              ref: fileSnapshotEvidenceRef({
                filePath: preparedEdit.edit.filePath!,
                content: verdict.fileContent,
                repository: intent?.repository ?? null,
              }),
              role: "origin" as const,
            },
          ]
        : [];
      assertClaim({
        predicate: "edit/landed-status",
        subjectKind: "edit",
        subject: preparedEdit.edit.editKey,
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
        subject: preparedEdit.edit.editKey,
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

  return {
    checked,
    activeIntentsLoaded: intents.size,
    activeEditsLoaded: edits.size,
    activeLoadMs,
  };
}

function decideForEdit(
  preparedEdit: PreparedEdit,
  allEditsForFile: PreparedEdit[],
  fileContentCache: Map<string, string | null>,
): LandedVerdict | null {
  const { edit, parsedEntry } = preparedEdit;
  const snippet = edit.newStringSnippet ?? "";
  const deletedFileEdit = parsedEntry?.deletedFile ?? false;
  const later = allEditsForFile.slice(preparedEdit.fileOrderIndex + 1);

  for (const next of later) {
    if (
      next.edit.toolName === "Write" ||
      next.edit.toolName === "write_file" ||
      next.edit.toolName === "create_file"
    ) {
      const writeContent = next.parsedEntry?.newString ?? null;
      if (writeContent !== null && snippet && !writeContent.includes(snippet)) {
        return {
          status: "churned",
          reason: "write_replaced",
          fileContent: null,
        };
      }
    } else if ((next.parsedEntry?.oldStrings.length ?? 0) > 0) {
      const oldStrings = next.parsedEntry?.oldStrings ?? [];
      if (
        snippet &&
        oldStrings.some((oldString) => oldString.includes(snippet))
      ) {
        return {
          status: "churned",
          reason: "overwritten_in_session",
          fileContent: null,
        };
      }
    }
  }

  if (!canUseLocalPathApis(edit.filePath!)) {
    return null;
  }

  const fileContent = readFileSafe(edit.filePath!, fileContentCache);
  if (fileContent === null) {
    return deletedFileEdit
      ? { status: "landed", reason: "file_deleted", fileContent: null }
      : { status: "churned", reason: "file_deleted", fileContent: null };
  }
  if (deletedFileEdit) {
    return {
      status: "churned",
      reason: "reverted_post_session",
      fileContent,
    };
  }
  if (snippet && fileContent.includes(snippet)) {
    return { status: "landed", reason: "present_in_file", fileContent };
  }
  if (!snippet) {
    const oldStrings = parsedEntry?.oldStrings ?? [];
    if (oldStrings.length > 0) {
      return oldStrings.some(
        (oldString) => oldString && fileContent.includes(oldString),
      )
        ? {
            status: "churned",
            reason: "reverted_post_session",
            fileContent,
          }
        : { status: "landed", reason: "present_in_file", fileContent };
    }
    return { status: "landed", reason: "present_in_file", fileContent };
  }
  return { status: "churned", reason: "reverted_post_session", fileContent };
}

function readFileSafe(
  filePath: string,
  cache: Map<string, string | null>,
): string | null {
  if (cache.has(filePath)) {
    return cache.get(filePath) ?? null;
  }
  try {
    const content = fs.readFileSync(filePath, "utf8");
    cache.set(filePath, content);
    return content;
  } catch {
    cache.set(filePath, null);
    return null;
  }
}

function getParsedEditEntry(
  edit: ActiveEdit,
  payloadCache: Map<string, ParsedPayloadEvidence | null>,
): ParsedEditEntry | null {
  const payload = loadParsedPayloadEvidence(edit, payloadCache);
  return (
    payload?.parsedEntries.find(
      (entry) => entry.multiEditIndex === (edit.multiEditIndex ?? 0),
    ) ?? null
  );
}

function loadParsedPayloadEvidence(
  edit: ActiveEdit,
  cache: Map<string, ParsedPayloadEvidence | null>,
): ParsedPayloadEvidence | null {
  const cacheKey =
    typeof edit.payloadEvidenceRefId === "number"
      ? `evidence_ref:${edit.payloadEvidenceRefId}`
      : (edit.payloadEvidenceKey ??
        `hook_event_id:${edit.hookEventId ?? "none"}`);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }
  const raw = decodePayloadEvidence(
    edit.payloadEvidenceRefId,
    edit.hookEventId,
  );
  const toolName = edit.toolName ?? raw?.toolName;
  const parsed =
    toolName && raw?.toolInput
      ? {
          toolName,
          parsedEntries: parseEditEntries(toolName, raw.toolInput),
        }
      : null;
  cache.set(cacheKey, parsed);
  return parsed;
}

function decodePayloadEvidence(
  evidenceRefId: number | null | undefined,
  hookEventId: number | null | undefined,
): {
  toolName: string | null;
  toolInput: Record<string, unknown> | undefined;
} | null {
  const db = getDb();
  if (typeof evidenceRefId === "number") {
    const ref = loadEvidenceRefById(db, evidenceRefId);
    if (!ref) return null;
    if (ref.kind === "tool_call") {
      return decodeToolCallPayload(ref.sync_id);
    }
    if (ref.kind === "hook_event") {
      return decodeHookPayloadBySyncId(ref.sync_id);
    }
    return null;
  }
  if (typeof hookEventId !== "number") return null;
  return decodeHookPayloadById(hookEventId);
}

function decodeToolCallPayload(toolCallSyncId: string | null): {
  toolName: string | null;
  toolInput: Record<string, unknown> | undefined;
} | null {
  if (!toolCallSyncId) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT tool_name, input_json
       FROM tool_calls
       WHERE sync_id = ?`,
    )
    .get(toolCallSyncId) as
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

function decodeHookPayloadBySyncId(hookEventSyncId: string | null): {
  toolName: string | null;
  toolInput: Record<string, unknown> | undefined;
} | null {
  if (!hookEventSyncId) return null;
  const db = getDb();
  const row = db
    .prepare(`SELECT payload FROM hook_events WHERE sync_id = ?`)
    .get(hookEventSyncId) as { payload: Uint8Array } | undefined;
  return row ? decodeHookPayload(row.payload) : null;
}

function decodeHookPayloadById(hookEventId: number): {
  toolName: string | null;
  toolInput: Record<string, unknown> | undefined;
} | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT payload FROM hook_events WHERE id = ?`)
    .get(hookEventId) as { payload: Uint8Array } | undefined;
  return row ? decodeHookPayload(row.payload) : null;
}

function decodeHookPayload(payloadBytes: Uint8Array): {
  toolName: string | null;
  toolInput: Record<string, unknown> | undefined;
} | null {
  try {
    const payload = JSON.parse(
      gunzipSync(payloadBytes).toString("utf8"),
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
