import { gunzipSync } from "node:zlib";
import { hookEventEvidenceRef } from "../../claims/evidence-refs.js";
import {
  editKey,
  fileKey,
  intentKey,
  repositoryKey,
  semanticEditIdentity,
  sha256Hex,
} from "../../claims/keys.js";
import {
  assertClaim,
  deleteClaimsByAsserter,
  deleteClaimsByAsserterForSession,
} from "../../claims/store.js";
import {
  INTENT_FROM_HOOKS_COMPONENT,
  targetDataVersion,
} from "../../db/data-versions.js";
import { getDb } from "../../db/schema.js";
import { resolveFilePathFromCwd } from "../../paths.js";
import {
  EDIT_TOOL_NAMES,
  type ParsedEditEntry,
  parseEditEntries as parseToolEditEntries,
} from "../editParsing.js";

const ASSERTER = INTENT_FROM_HOOKS_COMPONENT;
const VERSION = targetDataVersion(ASSERTER);
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
  sync_id: string;
}

interface UserMessageRow {
  session_id: string;
  ordinal: number;
  uuid: string | null;
  content: string;
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
      `SELECT id, session_id, event_type, timestamp_ms, cwd, repository, user_prompt, tool_name, payload, sync_id
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
  const seenRepositorySubjects = new Set<string>();
  const seenFileSubjects = new Set<string>();
  for (const [sessionId, events] of eventsBySession) {
    const users = usersBySession.get(sessionId) ?? [];
    let searchStart = 0;
    let promptIndex = 0;
    let lastSubject: string | null = null;
    let currentClosed = false;
    const semanticOccurrences = new Map<string, number>();
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
        const repository = resolveSessionRepository(
          sessionId,
          event.repository,
        );
        if (lastSubject && !currentClosed) {
          assertClosedAtClaim({
            subject: lastSubject,
            timestampMs: event.timestamp_ms,
            evidenceRef: hookEventEvidenceRef({
              sessionId,
              syncId: event.sync_id,
              eventType: event.event_type,
              timestampMs: event.timestamp_ms,
              toolName: event.tool_name,
              repository,
            }),
            canonicalize: false,
          });
        }
        assertHookIntentClaims({
          subject,
          sessionId,
          promptText: event.user_prompt,
          repository,
          cwd: event.cwd,
          timestampMs: event.timestamp_ms,
          evidenceRef: hookEventEvidenceRef({
            sessionId,
            syncId: event.sync_id,
            eventType: event.event_type,
            timestampMs: event.timestamp_ms,
            toolName: event.tool_name,
            repository,
          }),
          canonicalize: false,
          seenRepositorySubjects,
        });
        lastSubject = subject;
        currentClosed = false;
        promptIndex += 1;
        prompts += 1;
      } else if (event.event_type === "PostToolUse") {
        if (
          !lastSubject ||
          !event.tool_name ||
          !EDIT_TOOL_NAMES.has(event.tool_name)
        ) {
          continue;
        }
        const parsedPayload = JSON.parse(
          gunzipSync(event.payload).toString("utf8"),
        ) as Record<string, unknown>;
        const repository = resolveSessionRepository(
          sessionId,
          event.repository,
        );
        const editEntries = parseToolEditEntries(
          event.tool_name,
          parsedPayload.tool_input as Record<string, unknown> | undefined,
        );
        const sessionCwd = resolveSessionCwd(sessionId, event.cwd);
        const evidenceFilePaths = resolveEvidenceFilePaths(
          editEntries,
          sessionCwd,
        );
        for (const entry of editEntries) {
          const resolvedFilePath = resolveFilePath(entry.filePath, sessionCwd);
          const semanticIdentity = semanticEditIdentity({
            filePath: resolvedFilePath,
            newString: entry.newString,
            oldStrings: entry.oldStrings,
            deletedFile: entry.deletedFile,
          });
          const semanticKey = `${lastSubject}|${semanticIdentity}`;
          const semanticOccurrence = semanticOccurrences.get(semanticKey) ?? 0;
          assertHookEditClaims({
            intentSubject: lastSubject,
            sessionId,
            hookEventSyncId: event.sync_id,
            toolName: event.tool_name,
            entry,
            cwd: event.cwd,
            repository,
            timestampMs: event.timestamp_ms,
            semanticOccurrence,
            evidenceFilePaths,
            canonicalize: false,
            seenRepositorySubjects,
            seenFileSubjects,
          });
          semanticOccurrences.set(semanticKey, semanticOccurrence + 1);
          edits += 1;
        }
      } else if (lastSubject && !currentClosed) {
        const repository = resolveSessionRepository(
          sessionId,
          event.repository,
        );
        assertClosedAtClaim({
          subject: lastSubject,
          timestampMs: event.timestamp_ms,
          evidenceRef: hookEventEvidenceRef({
            sessionId,
            syncId: event.sync_id,
            eventType: event.event_type,
            timestampMs: event.timestamp_ms,
            toolName: event.tool_name,
            repository,
          }),
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

  const hookEventSyncId = resolveHookEventSyncId(args.hookEventId);
  const repository = resolveSessionRepository(
    args.sessionId,
    args.repository ?? null,
  );
  const canonicalEvidenceRef = hookEventEvidenceRef({
    sessionId: args.sessionId,
    syncId: hookEventSyncId,
    eventType: args.eventType,
    timestampMs: args.timestampMs,
    toolName:
      typeof args.payload.tool_name === "string"
        ? args.payload.tool_name
        : null,
    repository,
  });
  if (args.eventType === "UserPromptSubmit") {
    const seenRepositorySubjects = new Set<string>();
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
          evidenceRef: canonicalEvidenceRef,
        });
      }
    }
    assertHookIntentClaims({
      subject,
      sessionId: args.sessionId,
      promptText: readPromptText(args.payload),
      repository,
      cwd: args.cwd ?? null,
      timestampMs: args.timestampMs,
      evidenceRef: canonicalEvidenceRef,
      seenRepositorySubjects,
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
    const seenRepositorySubjects = new Set<string>();
    const seenFileSubjects = new Set<string>();
    const toolName =
      typeof args.payload.tool_name === "string"
        ? args.payload.tool_name
        : null;
    if (!toolName || !EDIT_TOOL_NAMES.has(toolName)) return;
    const entries = parseToolEditEntries(
      toolName,
      args.payload.tool_input as Record<string, unknown> | undefined,
    );
    const sessionCwd = resolveSessionCwd(args.sessionId, args.cwd ?? null);
    const evidenceFilePaths = resolveEvidenceFilePaths(entries, sessionCwd);
    for (const entry of entries) {
      const resolvedFilePath = resolveFilePath(entry.filePath, sessionCwd);
      const semanticIdentity = semanticEditIdentity({
        filePath: resolvedFilePath,
        newString: entry.newString,
        oldStrings: entry.oldStrings,
        deletedFile: entry.deletedFile,
      });
      const semanticOccurrence = resolveLiveSemanticOccurrence(
        subject,
        semanticIdentity,
      );
      assertHookEditClaims({
        intentSubject: subject,
        sessionId: args.sessionId,
        hookEventSyncId,
        toolName,
        entry,
        cwd: args.cwd ?? null,
        repository,
        timestampMs: args.timestampMs,
        semanticOccurrence,
        evidenceFilePaths,
        seenRepositorySubjects,
        seenFileSubjects,
      });
    }
    return;
  }
  if (!hasHookClosedAtClaim(subject)) {
    assertClosedAtClaim({
      subject,
      timestampMs: args.timestampMs,
      evidenceRef: canonicalEvidenceRef,
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
  evidenceRef: ReturnType<typeof hookEventEvidenceRef>;
  canonicalize?: boolean;
  seenRepositorySubjects?: Set<string>;
}): void {
  const evidence = [{ ref: args.evidenceRef, role: "origin" as const }];
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
    assertNormalizedRepositoryClaims({
      repository: args.repository,
      intentSubject: args.subject,
      observedAtMs: args.timestampMs,
      evidence,
      canonicalize: args.canonicalize,
      seenRepositorySubjects: args.seenRepositorySubjects,
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
  hookEventSyncId: string;
  toolName: string;
  entry: ParsedEditEntry;
  cwd: string | null;
  repository: string | null;
  timestampMs: number;
  semanticOccurrence: number;
  evidenceFilePaths: string[];
  canonicalize?: boolean;
  seenRepositorySubjects?: Set<string>;
  seenFileSubjects?: Set<string>;
}): void {
  const resolvedFilePath = resolveFilePath(
    args.entry.filePath,
    resolveSessionCwd(args.sessionId, args.cwd),
  );
  const semanticIdentity = semanticEditIdentity({
    filePath: resolvedFilePath,
    newString: args.entry.newString,
    oldStrings: args.entry.oldStrings,
    deletedFile: args.entry.deletedFile,
  });
  const subject = editKey({
    intentKey: args.intentSubject,
    semanticIdentity,
    semanticOccurrence: args.semanticOccurrence,
    multiEditIndex: args.entry.multiEditIndex,
  });
  const evidence = [
    {
      ref: hookEventEvidenceRef({
        sessionId: args.sessionId,
        syncId: args.hookEventSyncId,
        eventType: "PostToolUse",
        timestampMs: args.timestampMs,
        toolName: args.toolName,
        repository: args.repository,
        filePaths: args.evidenceFilePaths,
      }),
      role: "origin" as const,
    },
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
    value: resolvedFilePath,
    observedAtMs: args.timestampMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence,
    canonicalize: args.canonicalize,
  });
  if (args.repository) {
    assertNormalizedFileClaims({
      repository: args.repository,
      filePath: resolvedFilePath,
      editSubject: subject,
      observedAtMs: args.timestampMs,
      evidence,
      canonicalize: args.canonicalize,
      seenRepositorySubjects: args.seenRepositorySubjects,
      seenFileSubjects: args.seenFileSubjects,
    });
  }
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
  evidenceRef: ReturnType<typeof hookEventEvidenceRef>;
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
    evidence: [{ ref: args.evidenceRef, role: "origin" as const }],
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

function resolveLiveSemanticOccurrence(
  intentSubject: string,
  semanticIdentity: string,
): number {
  const db = getDb();
  const subjectPrefix = `edit:${intentSubject}:sem:${sha256Hex(semanticIdentity)}:`;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT subject) AS c
       FROM claims
       WHERE asserter = ?
         AND subject_kind = 'edit'
         AND predicate = 'edit/part-of-intent'
         AND subject LIKE ?`,
    )
    .get(ASSERTER, `${subjectPrefix}%`) as { c: number };
  return row.c;
}

function resolveSessionCwd(
  sessionId: string,
  cwd: string | null,
): string | null {
  if (cwd) return cwd;
  const db = getDb();
  const row = db
    .prepare(`SELECT cwd FROM sessions WHERE session_id = ?`)
    .get(sessionId) as { cwd: string | null } | undefined;
  return row?.cwd ?? null;
}

function resolveSessionRepository(
  sessionId: string,
  repository: string | null,
): string | null {
  if (repository) return repository;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT repository
       FROM session_repositories
       WHERE session_id = ?
       ORDER BY first_seen_ms ASC
       LIMIT 1`,
    )
    .get(sessionId) as { repository: string | null } | undefined;
  return row?.repository ?? null;
}

function resolveFilePath(filePath: string, cwd: string | null): string {
  return resolveFilePathFromCwd(filePath, cwd);
}

function resolveEvidenceFilePaths(
  entries: ParsedEditEntry[],
  cwd: string | null,
): string[] {
  return [
    ...new Set(entries.map((entry) => resolveFilePath(entry.filePath, cwd))),
  ].sort((a, b) => a.localeCompare(b));
}

function resolveHookEventSyncId(hookEventId: number): string {
  const db = getDb();
  const row = db
    .prepare(`SELECT sync_id FROM hook_events WHERE id = ?`)
    .get(hookEventId) as { sync_id: string | null } | undefined;
  if (!row?.sync_id) {
    throw new Error(`Hook event ${hookEventId} is missing sync_id`);
  }
  return row.sync_id;
}

function assertNormalizedRepositoryClaims(args: {
  repository: string;
  intentSubject?: string;
  observedAtMs: number;
  evidence: Parameters<typeof assertClaim>[0]["evidence"];
  canonicalize?: boolean;
  seenRepositorySubjects?: Set<string>;
}): string {
  const repositorySubject = repositoryKey(args.repository);
  if (!args.seenRepositorySubjects?.has(repositorySubject)) {
    assertClaim({
      predicate: "repository/name",
      subjectKind: "repository",
      subject: repositorySubject,
      value: args.repository,
      observedAtMs: args.observedAtMs,
      sourceType: "hook",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence: args.evidence,
      canonicalize: args.canonicalize,
    });
    args.seenRepositorySubjects?.add(repositorySubject);
  }
  if (args.intentSubject) {
    assertClaim({
      predicate: "intent/in-repository",
      subjectKind: "intent",
      subject: args.intentSubject,
      value: repositorySubject,
      observedAtMs: args.observedAtMs,
      sourceType: "hook",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence: args.evidence,
      canonicalize: args.canonicalize,
    });
  }
  return repositorySubject;
}

function assertNormalizedFileClaims(args: {
  repository: string;
  filePath: string;
  editSubject: string;
  observedAtMs: number;
  evidence: Parameters<typeof assertClaim>[0]["evidence"];
  canonicalize?: boolean;
  seenRepositorySubjects?: Set<string>;
  seenFileSubjects?: Set<string>;
}): string {
  const repositorySubject = assertNormalizedRepositoryClaims({
    repository: args.repository,
    observedAtMs: args.observedAtMs,
    evidence: args.evidence,
    canonicalize: args.canonicalize,
    seenRepositorySubjects: args.seenRepositorySubjects,
  });
  const fileSubject = fileKey(args.repository, args.filePath);
  if (!args.seenFileSubjects?.has(fileSubject)) {
    assertClaim({
      predicate: "file/path",
      subjectKind: "file",
      subject: fileSubject,
      value: args.filePath,
      observedAtMs: args.observedAtMs,
      sourceType: "hook",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence: args.evidence,
      canonicalize: args.canonicalize,
    });
    assertClaim({
      predicate: "file/in-repository",
      subjectKind: "file",
      subject: fileSubject,
      value: repositorySubject,
      observedAtMs: args.observedAtMs,
      sourceType: "hook",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence: args.evidence,
      canonicalize: args.canonicalize,
    });
    args.seenFileSubjects?.add(fileSubject);
  }
  assertClaim({
    predicate: "edit/touches-file",
    subjectKind: "edit",
    subject: args.editSubject,
    value: fileSubject,
    observedAtMs: args.observedAtMs,
    sourceType: "hook",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence: args.evidence,
    canonicalize: args.canonicalize,
  });
  return fileSubject;
}
