import { canonicalizeHeadKeys } from "../../claims/canonicalize.js";
import {
  messageEvidenceRef,
  toolCallEvidenceRef,
} from "../../claims/evidence-refs.js";
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
  INTENT_FROM_SCANNER_COMPONENT,
  targetDataVersion,
} from "../../db/data-versions.js";
import { getDb } from "../../db/schema.js";
import {
  canonicalizeRepoFilePath,
  resolveFilePathFromCwd,
} from "../../paths.js";
import {
  type ParsedEditEntry,
  parseEditEntriesFromJson,
} from "../editParsing.js";

const ASSERTER = INTENT_FROM_SCANNER_COMPONENT;
const VERSION = targetDataVersion(ASSERTER);
const SNIPPET_LEN = 200;

interface UserMessageRow {
  session_id: string;
  ordinal: number;
  timestamp_ms: number | null;
  content: string;
  uuid: string | null;
  sync_id: string;
  cwd: string | null;
  ended_at_ms: number | null;
  user_index?: number;
}

interface RepoRow {
  session_id: string;
  repository: string;
}

interface ToolCallRow {
  id: number;
  session_id: string;
  call_index: number;
  tool_name: string;
  tool_use_id: string | null;
  input_json: string | null;
  sync_id: string;
  timestamp_ms: number | null;
  message_sync_id: string;
  assistant_ordinal: number;
}

export function rebuildIntentClaimsFromScanner(opts?: { sessionId?: string }): {
  intents: number;
  edits: number;
} {
  const affectedHeadKeys = new Set<string>();
  const assertScannerClaim = (
    input: Parameters<typeof assertClaim>[0],
  ): void => {
    const result = assertClaim({ ...input, canonicalize: false });
    affectedHeadKeys.add(result.headKey);
  };
  if (opts?.sessionId) {
    deleteClaimsByAsserterForSession(ASSERTER, opts.sessionId);
  } else {
    deleteClaimsByAsserter(ASSERTER);
  }
  const db = getDb();
  const params: unknown[] = [];
  const userFilters = ["m.role = 'user'", "m.is_system = 0"];
  if (opts?.sessionId) {
    userFilters.push("m.session_id = ?");
    params.push(opts.sessionId);
  }
  const userMessages = db
    .prepare(
      `SELECT m.session_id, m.ordinal, m.timestamp_ms, m.content, m.uuid,
              m.sync_id, s.cwd, s.ended_at_ms
       FROM messages m
       JOIN sessions s ON s.session_id = m.session_id
       WHERE ${userFilters.join(" AND ")}
       ORDER BY m.session_id ASC, m.ordinal ASC`,
    )
    .all(...params) as UserMessageRow[];

  const repos = db
    .prepare(
      `SELECT session_id, repository
       FROM session_repositories
       ${opts?.sessionId ? "WHERE session_id = ?" : ""}
       ORDER BY first_seen_ms ASC`,
    )
    .all(...(opts?.sessionId ? [opts.sessionId] : [])) as RepoRow[];
  const repoBySession = new Map<string, string>();
  for (const row of repos) {
    if (!repoBySession.has(row.session_id)) {
      repoBySession.set(row.session_id, row.repository);
    }
  }
  const intentsBySession = new Map<string, UserMessageRow[]>();
  for (const msg of userMessages) {
    const list = intentsBySession.get(msg.session_id) ?? [];
    msg.user_index = list.length;
    list.push(msg);
    intentsBySession.set(msg.session_id, list);
  }
  const normalizedSubjectStateBySession = new Map<
    string,
    {
      seenRepositorySubjects: Set<string>;
      seenFileSubjects: Set<string>;
    }
  >();

  let intents = 0;
  for (const [sessionId, msgs] of intentsBySession) {
    const subjectState = {
      seenRepositorySubjects: new Set<string>(),
      seenFileSubjects: new Set<string>(),
    };
    normalizedSubjectStateBySession.set(sessionId, subjectState);
    msgs.forEach((msg, index) => {
      const repository = repoBySession.get(msg.session_id) ?? null;
      const key = intentKey({
        sessionId: msg.session_id,
        ordinal: msg.ordinal,
        userIndex: msg.user_index,
        uuid: msg.uuid,
      });
      const evidence = [
        {
          ref: messageEvidenceRef({
            sessionId: msg.session_id,
            syncId: msg.sync_id,
            ordinal: msg.ordinal,
            uuid: msg.uuid,
            repository,
          }),
          role: "origin" as const,
        },
      ];
      assertScannerClaim({
        predicate: "intent/prompt-text",
        subjectKind: "intent",
        subject: key,
        value: msg.content,
        observedAtMs: msg.timestamp_ms ?? 0,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
      });
      if (msg.timestamp_ms !== null) {
        assertScannerClaim({
          predicate: "intent/prompt-ts-ms",
          subjectKind: "intent",
          subject: key,
          value: msg.timestamp_ms,
          observedAtMs: msg.timestamp_ms,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
        });
      }
      assertScannerClaim({
        predicate: "intent/session",
        subjectKind: "intent",
        subject: key,
        value: msg.session_id,
        observedAtMs: msg.timestamp_ms ?? 0,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
      });
      if (repository) {
        assertScannerClaim({
          predicate: "intent/repository",
          subjectKind: "intent",
          subject: key,
          value: repository,
          observedAtMs: msg.timestamp_ms ?? 0,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
        });
        assertNormalizedRepositoryClaims({
          assertClaim: assertScannerClaim,
          repository,
          intentSubject: key,
          observedAtMs: msg.timestamp_ms ?? 0,
          evidence,
          seenRepositorySubjects: subjectState.seenRepositorySubjects,
        });
      }
      if (msg.cwd) {
        assertScannerClaim({
          predicate: "intent/cwd",
          subjectKind: "intent",
          subject: key,
          value: msg.cwd,
          observedAtMs: msg.timestamp_ms ?? 0,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
        });
      }
      const next = msgs[index + 1];
      const closedAtMs = next?.timestamp_ms ?? msg.ended_at_ms ?? null;
      if (closedAtMs !== null) {
        assertScannerClaim({
          predicate: "intent/closed-at-ms",
          subjectKind: "intent",
          subject: key,
          value: closedAtMs,
          observedAtMs: closedAtMs,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
        });
      }
      intents += 1;
    });
  }

  const toolRows = db
    .prepare(
      `SELECT tc.id, tc.session_id, tc.call_index, tc.tool_name, tc.tool_use_id,
              tc.input_json, tc.sync_id, m.timestamp_ms, m.sync_id AS message_sync_id,
              m.ordinal AS assistant_ordinal
       FROM tool_calls tc
       JOIN messages m ON m.id = tc.message_id
       ${opts?.sessionId ? "WHERE tc.session_id = ? AND " : "WHERE "}
         tc.tool_name IN ('Edit', 'Write', 'MultiEdit', 'edit_file', 'write_file', 'create_file', 'apply_patch')
       ORDER BY tc.session_id ASC, m.ordinal ASC, tc.id ASC`,
    )
    .all(...(opts?.sessionId ? [opts.sessionId] : [])) as ToolCallRow[];

  let edits = 0;
  const perIntentSemanticIndex = new Map<string, number>();
  for (const row of toolRows) {
    const userMsgs = intentsBySession.get(row.session_id) ?? [];
    const intentMsg = findIntentMessage(userMsgs, row.assistant_ordinal);
    if (!intentMsg) continue;

    const parsed = parseEditEntriesFromJson(row.tool_name, row.input_json);
    if (parsed.length === 0) continue;

    const repository = repoBySession.get(row.session_id) ?? null;
    const subjectState = normalizedSubjectStateBySession.get(
      row.session_id,
    ) ?? {
      seenRepositorySubjects: new Set<string>(),
      seenFileSubjects: new Set<string>(),
    };
    normalizedSubjectStateBySession.set(row.session_id, subjectState);
    const evidenceFilePaths = resolveEvidenceFilePaths(parsed, intentMsg.cwd);
    const intentSubject = intentKey({
      sessionId: intentMsg.session_id,
      ordinal: intentMsg.ordinal,
      userIndex: intentMsg.user_index,
      uuid: intentMsg.uuid,
    });
    for (const entry of parsed) {
      const resolvedFilePath = resolveFilePathFromCwd(
        entry.filePath,
        intentMsg.cwd ?? null,
      );
      const canonicalFilePath = canonicalizeRepoFilePath(resolvedFilePath, {
        cwd: intentMsg.cwd ?? null,
        repositoryRoot: repository,
        allowNonGitRepositoryRoot: true,
      });
      const semanticIdentity = semanticEditIdentity({
        filePath: canonicalFilePath,
        newString: entry.newString,
        oldStrings: entry.oldStrings,
        deletedFile: entry.deletedFile,
      });
      const semanticKey = `${intentSubject}|${semanticIdentity}`;
      const semanticOccurrence = perIntentSemanticIndex.get(semanticKey) ?? 0;
      const subject = editKey({
        intentKey: intentSubject,
        semanticIdentity,
        semanticOccurrence,
        multiEditIndex: entry.multiEditIndex,
      });
      const evidence = [
        {
          ref: toolCallEvidenceRef({
            sessionId: row.session_id,
            syncId: row.sync_id,
            toolName: row.tool_name,
            toolUseId: row.tool_use_id,
            callIndex: row.call_index,
            messageSyncId: row.message_sync_id,
            messageOrdinal: row.assistant_ordinal,
            repository,
            filePaths: evidenceFilePaths,
          }),
          role: "origin" as const,
        },
      ];
      const observedAtMs = row.timestamp_ms ?? intentMsg.timestamp_ms ?? 0;
      assertScannerClaim({
        predicate: "edit/part-of-intent",
        subjectKind: "edit",
        subject,
        value: intentSubject,
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
      });
      assertScannerClaim({
        predicate: "edit/file",
        subjectKind: "edit",
        subject,
        value: canonicalFilePath,
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
      });
      if (repository) {
        assertNormalizedFileClaims({
          assertClaim: assertScannerClaim,
          repository,
          filePath: canonicalFilePath,
          editSubject: subject,
          observedAtMs,
          evidence,
          seenRepositorySubjects: subjectState.seenRepositorySubjects,
          seenFileSubjects: subjectState.seenFileSubjects,
        });
      }
      assertScannerClaim({
        predicate: "edit/tool-name",
        subjectKind: "edit",
        subject,
        value: row.tool_name,
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
      });
      assertScannerClaim({
        predicate: "edit/multi-edit-index",
        subjectKind: "edit",
        subject,
        value: entry.multiEditIndex,
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
      });
      assertScannerClaim({
        predicate: "edit/new-string-hash",
        subjectKind: "edit",
        subject,
        value: sha256Hex(entry.newString),
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
      });
      assertScannerClaim({
        predicate: "edit/new-string-snippet",
        subjectKind: "edit",
        subject,
        value: entry.newString.slice(0, SNIPPET_LEN),
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
      });
      if (row.timestamp_ms !== null) {
        assertScannerClaim({
          predicate: "edit/timestamp-ms",
          subjectKind: "edit",
          subject,
          value: row.timestamp_ms,
          observedAtMs: row.timestamp_ms,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
        });
      }
      edits += 1;
      perIntentSemanticIndex.set(semanticKey, semanticOccurrence + 1);
    }
  }

  canonicalizeHeadKeys(affectedHeadKeys);
  return { intents, edits };
}

function findIntentMessage(
  userMessages: UserMessageRow[],
  assistantOrdinal: number,
): UserMessageRow | undefined {
  for (let i = userMessages.length - 1; i >= 0; i -= 1) {
    if (userMessages[i].ordinal < assistantOrdinal) {
      return userMessages[i];
    }
  }
  return undefined;
}

function resolveEvidenceFilePaths(
  entries: ParsedEditEntry[],
  cwd: string | null,
): string[] {
  return [
    ...new Set(
      entries.map((entry) => resolveFilePathFromCwd(entry.filePath, cwd)),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function assertNormalizedRepositoryClaims(args: {
  assertClaim: (input: Parameters<typeof assertClaim>[0]) => void;
  repository: string;
  intentSubject?: string;
  observedAtMs: number;
  evidence: Parameters<typeof assertClaim>[0]["evidence"];
  seenRepositorySubjects: Set<string>;
}): string {
  const repositorySubject = repositoryKey(args.repository);
  if (!args.seenRepositorySubjects.has(repositorySubject)) {
    args.assertClaim({
      predicate: "repository/name",
      subjectKind: "repository",
      subject: repositorySubject,
      value: args.repository,
      observedAtMs: args.observedAtMs,
      sourceType: "scanner",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence: args.evidence,
    });
    args.seenRepositorySubjects.add(repositorySubject);
  }
  if (args.intentSubject) {
    args.assertClaim({
      predicate: "intent/in-repository",
      subjectKind: "intent",
      subject: args.intentSubject,
      value: repositorySubject,
      observedAtMs: args.observedAtMs,
      sourceType: "scanner",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence: args.evidence,
    });
  }
  return repositorySubject;
}

function assertNormalizedFileClaims(args: {
  assertClaim: (input: Parameters<typeof assertClaim>[0]) => void;
  repository: string;
  filePath: string;
  editSubject: string;
  observedAtMs: number;
  evidence: Parameters<typeof assertClaim>[0]["evidence"];
  seenRepositorySubjects: Set<string>;
  seenFileSubjects: Set<string>;
}): string {
  const repositorySubject = assertNormalizedRepositoryClaims({
    assertClaim: args.assertClaim,
    repository: args.repository,
    observedAtMs: args.observedAtMs,
    evidence: args.evidence,
    seenRepositorySubjects: args.seenRepositorySubjects,
  });
  const fileSubject = fileKey(args.repository, args.filePath);
  if (!args.seenFileSubjects.has(fileSubject)) {
    args.assertClaim({
      predicate: "file/path",
      subjectKind: "file",
      subject: fileSubject,
      value: args.filePath,
      observedAtMs: args.observedAtMs,
      sourceType: "scanner",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence: args.evidence,
    });
    args.assertClaim({
      predicate: "file/in-repository",
      subjectKind: "file",
      subject: fileSubject,
      value: repositorySubject,
      observedAtMs: args.observedAtMs,
      sourceType: "scanner",
      asserter: ASSERTER,
      asserterVersion: VERSION,
      evidence: args.evidence,
    });
    args.seenFileSubjects.add(fileSubject);
  }
  args.assertClaim({
    predicate: "edit/touches-file",
    subjectKind: "edit",
    subject: args.editSubject,
    value: fileSubject,
    observedAtMs: args.observedAtMs,
    sourceType: "scanner",
    asserter: ASSERTER,
    asserterVersion: VERSION,
    evidence: args.evidence,
  });
  return fileSubject;
}
