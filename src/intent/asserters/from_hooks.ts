import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  editKey,
  hookEvidenceKey,
  intentKey,
  sha256Hex,
} from "../../claims/keys.js";
import {
  assertClaim,
  deleteClaimsByAsserter,
  deleteClaimsByAsserterForSession,
} from "../../claims/store.js";
import { getDb } from "../../db/schema.js";

const ASSERTER = "intent.from_hooks";
const VERSION = "1";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const SNIPPET_LEN = 200;

interface HookPromptRow {
  id: number;
  session_id: string;
  event_type: string;
  timestamp_ms: number;
  cwd: string | null;
  repository: string | null;
  user_prompt: string | null;
  tool_name: string | null;
  payload: Uint8Array;
}

interface UserMessageRow {
  session_id: string;
  ordinal: number;
  uuid: string | null;
  content: string;
}

interface EditEntry {
  filePath: string;
  newString: string;
  multiEditIndex: number;
}

export function rebuildIntentClaimsFromHooks(opts?: { sessionId?: string }): {
  prompts: number;
  edits: number;
} {
  if (opts?.sessionId) {
    deleteClaimsByAsserterForSession(ASSERTER, opts.sessionId);
  } else {
    deleteClaimsByAsserter(ASSERTER);
  }
  const db = getDb();
  const hookRows = db
    .prepare(
      `SELECT id, session_id, event_type, timestamp_ms, cwd, repository, user_prompt, tool_name, payload
       FROM hook_events
       WHERE event_type IN ('UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd')
       ${opts?.sessionId ? "AND session_id = ?" : ""}
       ORDER BY session_id ASC, timestamp_ms ASC, id ASC`,
    )
    .all(...(opts?.sessionId ? [opts.sessionId] : [])) as HookPromptRow[];
  const userRows = db
    .prepare(
      `SELECT session_id, ordinal, uuid, content
       FROM messages
       WHERE role = 'user' AND is_system = 0
       ${opts?.sessionId ? "AND session_id = ?" : ""}
       ORDER BY session_id ASC, ordinal ASC`,
    )
    .all(...(opts?.sessionId ? [opts.sessionId] : [])) as UserMessageRow[];

  const eventsBySession = new Map<string, HookPromptRow[]>();
  for (const row of hookRows) {
    const list = eventsBySession.get(row.session_id) ?? [];
    list.push(row);
    eventsBySession.set(row.session_id, list);
  }
  const usersBySession = new Map<string, UserMessageRow[]>();
  for (const row of userRows) {
    const list = usersBySession.get(row.session_id) ?? [];
    list.push(row);
    usersBySession.set(row.session_id, list);
  }

  let prompts = 0;
  let edits = 0;
  for (const [sessionId, events] of eventsBySession) {
    const users = usersBySession.get(sessionId) ?? [];
    let searchStart = 0;
    let promptIndex = 0;
    let lastSubject: string | null = null;
    let currentClosed = false;
    let currentToolCallIndex = 0;
    for (const event of events) {
      if (event.event_type === "UserPromptSubmit") {
        const resolved = resolveIntentSubject({
          sessionId,
          users,
          promptText: event.user_prompt,
          promptIndex,
          searchStart,
        });
        const subject = resolved.subject;
        searchStart = resolved.nextSearchStart;
        if (lastSubject && !currentClosed) {
          assertClosedAtClaim({
            subject: lastSubject,
            timestampMs: event.timestamp_ms,
            evidenceKey: hookEvidenceKey(event.id),
            canonicalize: false,
          });
        }
        assertHookIntentClaims({
          subject,
          sessionId,
          promptText: event.user_prompt,
          repository: event.repository,
          cwd: event.cwd,
          timestampMs: event.timestamp_ms,
          evidenceKey: hookEvidenceKey(event.id),
          canonicalize: false,
        });
        lastSubject = subject;
        currentClosed = false;
        currentToolCallIndex = 0;
        promptIndex += 1;
        prompts += 1;
      } else if (event.event_type === "PostToolUse") {
        if (
          !lastSubject ||
          !event.tool_name ||
          !EDIT_TOOLS.has(event.tool_name)
        ) {
          continue;
        }
        const parsedPayload = JSON.parse(
          gunzipSync(event.payload).toString("utf8"),
        ) as Record<string, unknown>;
        const editEntries = parseEditEntries(
          event.tool_name,
          parsedPayload.tool_input as Record<string, unknown> | undefined,
        );
        const toolCallIndex = currentToolCallIndex;
        for (const entry of editEntries) {
          assertHookEditClaims({
            intentSubject: lastSubject,
            sessionId,
            hookEventId: event.id,
            toolCallIndex,
            toolName: event.tool_name,
            payload: parsedPayload,
            entry,
            cwd: event.cwd,
            timestampMs: event.timestamp_ms,
            canonicalize: false,
          });
          edits += 1;
        }
        if (editEntries.length > 0) {
          currentToolCallIndex += 1;
        }
      } else if (lastSubject && !currentClosed) {
        assertClosedAtClaim({
          subject: lastSubject,
          timestampMs: event.timestamp_ms,
          evidenceKey: hookEvidenceKey(event.id),
          canonicalize: false,
        });
        currentClosed = true;
      }
    }
  }
  return { prompts, edits };
}

export function recordIntentClaimsFromHookEvent(args: {
  sessionId: string;
  eventType: string;
  hookEventId: number;
  timestampMs: number;
  cwd?: string | null;
  repository?: string | null;
  payload: Record<string, unknown>;
}): void {
  if (
    args.eventType !== "UserPromptSubmit" &&
    args.eventType !== "PostToolUse" &&
    args.eventType !== "Stop" &&
    args.eventType !== "SessionEnd"
  ) {
    return;
  }
  const db = getDb();
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM hook_events
         WHERE session_id = ? AND event_type = 'UserPromptSubmit' AND id <= ?`,
      )
      .get(args.sessionId, args.hookEventId) as { c: number }
  ).c;
  if (count === 0) return;
  const promptText = readPromptText(args.payload);
  const currentUser = db
    .prepare(
      `SELECT session_id, ordinal, uuid, content
       FROM messages
       WHERE session_id = ? AND role = 'user' AND is_system = 0
       ORDER BY ordinal ASC
       LIMIT 1000`,
    )
    .all(args.sessionId) as Array<{
    session_id: string;
    ordinal: number;
    uuid: string | null;
    content: string;
  }>;

  const evidenceKey = hookEvidenceKey(args.hookEventId);
  if (args.eventType === "UserPromptSubmit") {
    const subject = resolveIntentSubject({
      sessionId: args.sessionId,
      users: currentUser,
      promptText,
      promptIndex: count - 1,
      searchStart: 0,
    }).subject;
    if (count > 1) {
      const previousSubject = resolveIntentSubject({
        sessionId: args.sessionId,
        users: currentUser,
        promptText: null,
        promptIndex: count - 2,
        searchStart: 0,
      }).subject;
      if (!hasHookClosedAtClaim(previousSubject)) {
        assertClosedAtClaim({
          subject: previousSubject,
          timestampMs: args.timestampMs,
          evidenceKey,
        });
      }
    }
    assertHookIntentClaims({
      subject,
      sessionId: args.sessionId,
      promptText: readPromptText(args.payload),
      repository: args.repository ?? null,
      cwd: args.cwd ?? null,
      timestampMs: args.timestampMs,
      evidenceKey,
    });
    return;
  }

  const subject = resolveIntentSubject({
    sessionId: args.sessionId,
    users: currentUser,
    promptText: null,
    promptIndex: count - 1,
    searchStart: 0,
  }).subject;
  if (args.eventType === "PostToolUse") {
    const toolName =
      typeof args.payload.tool_name === "string"
        ? args.payload.tool_name
        : null;
    if (!toolName || !EDIT_TOOLS.has(toolName)) return;
    const entries = parseEditEntries(
      toolName,
      args.payload.tool_input as Record<string, unknown> | undefined,
    );
    const toolCallIndex = resolveLiveToolCallIndex(
      args.sessionId,
      args.hookEventId,
    );
    for (const entry of entries) {
      assertHookEditClaims({
        intentSubject: subject,
        sessionId: args.sessionId,
        hookEventId: args.hookEventId,
        toolCallIndex,
        toolName,
        payload: args.payload,
        entry,
        cwd: args.cwd ?? null,
        timestampMs: args.timestampMs,
      });
    }
    return;
  }
  if (!hasHookClosedAtClaim(subject)) {
    assertClosedAtClaim({
      subject,
      timestampMs: args.timestampMs,
      evidenceKey,
    });
  }
}

function assertHookIntentClaims(args: {
  subject: string;
  sessionId: string;
  promptText: string | null;
  repository: string | null;
  cwd: string | null;
  timestampMs: number;
  evidenceKey: string;
  canonicalize?: boolean;
}): void {
  const evidence = [{ key: args.evidenceKey, role: "origin" as const }];
  if (args.promptText && args.promptText.trim() !== "") {
    assertClaim({
      predicate: "intent/prompt-text",
      subjectKind: "intent",
      subject: args.subject,
      value: args.promptText,
      observedAtMs: args.timestampMs,
      sourceType: "hook",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence,
      canonicalize: args.canonicalize,
    });
  }
  assertClaim({
    predicate: "intent/session",
    subjectKind: "intent",
    subject: args.subject,
    value: args.sessionId,
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
  assertClaim({
    predicate: "intent/prompt-ts-ms",
    subjectKind: "intent",
    subject: args.subject,
    value: args.timestampMs,
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
  if (args.repository) {
    assertClaim({
      predicate: "intent/repository",
      subjectKind: "intent",
      subject: args.subject,
      value: args.repository,
      observedAtMs: args.timestampMs,
      sourceType: "hook",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence,
      canonicalize: args.canonicalize,
    });
  }
  if (args.cwd) {
    assertClaim({
      predicate: "intent/cwd",
      subjectKind: "intent",
      subject: args.subject,
      value: args.cwd,
      observedAtMs: args.timestampMs,
      sourceType: "hook",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence,
      canonicalize: args.canonicalize,
    });
  }
}

function assertHookEditClaims(args: {
  intentSubject: string;
  sessionId: string;
  hookEventId: number;
  toolCallIndex: number;
  toolName: string;
  payload: Record<string, unknown>;
  entry: EditEntry;
  cwd: string | null;
  timestampMs: number;
  canonicalize?: boolean;
}): void {
  const toolUseId = readToolUseId(args.payload);
  const subject = editKey({
    intentKey: args.intentSubject,
    sessionId: args.sessionId,
    toolCallIndex: args.toolCallIndex,
    hookEventId: args.hookEventId,
    toolUseId,
    multiEditIndex: args.entry.multiEditIndex,
  });
  const evidence = [
    { key: hookEvidenceKey(args.hookEventId), role: "origin" as const },
  ];
  assertClaim({
    predicate: "edit/part-of-intent",
    subjectKind: "edit",
    subject,
    value: args.intentSubject,
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
  assertClaim({
    predicate: "edit/file",
    subjectKind: "edit",
    subject,
    value: resolveFilePath(args.entry.filePath, args.cwd),
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
  assertClaim({
    predicate: "edit/tool-name",
    subjectKind: "edit",
    subject,
    value: args.toolName,
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
  assertClaim({
    predicate: "edit/multi-edit-index",
    subjectKind: "edit",
    subject,
    value: args.entry.multiEditIndex,
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
  assertClaim({
    predicate: "edit/new-string-hash",
    subjectKind: "edit",
    subject,
    value: sha256Hex(args.entry.newString),
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
  assertClaim({
    predicate: "edit/new-string-snippet",
    subjectKind: "edit",
    subject,
    value: args.entry.newString.slice(0, SNIPPET_LEN),
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
  assertClaim({
    predicate: "edit/timestamp-ms",
    subjectKind: "edit",
    subject,
    value: args.timestampMs,
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
}

function assertClosedAtClaim(args: {
  subject: string;
  timestampMs: number;
  evidenceKey: string;
  canonicalize?: boolean;
}): void {
  assertClaim({
    predicate: "intent/closed-at-ms",
    subjectKind: "intent",
    subject: args.subject,
    value: args.timestampMs,
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence: [{ key: args.evidenceKey, role: "origin" as const }],
    canonicalize: args.canonicalize,
  });
}

function readPromptText(payload: Record<string, unknown>): string | null {
  const prompt = payload.prompt ?? payload.user_prompt;
  return typeof prompt === "string" ? prompt : null;
}

function resolveIntentSubject(args: {
  sessionId: string;
  users: UserMessageRow[];
  promptText: string | null;
  promptIndex: number;
  searchStart: number;
}): { subject: string; nextSearchStart: number } {
  const normalizedPrompt = normalizeText(args.promptText);
  if (normalizedPrompt) {
    for (let i = args.searchStart; i < args.users.length; i += 1) {
      const user = args.users[i];
      if (normalizeText(user.content) === normalizedPrompt) {
        return {
          subject: intentKey({
            sessionId: args.sessionId,
            ordinal: user.ordinal,
            userIndex: i,
            uuid: user.uuid,
          }),
          nextSearchStart: i + 1,
        };
      }
    }
  }
  const fallbackIndex = Math.max(args.searchStart, args.promptIndex);
  const fallback = args.users[fallbackIndex];
  return {
    subject: intentKey({
      sessionId: args.sessionId,
      ordinal: fallback?.ordinal,
      userIndex: fallbackIndex,
      uuid: fallback?.uuid,
    }),
    nextSearchStart: fallbackIndex + 1,
  };
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function hasHookClosedAtClaim(subject: string): boolean {
  const db = getDb();
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM claims
         WHERE asserter = ?
           AND predicate = 'intent/closed-at-ms'
           AND subject = ?
         LIMIT 1`,
      )
      .get(ASSERTER, subject),
  );
}

function resolveLiveToolCallIndex(
  sessionId: string,
  hookEventId: number,
): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM hook_events
       WHERE session_id = ?
         AND event_type = 'PostToolUse'
         AND tool_name IN ('Edit', 'Write', 'MultiEdit')
         AND id < ?
         AND id > COALESCE((
           SELECT MAX(id)
           FROM hook_events
           WHERE session_id = ?
             AND event_type = 'UserPromptSubmit'
             AND id < ?
         ), 0)`,
    )
    .get(sessionId, hookEventId, sessionId, hookEventId) as { c: number };
  return row.c;
}

function parseEditEntries(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): EditEntry[] {
  if (!toolInput || !EDIT_TOOLS.has(toolName)) return [];
  const filePath = toolInput.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return [];

  if (toolName === "Edit") {
    return typeof toolInput.new_string === "string"
      ? [{ filePath, newString: toolInput.new_string, multiEditIndex: 0 }]
      : [];
  }
  if (toolName === "Write") {
    return typeof toolInput.content === "string"
      ? [{ filePath, newString: toolInput.content, multiEditIndex: 0 }]
      : [];
  }
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    return toolInput.edits.flatMap((entry, index) => {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { new_string?: unknown }).new_string === "string"
      ) {
        return [
          {
            filePath,
            newString: (entry as { new_string: string }).new_string,
            multiEditIndex: index,
          },
        ];
      }
      return [];
    });
  }
  return [];
}

function readToolUseId(payload: Record<string, unknown>): string | null {
  const toolUseId = payload.tool_use_id;
  return typeof toolUseId === "string" && toolUseId.length > 0
    ? toolUseId
    : null;
}

function resolveFilePath(filePath: string, cwd: string | null): string {
  if (path.isAbsolute(filePath) || !cwd) return filePath;
  return path.resolve(cwd, filePath);
}
