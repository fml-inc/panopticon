import type { Database } from "../db/driver.js";
import {
  hookEventSyncEvidenceKey,
  messageSyncEvidenceKey,
  sha256Hex,
  toolCallSyncEvidenceKey,
} from "./keys.js";
import type { EvidenceRefInput, EvidenceRefKind } from "./types.js";

interface MessageEvidenceRow {
  session_id: string;
  ordinal: number;
  uuid: string | null;
  sync_id: string | null;
}

interface ToolCallEvidenceRow {
  session_id: string;
  call_index: number;
  tool_use_id: string | null;
  tool_name: string;
  sync_id: string | null;
  message_sync_id: string | null;
  ordinal: number;
}

interface HookEvidenceRow {
  session_id: string;
  event_type: string;
  timestamp_ms: number;
  tool_name: string | null;
  sync_id: string | null;
}

export interface EvidenceRefRow {
  id: number;
  ref_key: string;
  kind: EvidenceRefKind;
  session_id: string | null;
  sync_id: string | null;
  repository: string | null;
  file_path: string | null;
  trace_id: string | null;
  span_id: string | null;
  locator_json: string;
}

function canonicalFilePaths(args: {
  filePath?: string | null;
  filePaths?: string[] | null;
}): string[] {
  return [
    ...new Set([args.filePath, ...(args.filePaths ?? [])].filter(Boolean)),
  ]
    .map((value) => value as string)
    .sort((a, b) => a.localeCompare(b));
}

export function messageEvidenceRef(args: {
  sessionId: string;
  syncId: string;
  ordinal: number;
  uuid?: string | null;
  repository?: string | null;
}): EvidenceRefInput {
  return {
    kind: "message",
    refKey: messageSyncEvidenceKey(args.syncId),
    sessionId: args.sessionId,
    syncId: args.syncId,
    repository: args.repository ?? null,
    locator: {
      sessionId: args.sessionId,
      syncId: args.syncId,
      ordinal: args.ordinal,
      uuid: args.uuid ?? null,
      repository: args.repository ?? null,
    },
  };
}

export function toolCallEvidenceRef(args: {
  sessionId: string;
  syncId: string;
  toolName: string;
  toolUseId?: string | null;
  callIndex?: number;
  messageSyncId?: string | null;
  messageOrdinal?: number;
  repository?: string | null;
  filePath?: string | null;
  filePaths?: string[] | null;
}): EvidenceRefInput {
  const filePaths = canonicalFilePaths(args);
  return {
    kind: "tool_call",
    refKey: toolCallSyncEvidenceKey(args.syncId),
    sessionId: args.sessionId,
    syncId: args.syncId,
    repository: args.repository ?? null,
    filePath: filePaths.length === 1 ? filePaths[0] : null,
    filePaths,
    locator: {
      sessionId: args.sessionId,
      syncId: args.syncId,
      toolName: args.toolName,
      toolUseId: args.toolUseId ?? null,
      callIndex: args.callIndex,
      messageSyncId: args.messageSyncId ?? null,
      messageOrdinal: args.messageOrdinal,
      repository: args.repository ?? null,
      filePath: filePaths.length === 1 ? filePaths[0] : null,
      filePaths,
    },
  };
}

export function hookEventEvidenceRef(args: {
  sessionId: string;
  syncId: string;
  eventType: string;
  timestampMs: number;
  toolName?: string | null;
  repository?: string | null;
  filePath?: string | null;
  filePaths?: string[] | null;
}): EvidenceRefInput {
  const filePaths = canonicalFilePaths(args);
  return {
    kind: "hook_event",
    refKey: hookEventSyncEvidenceKey(args.syncId),
    sessionId: args.sessionId,
    syncId: args.syncId,
    repository: args.repository ?? null,
    filePath: filePaths.length === 1 ? filePaths[0] : null,
    filePaths,
    locator: {
      sessionId: args.sessionId,
      syncId: args.syncId,
      eventType: args.eventType,
      timestampMs: args.timestampMs,
      toolName: args.toolName ?? null,
      repository: args.repository ?? null,
      filePath: filePaths.length === 1 ? filePaths[0] : null,
      filePaths,
    },
  };
}

export function fileSnapshotEvidenceRef(args: {
  filePath: string;
  content: string;
  repository?: string | null;
}): EvidenceRefInput {
  const contentHash = sha256Hex(args.content);
  const filePaths = [args.filePath];
  return {
    kind: "file_snapshot",
    refKey: `file_snapshot:${args.filePath}:${contentHash}`,
    repository: args.repository ?? null,
    filePath: args.filePath,
    filePaths,
    locator: {
      filePath: args.filePath,
      filePaths,
      contentHash,
      repository: args.repository ?? null,
    },
  };
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).some((col) => col.name === column);
}

function syncEvidenceRefPaths(
  db: Database,
  evidenceRefId: number,
  filePaths: string[],
): void {
  if (filePaths.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO evidence_ref_paths (evidence_ref_id, file_path)
     VALUES (?, ?)`,
  );
  for (const filePath of filePaths) {
    stmt.run(evidenceRefId, filePath);
  }
}

export function ensureEvidenceRef(db: Database, ref: EvidenceRefInput): number {
  const filePaths = canonicalFilePaths(ref);
  const singletonFilePath = filePaths.length === 1 ? filePaths[0] : null;
  db.prepare(
    `INSERT INTO evidence_refs
       (ref_key, kind, session_id, sync_id, repository, file_path, trace_id, span_id, locator_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ref_key) DO UPDATE SET
       kind = excluded.kind,
       session_id = COALESCE(evidence_refs.session_id, excluded.session_id),
       sync_id = COALESCE(evidence_refs.sync_id, excluded.sync_id),
       repository = COALESCE(evidence_refs.repository, excluded.repository),
       file_path = COALESCE(evidence_refs.file_path, excluded.file_path),
       trace_id = COALESCE(evidence_refs.trace_id, excluded.trace_id),
       span_id = COALESCE(evidence_refs.span_id, excluded.span_id)`,
  ).run(
    ref.refKey,
    ref.kind,
    ref.sessionId ?? null,
    ref.syncId ?? null,
    ref.repository ?? null,
    singletonFilePath,
    ref.traceId ?? null,
    ref.spanId ?? null,
    JSON.stringify(ref.locator),
  );
  const row = db
    .prepare(`SELECT id FROM evidence_refs WHERE ref_key = ?`)
    .get(ref.refKey) as { id: number };
  syncEvidenceRefPaths(db, row.id, filePaths);
  return row.id;
}

export function loadEvidenceRefById(
  db: Database,
  id: number,
): EvidenceRefRow | null {
  return (
    (db
      .prepare(
        `SELECT id, ref_key, kind, session_id, sync_id, repository, file_path,
                trace_id, span_id, locator_json
         FROM evidence_refs
         WHERE id = ?`,
      )
      .get(id) as EvidenceRefRow | undefined) ?? null
  );
}

export function legacyEvidenceRefFromKey(
  db: Database,
  key: string,
): EvidenceRefInput | null {
  if (key.startsWith("message:")) {
    const remainder = key.slice("message:".length);
    const splitAt = remainder.lastIndexOf(":");
    if (splitAt <= 0) return null;
    const sessionId = remainder.slice(0, splitAt);
    const ordinal = Number(remainder.slice(splitAt + 1));
    if (!Number.isFinite(ordinal)) return null;
    const hasUuid = tableHasColumn(db, "messages", "uuid");
    const row = db
      .prepare(
        hasUuid
          ? `SELECT session_id, ordinal, uuid, sync_id
             FROM messages
             WHERE session_id = ? AND ordinal = ?`
          : `SELECT session_id, ordinal, NULL AS uuid, sync_id
             FROM messages
             WHERE session_id = ? AND ordinal = ?`,
      )
      .get(sessionId, ordinal) as MessageEvidenceRow | undefined;
    if (!row?.sync_id) return null;
    return {
      kind: "message",
      refKey: `msg:${row.sync_id}`,
      sessionId: row.session_id,
      syncId: row.sync_id,
      locator: {
        sessionId: row.session_id,
        ordinal: row.ordinal,
        uuid: row.uuid,
      },
    };
  }

  if (key.startsWith("tool:")) {
    const toolUseId = key.slice("tool:".length);
    const row = db
      .prepare(
        `SELECT tc.session_id, tc.call_index, tc.tool_use_id, tc.tool_name,
                tc.sync_id, m.sync_id AS message_sync_id, m.ordinal
         FROM tool_calls tc
         JOIN messages m ON m.id = tc.message_id
         WHERE tc.tool_use_id = ?`,
      )
      .get(toolUseId) as ToolCallEvidenceRow | undefined;
    if (!row?.sync_id) return null;
    return {
      kind: "tool_call",
      refKey: `tc:${row.sync_id}`,
      sessionId: row.session_id,
      syncId: row.sync_id,
      locator: {
        sessionId: row.session_id,
        callIndex: row.call_index,
        toolUseId: row.tool_use_id,
        toolName: row.tool_name,
        messageSyncId: row.message_sync_id,
        messageOrdinal: row.ordinal,
      },
    };
  }

  if (key.startsWith("tool_local:")) {
    const remainder = key.slice("tool_local:".length);
    const last = remainder.lastIndexOf(":");
    if (last <= 0) return null;
    const secondLast = remainder.lastIndexOf(":", last - 1);
    if (secondLast <= 0) return null;
    const sessionId = remainder.slice(0, secondLast);
    const ordinal = Number(remainder.slice(secondLast + 1, last));
    const toolCallIndex = Number(remainder.slice(last + 1));
    if (!Number.isFinite(ordinal) || !Number.isFinite(toolCallIndex)) {
      return null;
    }
    const row = db
      .prepare(
        `SELECT tc.session_id, tc.call_index, tc.tool_use_id, tc.tool_name,
                tc.sync_id, m.sync_id AS message_sync_id, m.ordinal
         FROM tool_calls tc
         JOIN messages m ON m.id = tc.message_id
         WHERE tc.session_id = ? AND m.ordinal = ? AND tc.call_index = ?`,
      )
      .get(sessionId, ordinal, toolCallIndex) as
      | ToolCallEvidenceRow
      | undefined;
    if (!row?.sync_id) return null;
    return {
      kind: "tool_call",
      refKey: `tc:${row.sync_id}`,
      sessionId: row.session_id,
      syncId: row.sync_id,
      locator: {
        sessionId: row.session_id,
        callIndex: row.call_index,
        toolUseId: row.tool_use_id,
        toolName: row.tool_name,
        messageSyncId: row.message_sync_id,
        messageOrdinal: row.ordinal,
      },
    };
  }

  if (key.startsWith("hook:")) {
    const id = Number(key.slice("hook:".length));
    if (!Number.isFinite(id)) return null;
    const row = db
      .prepare(
        `SELECT session_id, event_type, timestamp_ms, tool_name, sync_id
         FROM hook_events
         WHERE id = ?`,
      )
      .get(id) as HookEvidenceRow | undefined;
    if (!row?.sync_id) return null;
    return {
      kind: "hook_event",
      refKey: `hook_event:${row.sync_id}`,
      sessionId: row.session_id,
      syncId: row.sync_id,
      locator: {
        eventType: row.event_type,
        timestampMs: row.timestamp_ms,
        toolName: row.tool_name,
      },
    };
  }

  if (key.startsWith("git_commit:")) {
    return {
      kind: "git_commit",
      refKey: key,
      locator: { key },
    };
  }

  if (key.startsWith("git_hunk:")) {
    return {
      kind: "git_hunk",
      refKey: key,
      locator: { key },
    };
  }

  if (key.startsWith("fs_snapshot:")) {
    const remainder = key.slice("fs_snapshot:".length);
    const splitAt = remainder.lastIndexOf(":");
    if (splitAt <= 0) return null;
    const filePath = remainder.slice(0, splitAt);
    const contentHash = remainder.slice(splitAt + 1);
    return {
      kind: "file_snapshot",
      refKey: `file_snapshot:${filePath}:${contentHash}`,
      filePath,
      filePaths: [filePath],
      locator: {
        filePath,
        filePaths: [filePath],
        contentHash,
      },
    };
  }

  return null;
}

export function typedEvidenceRefFromKey(key: string): EvidenceRefInput | null {
  if (key.startsWith("msg:")) {
    return evidenceRefFromSyncId("message", key, key.slice("msg:".length));
  }
  if (key.startsWith("tc:")) {
    return evidenceRefFromSyncId("tool_call", key, key.slice("tc:".length));
  }
  if (key.startsWith("scan_turn:")) {
    return evidenceRefFromSyncId(
      "scanner_turn",
      key,
      key.slice("scan_turn:".length),
    );
  }
  if (key.startsWith("scan_event:")) {
    return evidenceRefFromSyncId(
      "scanner_event",
      key,
      key.slice("scan_event:".length),
    );
  }
  if (key.startsWith("hook_event:")) {
    return evidenceRefFromSyncId(
      "hook_event",
      key,
      key.slice("hook_event:".length),
    );
  }
  if (key.startsWith("otel_log:")) {
    return evidenceRefFromSyncId(
      "otel_log",
      key,
      key.slice("otel_log:".length),
    );
  }
  if (key.startsWith("otel_metric:")) {
    return evidenceRefFromSyncId(
      "otel_metric",
      key,
      key.slice("otel_metric:".length),
    );
  }
  if (key.startsWith("otel_span:")) {
    const remainder = key.slice("otel_span:".length);
    const splitAt = remainder.indexOf(":");
    if (splitAt <= 0) return null;
    const traceId = remainder.slice(0, splitAt);
    const spanId = remainder.slice(splitAt + 1);
    if (!traceId || !spanId) return null;
    return {
      kind: "otel_span",
      refKey: key,
      traceId,
      spanId,
      locator: { traceId, spanId },
    };
  }
  if (key.startsWith("git_commit:")) {
    return { kind: "git_commit", refKey: key, locator: { key } };
  }
  if (key.startsWith("git_hunk:")) {
    return { kind: "git_hunk", refKey: key, locator: { key } };
  }
  if (key.startsWith("file_snapshot:")) {
    const remainder = key.slice("file_snapshot:".length);
    const splitAt = remainder.lastIndexOf(":");
    if (splitAt <= 0) return null;
    const filePath = remainder.slice(0, splitAt);
    const contentHash = remainder.slice(splitAt + 1);
    return {
      kind: "file_snapshot",
      refKey: key,
      filePath,
      filePaths: [filePath],
      locator: { filePath, filePaths: [filePath], contentHash },
    };
  }
  return null;
}

function evidenceRefFromSyncId(
  kind: EvidenceRefKind,
  refKey: string,
  syncId: string,
): EvidenceRefInput | null {
  if (!syncId) return null;
  return {
    kind,
    refKey,
    syncId,
    locator: { syncId },
  };
}
