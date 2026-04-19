import {
  editKey,
  intentKey,
  messageEvidenceKey,
  sha256Hex,
  toolEvidenceKey,
  toolLocalEvidenceKey,
} from "../../claims/keys.js";
import { assertClaim, deleteClaimsByAsserter } from "../../claims/store.js";
import { getDb } from "../../db/schema.js";

const ASSERTER = "intent.from_scanner";
const VERSION = "1";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const SNIPPET_LEN = 200;

interface UserMessageRow {
  session_id: string;
  ordinal: number;
  timestamp_ms: number | null;
  content: string;
  uuid: string | null;
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
  tool_name: string;
  tool_use_id: string | null;
  input_json: string | null;
  timestamp_ms: number | null;
  assistant_ordinal: number;
}

interface EditEntry {
  filePath: string;
  newString: string;
  multiEditIndex: number;
}

export function rebuildIntentClaimsFromScanner(opts?: { sessionId?: string }): {
  intents: number;
  edits: number;
} {
  deleteClaimsByAsserter(ASSERTER);
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
              s.cwd, s.ended_at_ms
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

  let intents = 0;
  for (const msgs of intentsBySession.values()) {
    msgs.forEach((msg, index) => {
      const key = intentKey({
        sessionId: msg.session_id,
        ordinal: msg.ordinal,
        userIndex: msg.user_index,
        uuid: msg.uuid,
      });
      const evidence = [
        {
          key: messageEvidenceKey(msg.session_id, msg.ordinal),
          role: "origin" as const,
        },
      ];
      assertClaim({
        predicate: "intent/prompt-text",
        subjectKind: "intent",
        subject: key,
        value: msg.content,
        observedAtMs: msg.timestamp_ms ?? 0,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: false,
      });
      if (msg.timestamp_ms !== null) {
        assertClaim({
          predicate: "intent/prompt-ts-ms",
          subjectKind: "intent",
          subject: key,
          value: msg.timestamp_ms,
          observedAtMs: msg.timestamp_ms,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
          canonicalize: false,
        });
      }
      assertClaim({
        predicate: "intent/session",
        subjectKind: "intent",
        subject: key,
        value: msg.session_id,
        observedAtMs: msg.timestamp_ms ?? 0,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: false,
      });
      const repo = repoBySession.get(msg.session_id);
      if (repo) {
        assertClaim({
          predicate: "intent/repository",
          subjectKind: "intent",
          subject: key,
          value: repo,
          observedAtMs: msg.timestamp_ms ?? 0,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
          canonicalize: false,
        });
      }
      if (msg.cwd) {
        assertClaim({
          predicate: "intent/cwd",
          subjectKind: "intent",
          subject: key,
          value: msg.cwd,
          observedAtMs: msg.timestamp_ms ?? 0,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
          canonicalize: false,
        });
      }
      const next = msgs[index + 1];
      const closedAtMs = next?.timestamp_ms ?? msg.ended_at_ms ?? null;
      if (closedAtMs !== null) {
        assertClaim({
          predicate: "intent/closed-at-ms",
          subjectKind: "intent",
          subject: key,
          value: closedAtMs,
          observedAtMs: closedAtMs,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
          canonicalize: false,
        });
      }
      intents += 1;
    });
  }

  const toolRows = db
    .prepare(
      `SELECT tc.id, tc.session_id, tc.tool_name, tc.tool_use_id, tc.input_json,
              m.timestamp_ms, m.ordinal AS assistant_ordinal
       FROM tool_calls tc
       JOIN messages m ON m.id = tc.message_id
       ${opts?.sessionId ? "WHERE tc.session_id = ? AND " : "WHERE "}
         tc.tool_name IN ('Edit', 'Write', 'MultiEdit')
       ORDER BY tc.session_id ASC, m.ordinal ASC, tc.id ASC`,
    )
    .all(...(opts?.sessionId ? [opts.sessionId] : [])) as ToolCallRow[];

  let edits = 0;
  const perAssistantIndex = new Map<string, number>();
  for (const row of toolRows) {
    const userMsgs = intentsBySession.get(row.session_id) ?? [];
    const intentMsg = findIntentMessage(userMsgs, row.assistant_ordinal);
    if (!intentMsg) continue;

    const parsed = parseEditEntries(row.tool_name, row.input_json);
    if (parsed.length === 0) continue;

    const intentSubject = intentKey({
      sessionId: intentMsg.session_id,
      ordinal: intentMsg.ordinal,
      userIndex: intentMsg.user_index,
      uuid: intentMsg.uuid,
    });
    const assistantKey = `${row.session_id}:${row.assistant_ordinal}`;
    const toolCallIndex = perAssistantIndex.get(assistantKey) ?? 0;
    for (const entry of parsed) {
      const subject = editKey({
        sessionId: row.session_id,
        assistantOrdinal: row.assistant_ordinal,
        toolCallIndex,
        toolUseId: row.tool_use_id,
        multiEditIndex: entry.multiEditIndex,
      });
      const evidenceKey = row.tool_use_id
        ? toolEvidenceKey(row.tool_use_id)
        : toolLocalEvidenceKey(
            row.session_id,
            row.assistant_ordinal,
            toolCallIndex,
          );
      const evidence = [{ key: evidenceKey, role: "origin" as const }];
      const observedAtMs = row.timestamp_ms ?? intentMsg.timestamp_ms ?? 0;
      assertClaim({
        predicate: "edit/part-of-intent",
        subjectKind: "edit",
        subject,
        value: intentSubject,
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: false,
      });
      assertClaim({
        predicate: "edit/file",
        subjectKind: "edit",
        subject,
        value: entry.filePath,
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: false,
      });
      assertClaim({
        predicate: "edit/tool-name",
        subjectKind: "edit",
        subject,
        value: row.tool_name,
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: false,
      });
      assertClaim({
        predicate: "edit/multi-edit-index",
        subjectKind: "edit",
        subject,
        value: entry.multiEditIndex,
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: false,
      });
      assertClaim({
        predicate: "edit/new-string-hash",
        subjectKind: "edit",
        subject,
        value: sha256Hex(entry.newString),
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: false,
      });
      assertClaim({
        predicate: "edit/new-string-snippet",
        subjectKind: "edit",
        subject,
        value: entry.newString.slice(0, SNIPPET_LEN),
        observedAtMs,
        sourceType: "scanner",
        asserter: ASSERTER,
        asserterVersion: VERSION,
        evidence,
        canonicalize: false,
      });
      if (row.timestamp_ms !== null) {
        assertClaim({
          predicate: "edit/timestamp-ms",
          subjectKind: "edit",
          subject,
          value: row.timestamp_ms,
          observedAtMs: row.timestamp_ms,
          sourceType: "scanner",
          asserter: ASSERTER,
          asserterVersion: VERSION,
          evidence,
          canonicalize: false,
        });
      }
      edits += 1;
    }
    perAssistantIndex.set(assistantKey, toolCallIndex + 1);
  }

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

function parseEditEntries(
  toolName: string,
  inputJson: string | null,
): EditEntry[] {
  if (!inputJson || !EDIT_TOOLS.has(toolName)) return [];
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(inputJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  const filePath = input.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return [];

  if (toolName === "Edit") {
    return typeof input.new_string === "string"
      ? [
          {
            filePath,
            newString: input.new_string,
            multiEditIndex: 0,
          },
        ]
      : [];
  }
  if (toolName === "Write") {
    return typeof input.content === "string"
      ? [
          {
            filePath,
            newString: input.content,
            multiEditIndex: 0,
          },
        ]
      : [];
  }
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.flatMap((entry, index) => {
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
