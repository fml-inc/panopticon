import { createHash } from "node:crypto";
import fs from "node:fs";
import { config } from "../config.js";
import { getDb } from "../db/schema.js";
import { canUseLocalPathApis } from "../paths.js";

const MEMBERSHIP_SOURCE = "heuristic";
const ORIGIN_SCOPE = "local";
const STATUS_ACTIVE = "active";
const STATUS_LANDED = "landed";
const STATUS_MIXED = "mixed";
const STATUS_ABANDONED = "abandoned";
const MIN_SPAN_SNIPPET_LEN = 8;

interface IntentRow {
  intent_unit_id: number;
  session_id: string;
  prompt_text: string;
  prompt_ts_ms: number | null;
  next_prompt_ts_ms: number | null;
  repository: string | null;
  cwd: string | null;
}

interface EditRow {
  intent_edit_id: number;
  intent_unit_id: number;
  session_id: string;
  file_path: string;
  tool_name: string | null;
  timestamp_ms: number | null;
  landed: number | null;
  landed_reason: string | null;
  new_string_hash: string | null;
  new_string_snippet: string | null;
}

interface FileSnapshot {
  text: string;
  hash: string;
}

export function rebuildSessionSummaryProjections(opts?: {
  sessionId?: string;
}): {
  sessionSummaries: number;
  memberships: number;
  provenance: number;
} {
  if (!config.enableSessionSummaryProjections) {
    return {
      sessionSummaries: 0,
      memberships: 0,
      provenance: 0,
    };
  }
  const db = getDb();
  const tx = db.transaction(() => {
    if (opts?.sessionId) {
      const key = sessionSummaryKey(opts.sessionId);
      const row = db
        .prepare(
          `SELECT id FROM session_summaries WHERE session_summary_key = ?`,
        )
        .get(key) as { id: number } | undefined;
      if (row) {
        db.prepare(
          `DELETE FROM code_provenance WHERE session_summary_id = ?`,
        ).run(row.id);
        db.prepare(
          `DELETE FROM intent_session_summaries WHERE session_summary_id = ?`,
        ).run(row.id);
        db.prepare(`DELETE FROM session_summaries WHERE id = ?`).run(row.id);
      }
    } else {
      db.prepare(`DELETE FROM code_provenance`).run();
      db.prepare(`DELETE FROM intent_session_summaries`).run();
      db.prepare(`DELETE FROM session_summaries`).run();
    }

    const sessionRows = db
      .prepare(
        `SELECT DISTINCT session_id
         FROM intent_units
         ${opts?.sessionId ? "WHERE session_id = ?" : ""}
         ORDER BY session_id ASC`,
      )
      .all(...(opts?.sessionId ? [opts.sessionId] : [])) as Array<{
      session_id: string;
    }>;

    const sessionSummaryStmt = db.prepare(
      `INSERT INTO session_summaries
       (session_summary_key, repository, cwd, branch, worktree, actor, machine,
        origin_scope, title, status, first_intent_ts_ms, last_intent_ts_ms,
        intent_count, edit_count, landed_edit_count, open_edit_count,
        reconciled_at_ms, reason_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const membershipStmt = db.prepare(
      `INSERT INTO intent_session_summaries
       (intent_unit_id, session_summary_id, membership_kind, source, score, reason_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const provenanceStmt = db.prepare(
      `INSERT INTO code_provenance
       (repository, file_path, binding_level, start_line, end_line,
        snippet_hash, snippet_preview, language, symbol_kind, symbol_name,
        actor, machine, origin_scope, intent_unit_id, intent_edit_id,
        session_summary_id, status, confidence, file_hash, established_at_ms,
        verified_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let sessionSummaries = 0;
    let memberships = 0;
    let provenance = 0;

    for (const session of sessionRows) {
      const intents = db
        .prepare(
          `SELECT id AS intent_unit_id, session_id, prompt_text, prompt_ts_ms,
                  next_prompt_ts_ms, repository, cwd
           FROM intent_units
           WHERE session_id = ?
           ORDER BY COALESCE(prompt_ts_ms, 0) ASC, id ASC`,
        )
        .all(session.session_id) as IntentRow[];
      if (intents.length === 0) continue;

      const edits = db
        .prepare(
          `SELECT id AS intent_edit_id, intent_unit_id, session_id, file_path,
                  tool_name, timestamp_ms, landed, landed_reason,
                  new_string_hash, new_string_snippet
           FROM intent_edits
           WHERE session_id = ?
           ORDER BY COALESCE(timestamp_ms, 0) ASC, id ASC`,
        )
        .all(session.session_id) as EditRow[];

      const sessionMeta = db
        .prepare(
          `SELECT machine
           FROM sessions
           WHERE session_id = ?`,
        )
        .get(session.session_id) as { machine: string | null } | undefined;
      const repoMeta = db
        .prepare(
          `SELECT repository, git_user_name, branch
           FROM session_repositories
           WHERE session_id = ?
           ORDER BY first_seen_ms ASC
           LIMIT 1`,
        )
        .get(session.session_id) as
        | {
            repository: string | null;
            git_user_name: string | null;
            branch: string | null;
          }
        | undefined;
      const cwdMeta = db
        .prepare(
          `SELECT cwd
           FROM session_cwds
           WHERE session_id = ?
           ORDER BY first_seen_ms ASC
           LIMIT 1`,
        )
        .get(session.session_id) as { cwd: string | null } | undefined;

      const firstIntentTs = minTs(intents.map((intent) => intent.prompt_ts_ms));
      const lastIntentTs = maxTs(
        intents.map(
          (intent) => intent.next_prompt_ts_ms ?? intent.prompt_ts_ms,
        ),
      );
      const landedEditCount = edits.filter((edit) => edit.landed === 1).length;
      const openEditCount = edits.filter((edit) => edit.landed === null).length;
      const status =
        openEditCount > 0
          ? STATUS_ACTIVE
          : edits.length === 0 || landedEditCount === 0
            ? STATUS_ABANDONED
            : landedEditCount === edits.length
              ? STATUS_LANDED
              : STATUS_MIXED;
      const reconciledAtMs = maxTs(
        intents.map((intent) => intent.next_prompt_ts_ms).filter(Boolean),
      );
      const repository =
        repoMeta?.repository ??
        intents.map((intent) => intent.repository).find(Boolean) ??
        null;
      const cwd =
        cwdMeta?.cwd ??
        intents.map((intent) => intent.cwd).find(Boolean) ??
        null;
      const title = buildTitle(intents[0]?.prompt_text ?? "");

      sessionSummaryStmt.run(
        sessionSummaryKey(session.session_id),
        repository,
        cwd,
        repoMeta?.branch ?? null,
        null,
        repoMeta?.git_user_name ?? null,
        sessionMeta?.machine ?? "local",
        ORIGIN_SCOPE,
        title,
        status,
        firstIntentTs,
        lastIntentTs,
        intents.length,
        edits.length,
        landedEditCount,
        openEditCount,
        reconciledAtMs,
        JSON.stringify({ strategy: "session_id" }),
      );
      const sessionSummaryRow = db
        .prepare(`SELECT last_insert_rowid() AS id`)
        .get() as { id: number };
      sessionSummaries += 1;

      for (const intent of intents) {
        membershipStmt.run(
          intent.intent_unit_id,
          sessionSummaryRow.id,
          "primary",
          MEMBERSHIP_SOURCE,
          1,
          JSON.stringify({ strategy: "session_id" }),
        );
        memberships += 1;
      }

      const fileCache = new Map<string, FileSnapshot | null>();
      for (const edit of edits) {
        const snapshot = readFileSnapshot(edit.file_path, fileCache);
        if (!snapshot && edit.landed !== 0) continue;

        const snippet = cleanSnippet(edit.new_string_snippet);
        let bindingLevel: "file" | "span" = "file";
        let startLine: number | null = null;
        let endLine: number | null = null;
        let statusValue: "current" | "ambiguous" | "stale";
        let confidence = edit.landed === 1 ? 0.72 : 0.45;

        if (edit.landed === 0) {
          statusValue = "stale";
          confidence = 0.2;
        } else if (
          snapshot &&
          snippet &&
          snippet.length >= MIN_SPAN_SNIPPET_LEN
        ) {
          const matches = findMatches(snapshot.text, snippet, 2);
          if (matches.length === 1) {
            bindingLevel = "span";
            startLine = lineNumberAt(snapshot.text, matches[0].startIndex);
            endLine = startLine + countNewlines(snippet);
            statusValue = "current";
            confidence = edit.landed === 1 ? 0.95 : 0.82;
          } else if (matches.length > 1) {
            statusValue = "ambiguous";
            confidence = edit.landed === 1 ? 0.55 : 0.4;
          } else {
            statusValue = edit.landed === 1 ? "current" : "ambiguous";
          }
        } else {
          statusValue = edit.landed === null ? "ambiguous" : "current";
        }

        provenanceStmt.run(
          repository ?? "",
          edit.file_path,
          bindingLevel,
          startLine,
          endLine,
          edit.new_string_hash ?? null,
          snippet ?? null,
          inferLanguage(edit.file_path),
          null,
          null,
          repoMeta?.git_user_name ?? null,
          sessionMeta?.machine ?? "local",
          ORIGIN_SCOPE,
          edit.intent_unit_id,
          edit.intent_edit_id,
          sessionSummaryRow.id,
          statusValue,
          confidence,
          snapshot?.hash ?? null,
          edit.timestamp_ms ?? firstIntentTs ?? Date.now(),
          Date.now(),
        );
        provenance += 1;
      }
    }

    return { sessionSummaries, memberships, provenance };
  });

  return tx();
}

export function sessionSummaryKey(sessionId: string): string {
  return `ss:local:${sessionId}`;
}

function minTs(values: Array<number | null | undefined>): number | null {
  const present = values.filter(
    (value): value is number => typeof value === "number",
  );
  return present.length > 0 ? Math.min(...present) : null;
}

function maxTs(values: Array<number | null | undefined>): number | null {
  const present = values.filter(
    (value): value is number => typeof value === "number",
  );
  return present.length > 0 ? Math.max(...present) : null;
}

function buildTitle(promptText: string): string {
  const compact = promptText.replace(/\s+/g, " ").trim();
  if (!compact) return "untitled session summary";
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function readFileSnapshot(
  filePath: string,
  cache: Map<string, FileSnapshot | null>,
): FileSnapshot | null {
  if (cache.has(filePath)) return cache.get(filePath) ?? null;
  if (!filePath || !canUseLocalPathApis(filePath) || !fs.existsSync(filePath)) {
    cache.set(filePath, null);
    return null;
  }
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    const hash = createHash("sha256").update(text).digest("hex");
    const snapshot = { text, hash };
    cache.set(filePath, snapshot);
    return snapshot;
  } catch {
    cache.set(filePath, null);
    return null;
  }
}

function cleanSnippet(snippet: string | null): string | null {
  if (!snippet) return null;
  const trimmed = snippet.replace(/\r\n/g, "\n").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function findMatches(
  haystack: string,
  needle: string,
  limit: number,
): Array<{ startIndex: number }> {
  const matches: Array<{ startIndex: number }> = [];
  let from = 0;
  while (matches.length < limit) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    matches.push({ startIndex: index });
    from = index + Math.max(needle.length, 1);
  }
  return matches;
}

function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

function inferLanguage(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "rb":
      return "ruby";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    case "kt":
      return "kotlin";
    case "swift":
      return "swift";
    case "sh":
      return "shell";
    case "md":
      return "markdown";
    case "json":
      return "json";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return ext ?? null;
  }
}
