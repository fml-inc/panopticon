import { createHash } from "node:crypto";
import fs from "node:fs";
import { clearAttemptBackoff } from "../attempt-backoff.js";
import { config } from "../config.js";
import { getDb, markSessionSummaryProjectionComplete } from "../db/schema.js";
import { canUseLocalPathApis } from "../paths.js";
import { SUMMARY_ROW_BACKOFF_SCOPE } from "./backoff.js";
import {
  buildDeterministicSessionSummaryDocs,
  mergeSessionSummaryEnrichment,
  type SessionSummaryEnrichmentRow,
  shouldResetSessionSummaryRetryState,
} from "./model.js";
import { getSessionSummaryRunnerPolicy } from "./policy.js";
import {
  SESSION_SUMMARY_SEARCH_CORPUS,
  SESSION_SUMMARY_SEARCH_PRIORITY,
} from "./search-index.js";
import {
  loadSessionSummaryEditRows,
  loadSessionSummaryIntentRows,
  type SessionSummaryEditRow,
  summarizeFiles,
  summarizeTools,
} from "./session-data.js";

const MEMBERSHIP_SOURCE = "heuristic";
const ORIGIN_SCOPE = "local";
const STATUS_ACTIVE = "active";
const STATUS_LANDED = "landed";
const STATUS_MIXED = "mixed";
const STATUS_READ_ONLY = "read-only";
const STATUS_UNLANDED = "unlanded";
const MIN_SPAN_SNIPPET_LEN = 8;

interface FileSnapshot {
  text: string;
  hash: string;
}

interface ExistingSessionSummaryProjection {
  id: number;
  session_summary_key: string;
  session_id: string;
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: string | null;
  actor: string | null;
  machine: string;
  origin_scope: string;
  title: string;
  status: string;
  first_intent_ts_ms: number | null;
  last_intent_ts_ms: number | null;
  intent_count: number;
  edit_count: number;
  landed_edit_count: number;
  open_edit_count: number;
  summary_text: string | null;
  projection_hash: string | null;
  projected_at_ms: number | null;
  source_last_seen_at_ms: number | null;
  reason_json: string | null;
}

interface SessionSummaryProjectionValues {
  session_summary_key: string;
  session_id: string;
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: string | null;
  actor: string | null;
  machine: string;
  origin_scope: string;
  title: string;
  status: string;
  first_intent_ts_ms: number | null;
  last_intent_ts_ms: number | null;
  intent_count: number;
  edit_count: number;
  landed_edit_count: number;
  open_edit_count: number;
  summary_text: string | null;
  projection_hash: string;
  projected_at_ms: number;
  source_last_seen_at_ms: number | null;
  reason_json: string | null;
}

export function rebuildSessionSummaryProjections(opts?: {
  sessionId?: string;
  debounce?: boolean;
  nowMs?: number;
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
  const runnerPolicy = getSessionSummaryRunnerPolicy();
  const tx = db.transaction(() => {
    const existingSummaryByKey = new Map<
      string,
      ExistingSessionSummaryProjection
    >();
    if (opts?.sessionId) {
      const key = sessionSummaryKey(opts.sessionId);
      const row = db
        .prepare(
          `SELECT id,
                  session_summary_key,
                  session_id,
                  repository,
                  cwd,
                  branch,
                  worktree,
                  actor,
                  machine,
                  origin_scope,
                  title,
                  status,
                  first_intent_ts_ms,
                  last_intent_ts_ms,
                  intent_count,
                  edit_count,
                  landed_edit_count,
                  open_edit_count,
                  summary_text,
                  projection_hash,
                  projected_at_ms,
                  source_last_seen_at_ms,
                  reason_json
           FROM session_summaries
           WHERE session_summary_key = ?`,
        )
        .get(key) as ExistingSessionSummaryProjection | undefined;
      if (row) {
        existingSummaryByKey.set(key, row);
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
      db.prepare(`DELETE FROM session_summary_search_index`).run();
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
       (session_summary_key, session_id, repository, cwd, branch, worktree,
       actor, machine, origin_scope, title, status, first_intent_ts_ms,
       last_intent_ts_ms, intent_count, edit_count, landed_edit_count,
        open_edit_count, summary_text, projection_hash,
        projected_at_ms, source_last_seen_at_ms, reason_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const membershipStmt = db.prepare(
      `INSERT INTO intent_session_summaries
       (intent_unit_id, session_summary_id, membership_kind, source, score, reason_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const existingEnrichmentStmt = db.prepare(
      `SELECT session_summary_key,
              session_id,
              summary_text,
              summary_source,
              summary_runner,
              summary_model,
              summary_version,
              summary_generated_at_ms,
              projection_hash,
              summary_input_hash,
              summary_policy_hash,
              enriched_input_hash,
              enriched_message_count,
              dirty,
              dirty_reason_json,
              last_material_change_at_ms,
              last_attempted_at_ms,
              failure_count,
              last_error
       FROM session_summary_enrichments
       WHERE session_summary_key = ?`,
    );
    const deterministicSearchCorpusCountStmt = db.prepare(
      `SELECT COUNT(*) AS count
       FROM session_summary_search_index
       WHERE session_summary_key = ?
         AND corpus_key IN (?, ?)`,
    );
    const upsertEnrichmentStmt = db.prepare(
      `INSERT INTO session_summary_enrichments
       (session_summary_key, session_id, summary_text,
        summary_source, summary_runner, summary_model, summary_version,
        summary_generated_at_ms, projection_hash, summary_input_hash,
        summary_policy_hash, enriched_input_hash, enriched_message_count,
        dirty, dirty_reason_json, last_material_change_at_ms,
        last_attempted_at_ms, failure_count, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_summary_key) DO UPDATE SET
         session_id = excluded.session_id,
         summary_text = excluded.summary_text,
         summary_source = excluded.summary_source,
         summary_runner = excluded.summary_runner,
         summary_model = excluded.summary_model,
         summary_version = excluded.summary_version,
         summary_generated_at_ms = excluded.summary_generated_at_ms,
         projection_hash = excluded.projection_hash,
         summary_input_hash = excluded.summary_input_hash,
         summary_policy_hash = excluded.summary_policy_hash,
         enriched_input_hash = excluded.enriched_input_hash,
         enriched_message_count = excluded.enriched_message_count,
         dirty = excluded.dirty,
         dirty_reason_json = excluded.dirty_reason_json,
         last_material_change_at_ms = excluded.last_material_change_at_ms,
         last_attempted_at_ms = excluded.last_attempted_at_ms,
         failure_count = excluded.failure_count,
         last_error = excluded.last_error`,
    );
    const upsertSearchIndexStmt = db.prepare(
      `INSERT INTO session_summary_search_index
       (session_summary_key, session_id, corpus_key, source, priority,
        search_text, dirty, projection_hash, enriched_input_hash, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_summary_key, corpus_key) DO UPDATE SET
         session_id = excluded.session_id,
         source = excluded.source,
         priority = excluded.priority,
         search_text = excluded.search_text,
         dirty = excluded.dirty,
         projection_hash = excluded.projection_hash,
         enriched_input_hash = excluded.enriched_input_hash,
         updated_at_ms = excluded.updated_at_ms`,
    );
    const deleteSearchIndexCorpusStmt = db.prepare(
      `DELETE FROM session_summary_search_index
       WHERE session_summary_key = ?
         AND corpus_key IN (?, ?)`,
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
      const intents = loadSessionSummaryIntentRows(session.session_id);
      if (intents.length === 0) continue;

      const edits = loadSessionSummaryEditRows(session.session_id);

      const sessionMeta = db
        .prepare(
          `SELECT machine,
                  target,
                  project,
                  cwd,
                  first_prompt,
                  started_at_ms,
                  ended_at_ms,
                  message_count
           FROM sessions
           WHERE session_id = ?`,
        )
        .get(session.session_id) as
        | {
            machine: string | null;
            target: string | null;
            project: string | null;
            cwd: string | null;
            first_prompt: string | null;
            started_at_ms: number | null;
            ended_at_ms: number | null;
            message_count: number | null;
          }
        | undefined;
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
          : edits.length === 0
            ? STATUS_READ_ONLY
            : landedEditCount === 0
              ? STATUS_UNLANDED
              : landedEditCount === edits.length
                ? STATUS_LANDED
                : STATUS_MIXED;
      const repository =
        repoMeta?.repository ??
        intents.map((intent) => intent.repository).find(Boolean) ??
        null;
      const cwd =
        cwdMeta?.cwd ??
        sessionMeta?.cwd ??
        intents.map((intent) => intent.cwd).find(Boolean) ??
        null;
      const title = buildTitle(intents[0]?.prompt_text ?? "");
      if (
        isInternalSummarySession({
          cwd,
          project: sessionMeta?.project ?? null,
          promptText: intents[0]?.prompt_text ?? sessionMeta?.first_prompt,
          title,
        })
      ) {
        continue;
      }
      const summaryKey = sessionSummaryKey(session.session_id);
      const files = summarizeFiles(edits);
      const tools = summarizeTools(edits);
      const nowMs = opts?.nowMs ?? Date.now();
      const lastActivityMs = maxTs([
        sessionMeta?.started_at_ms,
        sessionMeta?.ended_at_ms,
        firstIntentTs,
        lastIntentTs,
        ...edits.map((edit) => edit.timestamp_ms),
      ]);
      const docs = buildDeterministicSessionSummaryDocs({
        sessionSummaryKey: summaryKey,
        sessionId: session.session_id,
        title,
        status,
        repository,
        cwd,
        branch: repoMeta?.branch ?? null,
        intentCount: intents.length,
        editCount: edits.length,
        landedEditCount,
        openEditCount,
        messageCount: sessionMeta?.message_count ?? 0,
        lastActivityMs,
        intents: intents.map((intent) => intent.prompt_text),
        files,
        tools,
      });

      const existingSummary = existingSummaryByKey.get(summaryKey) ?? null;
      const existingEnrichment =
        (existingEnrichmentStmt.get(summaryKey) as
          | SessionSummaryEnrichmentRow
          | undefined) ?? null;
      const deterministicCorpusCount = (
        deterministicSearchCorpusCountStmt.get(
          summaryKey,
          SESSION_SUMMARY_SEARCH_CORPUS.deterministicSummary,
          SESSION_SUMMARY_SEARCH_CORPUS.deterministicSearch,
        ) as { count: number }
      ).count;
      const deferDeterministicProjection = shouldDeferDeterministicProjection({
        debounce: opts?.debounce === true,
        existingSummary,
        existingEnrichment,
        deterministicCorpusCount,
        nextProjectionHash: docs.projectionHash,
        nowMs,
      });
      const currentProjectionValues: SessionSummaryProjectionValues = {
        session_summary_key: summaryKey,
        session_id: session.session_id,
        repository,
        cwd,
        branch: repoMeta?.branch ?? null,
        worktree: null,
        actor: repoMeta?.git_user_name ?? null,
        machine: sessionMeta?.machine ?? "local",
        origin_scope: ORIGIN_SCOPE,
        title,
        status,
        first_intent_ts_ms: firstIntentTs,
        last_intent_ts_ms: lastIntentTs,
        intent_count: intents.length,
        edit_count: edits.length,
        landed_edit_count: landedEditCount,
        open_edit_count: openEditCount,
        summary_text: docs.summaryText,
        projection_hash: docs.projectionHash,
        projected_at_ms: nowMs,
        source_last_seen_at_ms: lastActivityMs,
        reason_json: JSON.stringify({ strategy: "session_id" }),
      };
      const projectionValues =
        deferDeterministicProjection && existingSummary
          ? existingSummaryProjectionValues(existingSummary)
          : currentProjectionValues;

      sessionSummaryStmt.run(
        projectionValues.session_summary_key,
        projectionValues.session_id,
        projectionValues.repository,
        projectionValues.cwd,
        projectionValues.branch,
        projectionValues.worktree,
        projectionValues.actor,
        projectionValues.machine,
        projectionValues.origin_scope,
        projectionValues.title,
        projectionValues.status,
        projectionValues.first_intent_ts_ms,
        projectionValues.last_intent_ts_ms,
        projectionValues.intent_count,
        projectionValues.edit_count,
        projectionValues.landed_edit_count,
        projectionValues.open_edit_count,
        projectionValues.summary_text,
        projectionValues.projection_hash,
        projectionValues.projected_at_ms,
        projectionValues.source_last_seen_at_ms,
        projectionValues.reason_json,
      );
      const sessionSummaryRow = db
        .prepare(`SELECT last_insert_rowid() AS id`)
        .get() as { id: number };
      sessionSummaries += 1;

      if (deferDeterministicProjection) {
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
        provenance += rebuildCodeProvenance({
          provenanceStmt,
          sessionSummaryId: sessionSummaryRow.id,
          edits,
          repository,
          actor: repoMeta?.git_user_name ?? null,
          machine: sessionMeta?.machine ?? "local",
          firstIntentTs,
          fileCache: new Map<string, FileSnapshot | null>(),
        });
        continue;
      }

      const mergedEnrichment = mergeSessionSummaryEnrichment(
        existingEnrichment,
        {
          sessionSummaryKey: summaryKey,
          sessionId: session.session_id,
          title,
          status,
          repository,
          cwd,
          branch: repoMeta?.branch ?? null,
          intentCount: intents.length,
          editCount: edits.length,
          landedEditCount,
          openEditCount,
          messageCount: sessionMeta?.message_count ?? 0,
          lastActivityMs,
          intents: intents.map((intent) => intent.prompt_text),
          files,
          tools,
        },
        runnerPolicy.policyHash,
        nowMs,
      );
      if (
        shouldResetSessionSummaryRetryState(
          existingEnrichment,
          { summaryInputHash: docs.summaryInputHash },
          runnerPolicy.policyHash,
        )
      ) {
        clearAttemptBackoff(SUMMARY_ROW_BACKOFF_SCOPE, summaryKey);
      }
      upsertEnrichmentStmt.run(
        mergedEnrichment.session_summary_key,
        mergedEnrichment.session_id,
        mergedEnrichment.summary_text,
        mergedEnrichment.summary_source,
        mergedEnrichment.summary_runner,
        mergedEnrichment.summary_model,
        mergedEnrichment.summary_version,
        mergedEnrichment.summary_generated_at_ms,
        mergedEnrichment.projection_hash,
        mergedEnrichment.summary_input_hash,
        mergedEnrichment.summary_policy_hash,
        mergedEnrichment.enriched_input_hash,
        mergedEnrichment.enriched_message_count,
        mergedEnrichment.dirty,
        mergedEnrichment.dirty_reason_json,
        mergedEnrichment.last_material_change_at_ms,
        mergedEnrichment.last_attempted_at_ms,
        mergedEnrichment.failure_count,
        mergedEnrichment.last_error,
      );
      for (const row of docs.searchCorpusRows) {
        upsertSearchIndexStmt.run(
          mergedEnrichment.session_summary_key,
          mergedEnrichment.session_id,
          row.corpusKey,
          row.source,
          row.priority,
          row.searchText,
          0,
          mergedEnrichment.projection_hash,
          null,
          nowMs,
        );
      }
      if (
        mergedEnrichment.summary_source === "llm" &&
        mergedEnrichment.summary_text
      ) {
        upsertSearchIndexStmt.run(
          mergedEnrichment.session_summary_key,
          mergedEnrichment.session_id,
          SESSION_SUMMARY_SEARCH_CORPUS.llmSummary,
          "llm",
          SESSION_SUMMARY_SEARCH_PRIORITY.llmSummary,
          mergedEnrichment.summary_text,
          mergedEnrichment.dirty,
          mergedEnrichment.projection_hash,
          mergedEnrichment.enriched_input_hash,
          nowMs,
        );
        upsertSearchIndexStmt.run(
          mergedEnrichment.session_summary_key,
          mergedEnrichment.session_id,
          SESSION_SUMMARY_SEARCH_CORPUS.llmSearch,
          "llm",
          SESSION_SUMMARY_SEARCH_PRIORITY.llmSearch,
          mergedEnrichment.summary_text,
          mergedEnrichment.dirty,
          mergedEnrichment.projection_hash,
          mergedEnrichment.enriched_input_hash,
          nowMs,
        );
      } else {
        deleteSearchIndexCorpusStmt.run(
          mergedEnrichment.session_summary_key,
          SESSION_SUMMARY_SEARCH_CORPUS.llmSummary,
          SESSION_SUMMARY_SEARCH_CORPUS.llmSearch,
        );
      }

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

      provenance += rebuildCodeProvenance({
        provenanceStmt,
        sessionSummaryId: sessionSummaryRow.id,
        edits,
        repository,
        actor: repoMeta?.git_user_name ?? null,
        machine: sessionMeta?.machine ?? "local",
        firstIntentTs,
        fileCache: new Map<string, FileSnapshot | null>(),
      });
    }

    if (opts?.sessionId) {
      const key = sessionSummaryKey(opts.sessionId);
      const stillExists = db
        .prepare(
          `SELECT 1
           FROM session_summaries
           WHERE session_summary_key = ?`,
        )
        .get(key);
      if (!stillExists) {
        db.prepare(
          `DELETE FROM session_summary_enrichments
           WHERE session_summary_key = ?`,
        ).run(key);
        db.prepare(
          `DELETE FROM session_summary_search_index
           WHERE session_summary_key = ?`,
        ).run(key);
      }
    } else {
      db.prepare(
        `DELETE FROM session_summary_enrichments
         WHERE session_summary_key NOT IN (
           SELECT session_summary_key FROM session_summaries
         )`,
      ).run();
      db.prepare(
        `DELETE FROM session_summary_search_index
         WHERE session_summary_key NOT IN (
           SELECT session_summary_key FROM session_summaries
         )`,
      ).run();
    }

    return { sessionSummaries, memberships, provenance };
  });

  const result = tx();
  if (!opts?.sessionId) {
    markSessionSummaryProjectionComplete();
  }
  return result;
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

function isInternalSummarySession(input: {
  cwd: string | null;
  project: string | null;
  promptText: string | null;
  title: string;
}): boolean {
  const project = input.project?.trim().toLowerCase() ?? "";
  if (project === "claude-headless" || project === "codex-headless") {
    return true;
  }
  if (isPanopticonHeadlessCwd(input.cwd)) return true;
  return (
    isInternalSummaryPrompt(input.promptText) ||
    isInternalSummaryPrompt(input.title)
  );
}

function isPanopticonHeadlessCwd(cwd: string | null): boolean {
  const normalized = cwd?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
  return (
    normalized.endsWith("/panopticon/claude-headless") ||
    normalized.endsWith("/panopticon/codex-headless")
  );
}

function isInternalSummaryPrompt(value: string | null): boolean {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  const normalized = text.startsWith("Title: ") ? text.slice(7).trim() : text;
  return (
    normalized.startsWith("Summarize this coding session segment ") ||
    normalized.startsWith("Combine these 5 session phase summaries ") ||
    (normalized.startsWith("Summarize session ") &&
      normalized.includes(
        ". Start by calling the timeline tool with sessionId ",
      ))
  );
}

function existingSummaryProjectionValues(
  existing: ExistingSessionSummaryProjection,
): SessionSummaryProjectionValues {
  return {
    session_summary_key: existing.session_summary_key,
    session_id: existing.session_id,
    repository: existing.repository,
    cwd: existing.cwd,
    branch: existing.branch,
    worktree: existing.worktree,
    actor: existing.actor,
    machine: existing.machine,
    origin_scope: existing.origin_scope,
    title: existing.title,
    status: existing.status,
    first_intent_ts_ms: existing.first_intent_ts_ms,
    last_intent_ts_ms: existing.last_intent_ts_ms,
    intent_count: existing.intent_count,
    edit_count: existing.edit_count,
    landed_edit_count: existing.landed_edit_count,
    open_edit_count: existing.open_edit_count,
    summary_text: existing.summary_text,
    projection_hash: existing.projection_hash ?? "",
    projected_at_ms: existing.projected_at_ms ?? Date.now(),
    source_last_seen_at_ms: existing.source_last_seen_at_ms,
    reason_json: existing.reason_json,
  };
}

function shouldDeferDeterministicProjection(input: {
  debounce: boolean;
  existingSummary: ExistingSessionSummaryProjection | null;
  existingEnrichment: SessionSummaryEnrichmentRow | null;
  deterministicCorpusCount: number;
  nextProjectionHash: string;
  nowMs: number;
}): boolean {
  if (!input.debounce) return false;
  if (!input.existingSummary || !input.existingEnrichment) return false;
  if (!input.existingSummary.summary_text) return false;
  if (!input.existingSummary.projection_hash) return false;
  if (!input.existingSummary.projected_at_ms) return false;
  if (input.deterministicCorpusCount < 2) return false;
  if (input.existingSummary.projection_hash === input.nextProjectionHash) {
    return true;
  }

  const debounceMs = config.sessionSummaryProjectionDebounceMs ?? 30_000;
  return input.nowMs - input.existingSummary.projected_at_ms < debounceMs;
}

function rebuildCodeProvenance(opts: {
  provenanceStmt: { run: (...params: unknown[]) => unknown };
  sessionSummaryId: number;
  edits: SessionSummaryEditRow[];
  repository: string | null;
  actor: string | null;
  machine: string;
  firstIntentTs: number | null;
  fileCache: Map<string, FileSnapshot | null>;
}): number {
  let provenance = 0;
  for (const edit of opts.edits) {
    const snapshot = readFileSnapshot(edit.file_path, opts.fileCache);
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
    } else if (snapshot && snippet && snippet.length >= MIN_SPAN_SNIPPET_LEN) {
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

    opts.provenanceStmt.run(
      opts.repository ?? "",
      edit.file_path,
      bindingLevel,
      startLine,
      endLine,
      edit.new_string_hash ?? null,
      snippet ?? null,
      inferLanguage(edit.file_path),
      null,
      null,
      opts.actor,
      opts.machine,
      ORIGIN_SCOPE,
      edit.intent_unit_id,
      edit.intent_edit_id,
      opts.sessionSummaryId,
      statusValue,
      confidence,
      snapshot?.hash ?? null,
      edit.timestamp_ms ?? opts.firstIntentTs ?? Date.now(),
      Date.now(),
    );
    provenance += 1;
  }
  return provenance;
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
